// 引擎层 —— 世界流主循环
// 
// 分层设计（每层 AI 输出链入下一层）：
//   Step 1: 大事件检查（0 token）
//   Step 2: 世界 AI 叙事（1 次 API）→ 产出世界叙事
//   Step 3: 信息派发（0 token）→ 叙事摘要注入每个 NPC 的 pending_events
//   Step 4: 个人行动 AI（N 次 API，并发）→ 每个 NPC 输出行动方案
//   Step 5a: 外交编排 AI（1 次 API）→ 接收行动方案 + 互动意图，编排 NPC 互动
//   Step 5b: 状态编排 AI（1 次 API）→ 接收外交结果 + 行动方案，决定状态变化
//   Step 6: 认知同步（0 token）
//   Step 7: CRUD 执行 + 记忆压缩 + 目的消解 + 世界线更正 + 时间推进
//   Step 8: NPC 状态同步（0 token）→ 将世界流变化同步到各 NPC 的实时状态

import type { WorldState, WorldCardConfig, GameTime, EventSummary } from './types';
import { loadAllCharacters, loadWorldState, saveWorldState, saveAllCharacters, saveWorldFlowRecord, beginBatch, endBatch, loadAllFactions, saveFaction, getAllWorldFlowRecords } from './db';
import { advanceWorldFlowStep } from './time';
import { worldAI, setCurrentFlowNumber } from './agent';
import { buildWorldNarrativePrompt } from '../transform/prompt';
import { getLocName, sortByGameTime, PLAYER_CONV_MEMORY_MAX, formatKLevel, formatPLevel } from './config';
import { broadcastEvent, syncCognition, checkFactionRelationSwitch } from './relations';
import { diplomacyAIOrchestration } from '../transform/diplomacyAI';
import { stateOrchestrationAI } from '../transform/stateAI';
import { personalActionAI } from '../transform/personalActionAI';
import type { PersonalActionResult } from '../transform/personalActionAI';
import { checkDriveSwitch, updateDriveProgress } from './drive';
import { processShortTermBuffer, compressPlayerConversations } from './memory';
import { worldLineCorrection } from './worldResource';
import { addResource, setAgentState } from './crud';
import { getUnprocessedActions, markAllProcessed, clearAllActions } from './playerLog';
import { summarizePlayerActions } from '../transform/playerSummaryAI';

let flowCounter = 0;
let _flowCounterInitialized = false;
let _eventIdCounter = 0; // 替代 Date.now() 避免同毫秒重复 ID

function nextEventId(prefix: string = 'ev'): string {
  return `${prefix}_${++_eventIdCounter}_${Date.now().toString(36)}`;
}

async function initFlowCounter() {
  if (_flowCounterInitialized) return;
  const records = await getAllWorldFlowRecords();
  if (records.length > 0) {
    const maxNum = Math.max(...records.map(r => r.flow_number));
    flowCounter = maxNum + 1;
  } else {
    flowCounter = 1;
  }
  _flowCounterInitialized = true;
}

// ── 执行单个 NPC 的个人行动 CRUD ──
async function executePersonalActionCrud(
  result: PersonalActionResult,
  ch: import('./types').CharacterInstance,
  time: GameTime,
  config: WorldCardConfig,
): Promise<string[]> {
  const logs: string[] = [];

  // 资源使用
  for (const use of result.resourceUses) {
    const resDef = config.resource_types.find(rt => rt.resource_type_id === use.resourceTypeId);
    const resName = resDef?.name || use.resourceTypeId;
    const existing = ch.inventory.find(i => i.resource_type_id === use.resourceTypeId);
    const available = existing?.quantity ?? 0;
    const actualUse = Math.min(use.amount, available);
    if (actualUse > 0) {
      await addResource(ch.character_id, use.resourceTypeId, -actualUse, time, `个人行动:${use.purpose}`);
      // 同步内存中的 inventory，防止后续 saveAllCharacters 覆盖 OPFS 变更
      if (existing) {
        existing.quantity -= actualUse;
        if (existing.quantity <= 0) {
          ch.inventory = ch.inventory.filter(i => i.resource_type_id !== use.resourceTypeId);
        }
      }
      logs.push(`[使用] ${ch.name}: ${resName}×${actualUse}（${use.purpose}）`);
    }
  }

  return logs;
}

export async function executeWorldFlow(
  worldState: WorldState, config: WorldCardConfig, skipAI: boolean = false,
  onProgress?: (step: string, lines: string[]) => void,
  isInitialFlow: boolean = false,
): Promise<{
  newWorldState: WorldState;
  reports: { character_id: string; name?: string; report: string }[];
  changeSummary: string[];
}> {
  const time = worldState.game_time;
  await initFlowCounter();
  setCurrentFlowNumber(flowCounter);
  beginBatch();  // 开启批量写入，减少 OPFS 刷写次数
  const stepLogs: string[] = [];

  const characters = await loadAllCharacters();

  // ═══════════════════════════════════════════════════════════
  //  Step 1: 玩家行动总结（初始化跳过）
  //  汇总玩家在两次世界流之间的所有操作，AI 叙事化摘要
  //  链入 Step 2（世界叙事）和 Step 3（信息派发）
  // ═══════════════════════════════════════════════════════════
  let playerActivitySummary = '';
  if (!isInitialFlow) {
    const player = characters.find(c => c.is_player);
    const unprocessedActions = getUnprocessedActions();
    if (unprocessedActions.length > 0 && player) {
      playerActivitySummary = await summarizePlayerActions(unprocessedActions, worldState, config, player.name);
      stepLogs.push(`[玩家行动] 总结 ${unprocessedActions.length} 条操作`);
      onProgress?.('Step 1/7 · 玩家行动总结', [
        `${unprocessedActions.length} 条操作 → AI 摘要`,
        playerActivitySummary.slice(0, 50) + '...',
      ]);
    } else {
      onProgress?.('Step 1/7 · 玩家行动总结', ['本轮无玩家操作']);
    }
  }

  // ═══════════════════════════════════════════════════════════
  //  Step 2: 世界 AI 叙事（1 次 API，2000+ 字，初始化跳过）
  // ═══════════════════════════════════════════════════════════
  let narrative: string | undefined;
  if (!skipAI && !isInitialFlow) {
    const charSummary = characters
      .filter(c => !c.is_player)
      .map(c => {
        const locName = config.locations.find(l => l.location_id === c.position.location_id)?.name || c.position.location_id;
        const driveStr = c.drives.slice(0, 3).map(d => `${d.description}(${Math.round(d.progress * 100)}%)`).join('；');
        const relSummary = c.relationships
          .filter(r => Math.abs(r.affinity) > 10)
          .map(r => {
            const target = characters.find(tc => tc.character_id === r.target_id);
            return `${target?.name || r.target_id}(${r.affinity > 0 ? '好感' : '敌意'}${Math.abs(r.affinity)})`;
          }).join('、');
        return `- ${c.name}（${c.identity.title}，${formatKLevel(c.identity.k_level, config.mapping.k_level_names)}，${formatPLevel(c.stats.p_level, config.mapping.p_level_names)}）在【${locName}】，目的：${driveStr || '日常'}${relSummary ? '，关系：' + relSummary : ''}`;
      }).join('\n');

    // 获取上次世界叙事
    const allRecords = await getAllWorldFlowRecords();
    const lastRecord = allRecords.length > 0 ? allRecords[allRecords.length - 1] : null;
    const previousNarrative = lastRecord?.narrative || '世界刚开始运行';

    const worldPrompt = buildWorldNarrativePrompt(worldState, config, previousNarrative, '', config.prompt_config.event_stage_mood || '自然推进世界发展', charSummary, playerActivitySummary);
    narrative = await worldAI(worldPrompt, worldState) || '世界在沉默中运转着...';

    onProgress?.('Step 2/7 · 世界叙事', [
      narrative ? 'AI 叙事已生成（2000+ 字）' : '已跳过',
      narrative ? narrative.slice(0, 60) + '...' : '',
    ]);
  }

  // ═══════════════════════════════════════════════════════════
  //  Step 3: 信息派发（0 token，初始化跳过）
  //  将世界叙事注入每个 NPC 的 pending_events
  // ═══════════════════════════════════════════════════════════
  if (!isInitialFlow) {
    const narrativeSnippet = narrative ? narrative.slice(0, 200) : '世界照常运转';

    for (const ch of characters) {
      const locName = config.locations.find(l => l.location_id === ch.position.location_id)?.name || ch.position.location_id;
      const parts = [narrativeSnippet];
      // 玩家行动摘要：同地点 NPC 和与玩家互动过的 NPC 收到更详细的消息
      if (playerActivitySummary) {
        const player = characters.find(c => c.is_player);
        const interactedTargets = getUnprocessedActions()
          .filter(a => a.targetName === ch.name)
          .map(a => a.summary);
        if (interactedTargets.length > 0) {
          // 与玩家互动过的 NPC 收到个性化消息
          parts.push(`玩家${player?.name || '冒险者'}近期与你互动：${interactedTargets.join('；')}`);
        } else if (ch.position.location_id === player?.position.location_id) {
          // 同地点 NPC 知道玩家在附近活动
          parts.push(`玩家${player?.name || '冒险者'}近期动向：${playerActivitySummary.slice(0, 80)}`);
        }
      }
      parts.push(`身在${locName}`);

      const personalizedEvent: EventSummary = {
        id: nextEventId('ev'),
        visibility: 'public',
        summary: parts.join(' | '),
        timestamp: time,
        location_id: ch.position.location_id,
        involved_characters: [ch.character_id],
      };

      const broadcasts = broadcastEvent(personalizedEvent, [ch]);
      for (const b of broadcasts) {
        ch.short_term_buffer.pending_events.push(b.event);
      }
    }

    onProgress?.('Step 3/7 · 信息派发', [
      characters.length + ' 个角色接收事件',
    ]);
  }

  // ═══════════════════════════════════════════════════════════
  //  Step 4: 个人行动 AI（N 次 API，并发）
  //  每个活跃 NPC 独立调用 AI 决定本轮行动方案
  //  输出链入 Step 5a（外交）和 Step 5b（状态）
  // ═══════════════════════════════════════════════════════════
  const personalActions = new Map<string, PersonalActionResult>();

  if (!isInitialFlow) {
    const activeChars = characters.filter(c => !c.is_player && c.agent_state !== 'dormant');

    if (activeChars.length > 0) {
      const results = await Promise.all(
        activeChars.map(ch =>
          personalActionAI(ch, worldState, config, characters, playerActivitySummary).catch(() => ({
            characterId: ch.character_id,
            characterName: ch.name,
            summary: `${ch.name}按部就班地度过。`,
            resourceUses: [] as { resourceTypeId: string; amount: number; purpose: string }[],
            interactionIntents: [] as { targetName: string; intent: string }[],
          }))
        )
      );

      for (const r of results) {
        personalActions.set(r.characterId, r);
        stepLogs.push(`[安排] ${r.characterName}: ${r.summary}${r.moveToLocation ? ' → ' + r.moveToLocation : ''}`);
      }
    }

    onProgress?.('Step 4/7 · 个人行动', [
      activeChars.length + ' 个角色 AI 决策完成（并发）',
    ]);
  }

  // ═══════════════════════════════════════════════════════════
  //  Step 5a: 外交编排 AI（1 次 API，初始化跳过）
  //  输入：所有 NPC 的个人行动方案 + 互动意图 + 角色档案
  //  输出：NPC 间的对话/交易/冲突/奖励
  // ═══════════════════════════════════════════════════════════
  let dipLogs: string[] = [];
  let stateLogs: string[] = [];
  let stateExecuted = 0;
  let factionChanges: { factionAId: string; factionBId: string; oldState: string; newState: string }[] = [];

  if (!isInitialFlow) {
    const npcs = characters.filter(c => !c.is_player);

    // 将个人行动结果传给外交 AI
    const actionSummaries = Array.from(personalActions.values())
      .map(a => `${a.characterName}: ${a.summary}${a.moveToLocation ? ' → 前往' + a.moveToLocation : ''}${a.resourceUses.length > 0 ? ' | 计划使用: ' + a.resourceUses.map(u => u.resourceTypeId + '×' + u.amount + (u.purpose ? '(' + u.purpose + ')' : '')).join('、') : ''}${a.interactionIntents.length > 0 ? ' | 想互动: ' + a.interactionIntents.map(i => i.targetName + '(' + i.intent + ')').join('、') : ''}`)
      .join('\n');

    dipLogs = await diplomacyAIOrchestration(characters, worldState, config.locations, config, personalActions, actionSummaries);
    stepLogs.push(...dipLogs);

    // 独行角色统计（外交内部已处理，此处仅统计显示）
    let soloCount = 0;
    const locGroups: Record<string, typeof characters> = {};
    for (const ch of npcs) {
      if (!locGroups[ch.position.location_id]) locGroups[ch.position.location_id] = [];
      locGroups[ch.position.location_id].push(ch);
    }
    for (const chars of Object.values(locGroups)) {
      if (chars.length === 1) soloCount++;
    }

    const groupCount = Object.values(locGroups).filter(g => g.length >= 2).length;
    onProgress?.('Step 5/7 · 外交编排', [
      `${groupCount}个地点分组 · ${dipLogs.length}条结果`,
      soloCount > 0 ? `${soloCount}个独行角色` : '',
    ]);

    const diplomacyOutput = dipLogs.join('\n');
    const stateResult = await stateOrchestrationAI(worldState, config, diplomacyOutput, characters, actionSummaries);
    stateLogs = stateResult.logs;
    stateExecuted = stateResult.executed;
    stepLogs.push(...stateResult.logs);

    // 5c: 势力关系随机漂移（8% 概率，纯逻辑）
    const allFactions = await loadAllFactions();
    factionChanges = checkFactionRelationSwitch(allFactions, []);
    if (factionChanges.length > 0) {
      for (const fc of factionChanges) {
        stepLogs.push(`[势力关系] ${fc.factionAId} ↔ ${fc.factionBId}: ${fc.oldState} → ${fc.newState}`);
        // 持久化势力关系变化
        const fa = allFactions.find(f => f.faction_id === fc.factionAId);
        const fb = allFactions.find(f => f.faction_id === fc.factionBId);
        if (fa) await saveFaction(fa);
        if (fb) await saveFaction(fb);
      }
    }

    onProgress?.('Step 5/7 · 状态编排', [stateResult.logs.length + ' 条状态变化', `实际执行${stateResult.executed}条`]);
  }

  // ═══════════════════════════════════════════════════════════
  //  Step 6: 认知同步（0 token，初始化跳过）
  // ═══════════════════════════════════════════════════════════
  if (!isInitialFlow) {
    // 6a: 外交编排结果 → 参与者事件
    let dipEventsDispatched = 0;
    for (const log of dipLogs) {
      const nameMatch = log.match(/\[(?:外交AI·)?(?:对话|交易|冲突|日程|奖励)\]\s*(\S+)(?:\s*→\s*(\S+))?/);
      if (!nameMatch) continue;
      const [, nameA, nameB] = nameMatch;
      if (nameB) {
        const chA = characters.find(c => c.name === nameA && !c.is_player);
        const chB = characters.find(c => c.name === nameB && !c.is_player);
        const summary = log.replace(/^\[[^\]]+\]\s*/, '');
        const involved = [chA?.character_id, chB?.character_id].filter((id): id is string => !!id);
        const eventA: EventSummary = {
        id: nextEventId('sync'),
          visibility: 'private',
          summary: `外交结果: ${summary}`,
          timestamp: time,
          location_id: chA?.position.location_id || 'global',
          involved_characters: involved,
        };
        const eventB = { ...eventA, id: eventA.id + '_b' };
        if (chA) { chA.short_term_buffer.pending_events.push(eventA); dipEventsDispatched++; }
        if (chB) { chB.short_term_buffer.pending_events.push(eventB); dipEventsDispatched++; }
      } else {
        const ch = characters.find(c => c.name === nameA && !c.is_player);
        if (ch) {
          ch.short_term_buffer.pending_events.push({
            id: `sync_${Date.now()}_${nameA}`,
            visibility: 'private',
            summary: `个人日程: ${log.replace(/^\[日程\]\s*/, '')}`,
            timestamp: time,
            location_id: ch.position.location_id,
            involved_characters: [ch.character_id],
          });
          dipEventsDispatched++;
        }
      }
    }

    // 6b: 状态编排结果 → 受影响角色事件
    let stateEventsDispatched = 0;
    for (const log of stateLogs) {
      const nameMatch = log.match(/\[(?:获得|消耗|状态|关系|目的|状态·移动)\]\s*(\S+)/);
      if (!nameMatch) continue;
      const charName = nameMatch[1];
      const ch = characters.find(c => c.name === charName && !c.is_player);
      if (ch) {
        ch.short_term_buffer.pending_events.push({
        id: nextEventId('state'),
          visibility: 'private',
          summary: `状态变化: ${log.replace(/^\[状态(?:·移动)?\]\s*/, '').slice(0, 80)}`,
          timestamp: time,
          location_id: ch.position.location_id,
          involved_characters: [ch.character_id],
        });
        stateEventsDispatched++;
      }
    }

    // 6c: 势力关系变化广播
    if (factionChanges.length > 0) {
      for (const fc of factionChanges) {
        const membersA = characters.filter(c => c.identity.faction_id === fc.factionAId && !c.is_player);
        const membersB = characters.filter(c => c.identity.faction_id === fc.factionBId && !c.is_player);
        for (const m of [...membersA, ...membersB]) {
          m.short_term_buffer.pending_events.push({
            id: nextEventId('faction'),
            visibility: 'private',
            summary: `势力关系变化: ${fc.factionAId}↔${fc.factionBId}: ${fc.oldState} → ${fc.newState}`,
            timestamp: time,
            location_id: m.position.location_id,
            involved_characters: [m.character_id],
          });
        }
      }
    }

    stepLogs.push(`[认知同步] 外交事件派发 ${dipEventsDispatched} 条, 状态事件 ${stateEventsDispatched} 条`);

    // 6d: 位置认知同步
    const locationGroups: Record<string, typeof characters> = {};
    for (const ch of characters) {
      if (!locationGroups[ch.position.location_id]) locationGroups[ch.position.location_id] = [];
      locationGroups[ch.position.location_id].push(ch);
    }
    for (const [, chars] of Object.entries(locationGroups)) {
      await syncCognition(chars, time, config);
    }

    onProgress?.('Step 6/7 · 认知同步', [
      `外交事件${dipEventsDispatched}条 + 状态事件${stateEventsDispatched}条`,
      '位置认知同步完成',
    ]);
  }

  // ═══════════════════════════════════════════════════════════
  //  Step 7: CRUD 执行 + 记忆压缩 + 目的消解 + 世界线更正 + 时间推进
  //  初始化时只生成初始方向，不生成报告
  // ═══════════════════════════════════════════════════════════
  if (isInitialFlow) {
    onProgress?.('Step 7/7 · 初始方向', ['世界已初始化']);

    await saveAllCharacters(characters);
    await endBatch();

    flowCounter++;
    setCurrentFlowNumber(undefined);
    return {
      newWorldState: { ...worldState },
      reports: [],
      changeSummary: stepLogs,
    };
  }

  // ── 7a: 执行个人行动 CRUD（并发，每个角色独立处理）──
  const crudPromises = characters
    .filter(ch => !ch.is_player && ch.agent_state !== 'dormant')
    .map(async (ch) => {
      const pa = personalActions.get(ch.character_id);
      if (pa) {
        return executePersonalActionCrud(pa, ch, time, config);
      }
      return [] as string[];
    });
  const crudLogsAll = await Promise.all(crudPromises);
  for (const logs of crudLogsAll) {
    stepLogs.push(...logs);
  }

  // ── 7a.5: 玩家对话记忆压缩（独立于普通记忆，保留更多细节） ──
  const player = characters.find(c => c.is_player);
  const playerId = player?.character_id;
  if (playerId) {
    for (const ch of characters) {
      if (ch.is_player || ch.agent_state === 'dormant') continue;
      const pcmEntries = await compressPlayerConversations(ch, playerId, time);
      ch.player_conversation_memory.push(...pcmEntries);
      // 限制最多 20 条玩家对话记忆（超出删除最旧的）
      if (ch.player_conversation_memory.length > PLAYER_CONV_MEMORY_MAX) {
        const sorted = ch.player_conversation_memory.sort((a, b) => sortByGameTime(a.timestamp, b.timestamp));
        ch.player_conversation_memory = sorted.slice(-PLAYER_CONV_MEMORY_MAX);
      }
      if (pcmEntries.length > 0) {
        stepLogs.push(`[玩家记忆] ${ch.name} 压缩了 ${pcmEntries.length} 条玩家对话记忆`);
      }
    }
  }

  // ── 7b: 记忆压缩前：快照事件和状态（用于后续目的进度计算） ──
  const preMemSnapshots = new Map<string, {
    events: string[]; hp: number; power: number;
    personalActionSummary: string; movedToLocation: string | null;
    inventoryCount: number; inventoryTotalQty: number;
  }>();

  for (const ch of characters) {
    if (ch.is_player) continue;
    const pa = personalActions.get(ch.character_id);
    const oldLoc = ch.position.location_id;
    const movesLog = dipLogs.filter(l =>
      (l.startsWith('[移动]') || l.startsWith('[状态·移动]')) && l.includes(ch.name)
    );
    const movedTo = movesLog.length > 0 ? movesLog[movesLog.length - 1] : null;
    const newLoc = movedTo ? (movedTo.match(/→\s*(.+)$/)?.[1]?.trim() || null) : null;

    preMemSnapshots.set(ch.character_id, {
      events: ch.short_term_buffer.pending_events.map(e => e.summary),
      hp: ch.stats.hp,
      power: ch.stats.base_combat_power,
      personalActionSummary: pa?.summary || `${ch.name}按部就班地度过。`,
      movedToLocation: newLoc && newLoc !== oldLoc ? newLoc : null,
      inventoryCount: ch.inventory.length,
      inventoryTotalQty: ch.inventory.reduce((s, r) => s + r.quantity, 0),
    });
  }

  // ── 7b: 记忆压缩（并发） ──
  await Promise.all(
    characters
      .filter(c => !c.is_player)
      .map(ch => processShortTermBuffer(ch, time).catch(err => {
        console.error(`[记忆压缩] ${ch.name} 失败:`, err);
        return [];
      }))
  );

  // ── 7b.5: 目的进度自动推进（纯逻辑，基于本轮实际变化） ──
  for (const ch of characters) {
    if (ch.is_player || ch.agent_state === 'dormant') continue;
    const snap = preMemSnapshots.get(ch.character_id);
    if (!snap) continue;

    // 计算本轮变化量
    const hpChange = ch.stats.hp - snap.hp;
    const powerChange = ch.stats.base_combat_power - snap.power;

    // 从外交/状态日志提取关系变化
    const relationChanges: { target: string; delta: number }[] = [];
    for (const log of [...dipLogs, ...stateLogs]) {
      const relMatch = log.match(/好感\s*([+-]?\d+)/);
      if (relMatch && log.includes(ch.name)) {
        const otherChars = characters.filter(c => c.name !== ch.name && log.includes(c.name));
        for (const oc of otherChars) {
          relationChanges.push({ target: oc.name, delta: parseInt(relMatch[1]) });
        }
      }
    }

    // 从库存变化推断资源变化（简化：按总量差值做虚拟 resourceChanges）
    const nowQty = ch.inventory.reduce((s, r) => s + r.quantity, 0);
    const qtyDelta = nowQty - snap.inventoryTotalQty;
    const resourceChanges: { id: string; delta: number }[] =
      qtyDelta !== 0 ? [{ id: '合计', delta: qtyDelta }] : [];

    const driveLogs = updateDriveProgress(
      ch, snap.events, snap.personalActionSummary,
      resourceChanges, relationChanges,
      snap.movedToLocation, hpChange, powerChange,
      config,
    );
    if (driveLogs.length > 0) {
      stepLogs.push(...driveLogs);
    }
  }

  // ── 7c: 目的消解 ──
  for (const ch of characters) {
    if (ch.is_player) continue;
    const sameLocChars = characters.filter(c =>
      !c.is_player && c.character_id !== ch.character_id &&
      c.position.location_id === ch.position.location_id
    );
    const nearbyNames = sameLocChars.map(c => `${c.name}(${c.drives[0]?.description || '无目的'})`).join('、') || '无';
    const dc = await checkDriveSwitch(ch, time, {
      nearbyNpcNames: nearbyNames,
      flowCount: worldState.flow_count,
      worldStage: worldState.event_stage,
    });
    if (dc.switched) {
      stepLogs.push(`[目的消解] ${ch.name}: ${dc.removed.join(', ') || '无移除'}${dc.added.length ? ' | ' + dc.added.join(', ') : ''}`);
    }
  }

  // ── 7d: 世界线更正 ──
  const corrections = await worldLineCorrection(worldState, config, time);
  stepLogs.push(...corrections);

  onProgress?.('Step 7/7 · 收尾', [
    `${personalActions.size} 个角色 CRUD 执行完成`,
    corrections.length + ' 条基线修正',
  ]);

  // ── 时间推进 ──
  const newTime = advanceWorldFlowStep(time, config.time_config.world_flow_step_days, config.time_config.season_days);
  const newWS: WorldState = {
    ...worldState,
    game_time: newTime,
    flow_count: worldState.flow_count + 1,
  };

  await saveWorldState(newWS);
  await saveAllCharacters(characters);

  // ═══════════════════════════════════════════════════════════
  //  Step 8: NPC 状态同步（0 token）
  //  将世界流中变化的内容同步到内存 characters，确保后续页面访问最新状态
  // ═══════════════════════════════════════════════════════════
  if (!isInitialFlow) {
    for (const ch of characters) {
      if (ch.is_player) continue;
      // 同步世界流产生的外交/状态变化到 NPC 的短期缓冲
      const relevantDipLogs = dipLogs.filter(l => l.includes(ch.name));
      const relevantStateLogs = stateLogs.filter(l => l.includes(ch.name));
      for (const log of relevantDipLogs) {
        ch.short_term_buffer.pending_events.push({
          id: `wf_sync_${Date.now()}_${ch.character_id}`,
          visibility: 'private',
          summary: `世界流外交: ${log.slice(0, 100)}`,
          timestamp: time,
          location_id: ch.position.location_id,
          involved_characters: [ch.character_id],
        });
      }
      for (const log of relevantStateLogs) {
        ch.short_term_buffer.pending_events.push({
          id: nextEventId('wf_sync_state'),
          visibility: 'private',
          summary: `世界流状态: ${log.slice(0, 100)}`,
          timestamp: time,
          location_id: ch.position.location_id,
          involved_characters: [ch.character_id],
        });
      }
    }
    stepLogs.push('[NPC同步] 世界流变化已同步到各角色状态');
  }

  await saveWorldFlowRecord({
    flow_id: `wf_${flowCounter}`,
    flow_number: flowCounter,
    timestamp: time,
    narrative,
    changeSummary: stepLogs,
    reports: [],
    steps:{
      step2_narrative: narrative,
      step3_infoDispatch: [`世界流第${flowCounter}次推进`],
      step4_personalActions: Array.from(personalActions.values()).map(a => `${a.characterName}: ${a.summary}`),
      step5_diplomacy: dipLogs,
      step5_state: stateLogs,
      step6_cognition: ['认知同步完成'],
      step7_reactions: stepLogs.filter(l => l.startsWith('[移动]') || l.startsWith('[状态·移动]') || l.startsWith('[使用]') || l.startsWith('[目的消解]')),
      step7_memory: [`压缩处理完成`, ...corrections],
    },
  });

  // 清理玩家操作记录（在世界流记录成功保存后再清空）
  await markAllProcessed(flowCounter);
  await clearAllActions();

  await endBatch();  // 批量刷写所有脏 store 到 OPFS

  flowCounter++;
  setCurrentFlowNumber(undefined);
  return {
    newWorldState: newWS,
    reports: [],
    changeSummary: stepLogs,
  };
}
