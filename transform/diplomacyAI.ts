// 转化层 —— 外交编排 AI（世界流 Step 5a 调用）
// 按地点分组独立调用，每组 NPC 限制每人最多 3 次互动
// 输出链入 Step 5b（状态编排）

import type { CharacterInstance, WorldState, WorldCardConfig, EventSummary } from '../engine/types';
import { saveCharacter, loadCharacter } from '../engine/db';
import { addResource, setRelation } from '../engine/crud';
import { executeCombat } from '../engine/combat';
import { timeToString } from '../engine/time';
import { getCurrentFlowNumber, callDeepSeek } from '../engine/agent';
import type { PersonalActionResult } from './personalActionAI';

const MAX_INTERACTIONS_PER_CHAR = 3;

// ── 对外接口：按地点分组并发调用 ──
export async function diplomacyAIOrchestration(
  allCharacters: CharacterInstance[], worldState: WorldState,
  locations: { location_id: string; name: string }[],
  config: WorldCardConfig,
  personalActions: Map<string, PersonalActionResult>,
  allActionSummaries: string = '',
): Promise<string[]> {
  const npcs = allCharacters.filter(c => !c.is_player);
  if (npcs.length === 0) return [];

  // 按地点分组
  const locGroups: Record<string, CharacterInstance[]> = {};
  for (const ch of npcs) {
    if (!locGroups[ch.position.location_id]) locGroups[ch.position.location_id] = [];
    locGroups[ch.position.location_id].push(ch);
  }

  // 筛选有 ≥2 个 NPC 的地点
  const interactiveGroups = Object.entries(locGroups).filter(([_, chars]) => chars.length >= 2);
  const soloLocations = Object.entries(locGroups).filter(([_, chars]) => chars.length === 1);

  const logs: string[] = [];

  // 并发处理各地点组（小批量独立 API 调用）
  const results = await Promise.all(interactiveGroups.map(async ([locId, chars]) => {
    // 为每组筛选只属于该组的行动摘要
    const groupSummaries = chars.map(ch => {
      const pa = personalActions.get(ch.character_id);
      return pa ? `${pa.characterName}: ${pa.summary}` : `${ch.name}: 日常活动`;
    }).join('\n');
    try {
      return await diplomacyAIForGroup(chars, locId, locations, worldState, config, groupSummaries);
    } catch (e: any) {
      logs.push(`[外交AI] 地点 ${locations.find(l => l.location_id === locId)?.name || locId} 处理失败: ${e.message}`);
      return [];
    }
  }));

  for (const groupLogs of results) {
    logs.push(...groupLogs);
  }

  // 独行 NPC → 日程记录
  for (const [locId, chars] of soloLocations) {
    const locName = locations.find(l => l.location_id === locId)?.name || locId;
    for (const ch of chars) {
      logs.push(`[日程] ${ch.name}: ${locName}·独处（${ch.schedule?.find(s => s.time === '午时')?.action || ch.drives[0]?.description || '日常活动'}）`);
    }
  }

  return logs;
}

// ── 单地点内 NPC 外交编排 ──
async function diplomacyAIForGroup(
  groupChars: CharacterInstance[], locationId: string,
  locations: { location_id: string; name: string }[],
  worldState: WorldState, config: WorldCardConfig,
  actionSummaries: string = '',
): Promise<string[]> {
  const logs: string[] = [];
  const timeStr = timeToString(worldState.game_time);
  const locName = locations.find(l => l.location_id === locationId)?.name || locationId;

  // ── 1. 角色档案（仅该地点 NPC） ──
  let charProfiles = '';
  for (const ch of groupChars) {
    const facName = config.factions.find(f => f.faction_id === ch.faction_binding.faction_id)?.name || '无势力';
    const drives = ch.drives.map(d => `${d.type}:${d.description}(${Math.round(d.progress*100)}%)`).join(' | ') || '无';
    const inv = ch.inventory.filter(r => r.quantity > 0).map(r => {
      const def = config.resource_types.find(rt => rt.resource_type_id === r.resource_type_id);
      return `${def?.name || r.resource_type_id}×${r.quantity}`;
    }).join('、') || '无';
    charProfiles += `- ${ch.name} | ${ch.identity.title} | P${ch.stats.p_level} | HP${ch.stats.hp}/${ch.stats.max_hp} | ${facName} | ${ch.permanent_memory.personality.speech_style}\n`;
    charProfiles += `  身份: ${ch.permanent_memory.core_identity.slice(0, 60)}\n`;
    charProfiles += `  目的: ${drives}\n`;
    charProfiles += `  物品: ${inv}\n`;
  }

  // ── 2. 事件分发 ──
  const eventMap = new Map<string, string[]>();
  for (const ch of groupChars) {
    for (const ev of ch.short_term_buffer.pending_events) {
      const key = ev.summary.slice(0, 120); // 截断做key，合并相似事件
      if (!eventMap.has(key)) eventMap.set(key, []);
      if (!eventMap.get(key)!.includes(ch.name)) eventMap.get(key)!.push(ch.name);
    }
  }
  let eventDispatch = '';
  for (const [summary, names] of eventMap) {
    eventDispatch += `- 📢「${summary.slice(0, 100)}」→ 知晓者：${names.join('、')}\n`;
  }
  if (!eventDispatch) eventDispatch = '（本轮无特殊事件）\n';

  // ── 3. NPC 关系对（紧凑，仅交互相关） ──
  let pairList = '';
  for (let i = 0; i < groupChars.length; i++) {
    for (let j = i + 1; j < groupChars.length; j++) {
      const a = groupChars[i], b = groupChars[j];
      const sameLoc = a.position.location_id === b.position.location_id;
      if (!sameLoc) continue; // 异地NPC通常不互动，大幅减少无效配对
      const aff = a.relationships.find(r => r.target_id === b.character_id)?.affinity ?? 0;
      const sameFaction = a.faction_binding.faction_id === b.faction_binding.faction_id;
      const aFacName = config.factions.find(f => f.faction_id === a.faction_binding.faction_id)?.name || '无';
      const bFacName = config.factions.find(f => f.faction_id === b.faction_binding.faction_id)?.name || '无';
      const relLabel = aff >= 40 ? '至交' : aff >= 15 ? '友好' : aff >= 0 ? '中立' : aff >= -30 ? '冷淡' : '敌视';
      pairList += `- ${a.name} ↔ ${b.name} | ${relLabel}(好感${aff > 0 ? '+' : ''}${aff}) | ${sameFaction ? `同${aFacName}` : `${aFacName} vs ${bFacName}`}\n`;
      // 交互意图
      const aWants = (a.short_term_buffer.pending_events || []).some(e => e.involved_characters?.includes(b.character_id));
      const bWants = (b.short_term_buffer.pending_events || []).some(e => e.involved_characters?.includes(a.character_id));
      if (aWants || bWants) {
        pairList += `  💡涉事: ${aWants ? `${a.name}有涉及${b.name}的消息` : ''}${aWants && bWants ? ' / ' : ''}${bWants ? `${b.name}有涉及${a.name}的消息` : ''}\n`;
      }
    }
  }

  // ── 世界背景上下文 ──
  const worldContext = `世界：${config.world_name} | 阶段：${worldState.event_stage}
氛围：${config.prompt_config.event_stage_mood}`;

  const prompt = `你是世界的外交编排者。编排【${locName}】内 NPC 之间的互动。每个人最多 ${MAX_INTERACTIONS_PER_CHAR} 次向外发起的互动（A→B 和 B→A 独立计算，内容不同）。
当前时间：${timeStr}

━━━━━━━━━━━━━━━━━━━━━━
【世界背景】${worldContext}
━━━━━━━━━━━━━━━━━━━━━━

【事件情报分发】
${eventDispatch}

【${locName} 角色档案】
${charProfiles}

【各NPC本轮行动计划】
${actionSummaries || '（各角色维持日常）'}

【同地点角色关系对】
${pairList || '（暂无同居角色对）'}

输出格式：
[对话] 发起者名 → 目标名：对话摘要
[交易] 发起者名 → 目标名：资源ID 数量
[冲突] 发起者名 → 目标名：原因
[奖励] 角色名：资源ID 数量

注意：
- 这是本组每个NPC的独立社交回合。同组的每对 NPC 都应考虑双向互动（A对B说话 + B对A回应），每人最多${MAX_INTERACTIONS_PER_CHAR}条向外发起的互动
- 关系紧张+有涉事消息 → 冲突概率高；友好+同势力 → 合作交易概率高
- 不要漏掉任何同组角色——每组2人的话至少要输出2条对话+1条可能的交易或冲突
- 输出丰富而合理`;

  try {
    const { text } = await callDeepSeek(
      '你是一个外交编排AI。输出格式严格遵循：每行 [类型] A → B: 内容。不要输出其他内容。',
      prompt,
      {
        type: 'diplomacy',
        gameTime: timeStr,
        flowNumber: getCurrentFlowNumber(),
      },
      800,
      0.5,
    );

    logs.push(`[外交AI] 编排完成`);

    const lines = text.split('\n').filter((l: string) => l.trim());
    for (const line of lines) {
      let rewardMatch = line.match(/^\[奖励\]\s*(\S+)[:：]\s*(.+)$/);
      if (rewardMatch) {
        const [, fromName, detail] = rewardMatch;
        const parts = detail.split(/\s+/);
        const resId = parts[0];
        const amt = parseInt(parts[1]) || 1;
        // 校验资源ID必须存在于世界配置中
        const resDef = config.resource_types.find(rt => rt.resource_type_id === resId);
        if (!resDef) {
          logs.push(`[外交AI] ⚠非法资源ID：${resId}（不在世界配置中），跳过奖励`);
          continue;
        }
        const rewardChar = groupChars.find(c => c.name === fromName);
        if (rewardChar) {
          await addResource(rewardChar.character_id, resId, amt, worldState.game_time, '世界流奖励');
          const fresh = await loadCharacter(rewardChar.character_id);
          if (fresh) {
            rewardChar.inventory = fresh.inventory;
            for (const d of fresh.drives) { if (d.type === 'quest') d.progress = Math.min(1, d.progress + 0.3); }
            rewardChar.drives = fresh.drives;
          }
          logs.push(`[外交AI·奖励] ${fromName} 获得 ${resDef.name}×${amt}`);
        }
        continue;
      }

      let match = line.match(/^\[(\S+)\]\s*(\S+)\s*→\s*(\S+)[:：]\s*(.+)$/);
      if (!match) continue;
      const [, type, fromName, toName, detail] = match;
      const from = groupChars.find(c => c.name === fromName);
      const to = groupChars.find(c => c.name === toName);
      if (!from || !to) continue;

      if (type === '对话') {
        logs.push(`[外交AI·对话] ${fromName} → ${toName}: ${detail}`);
        const event: EventSummary = {
          id: `dip_${Date.now()}_${Math.random().toString(36).slice(2,6)}_${from.character_id}_${to.character_id}`,
          visibility: 'semi_public',
          summary: `${fromName}与${toName}交谈：${detail}`,
          timestamp: worldState.game_time,
          location_id: from.position.location_id,
          involved_characters: [from.character_id, to.character_id],
        };
        from.short_term_buffer.pending_events.push(event);
        to.short_term_buffer.pending_events.push({ ...event, id: event.id + '_b' });
        // 同势力友好对话 +10，中立对话 +3，让社交网络逐渐形成
        const sameFaction = from.faction_binding.faction_id === to.faction_binding.faction_id;
        const delta = sameFaction ? 8 : 3;
        await setRelation(from.character_id, to.character_id, delta, worldState.game_time, '外交编排');
      } else if (type === '交易') {
        const parts = detail.split(/\s+/);
        const resId = parts[0];
        const amt = parseInt(parts[1]) || 1;
        // 校验资源ID
        const resDef = config.resource_types.find(rt => rt.resource_type_id === resId);
        if (!resDef) {
          logs.push(`[外交AI] ⚠非法资源ID：${resId}（不在世界配置中），跳过交易`);
          continue;
        }
        await addResource(from.character_id, resId, -amt, worldState.game_time, `交易给${toName}`);
        await addResource(to.character_id, resId, amt, worldState.game_time, `来自${fromName}`);
        logs.push(`[外交AI·交易] ${fromName} → ${toName}: ${resDef.name}×${amt}`);
      } else if (type === '冲突') {
        logs.push(`[外交AI·冲突] ${fromName} vs ${toName}: ${detail}`);
        if (detail.includes('战斗')) {
          try {
            const result = await executeCombat(from.character_id, to.character_id, from.position.location_id, config, worldState.game_time);
            logs.push(`[战斗] ${result.narrative}`);
          } catch (e) { console.error('[外交AI·冲突] 战斗失败:', e); logs.push('[战斗] 冲突未能解决'); }
        } else {
          await setRelation(from.character_id, to.character_id, -10, worldState.game_time, '口角冲突');
        }
      }
    }
  } catch (e: any) {
    console.error('[外交AI] 调用失败:', e);
    logs.push(`[外交AI] 调用失败: ${e.message}`);
  }

  return logs;
}
