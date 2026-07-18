// ═══════════════════════════════════════════════════════════
//  game.js — 青云界主游戏页面 (v3 全AI驱动)
//  简化的交互管线：玩家输入 → 双阶段叙事AI → 后置系统变更 → 展示
//  世界流固定N次触发，Agent B已废弃
// ═══════════════════════════════════════════════════════════

import { saveAppState, loadAppState, timeToString, formatTime, $ } from './state.js';
import { xianxiaConfig, initialWorldState } from '../data/xianxia.js';
import { loadAllCharacters, loadCharacter, loadWorldState, saveWorldState, getAllAPILogs, deleteAPILogs, deleteAllAPILogs, saveGameToSlot } from '../engine/db.js';
import { handleCommand } from '../engine/commands.js';
import { executeWorldFlow } from '../engine/worldFlow.js';
import { logPlayerAction, initPlayerLog } from '../engine/playerLog.js';
import { generateFullNarrative } from '../transform/narrativeAI.js';
import { applyWorldChanges } from '../engine/changeApplier.js';
import { initializeWorld } from '../engine/init.js';
import { settleDestiny } from '../engine/destiny.js';
import { GameStateMachine } from '../engine/stateMachine.js';
import { formatKLevel, formatPLevel, WORLD_FLOW_TRIGGER_COUNT } from '../engine/config.js';
import { createChangeLogManager, renderChangeLog } from './changeLog.js';
import { createNarrativeManager } from './narrative-manager.js';
import { createCombatHUD } from './combat-hud.js';
import { createPanels } from './panels.js';

// ── 模块级状态变量 ──
const playerId = 'CHAR_player';
let worldConfig = xianxiaConfig;
let worldState = { ...initialWorldState };

let activeCombat = null;
const sm = new GameStateMachine();
let currentSlotId = 0;
let interactionCount = 0;
let lastNarrativeSummary = '';
let isProcessing = false;
let recentActions = [];
let currentPanel = 'self';

// 世界流触发阈值（可自定义，从config读取）
const WF_TRIGGER = worldConfig.world_flow_trigger_count || WORLD_FLOW_TRIGGER_COUNT;

// ── K/P 层级映射 ──
const kLevelNames = xianxiaConfig.mapping.k_level_names;
const pLevelNames = xianxiaConfig.mapping.p_level_names;
const K = (n) => formatKLevel(n, kLevelNames);
const P = (n) => formatPLevel(n, pLevelNames);
const mapping = xianxiaConfig.mapping;

// ── DOM 引用 ──
const narrativeHistory = $('narrative-history');
const chatInput = $('chat-input');
const locationDisplay = $('location-display');
const timeDisplay = $('time-display');
const wfIndicator = $('wf-indicator');
const bpContent = $('bp-content');
const bottomPanel = $('bottom-panel');

// 加载指示器辅助
function showLoading() {
  const spinner = $('send-spinner');
  const btn = $('btn-send');
  if (spinner) spinner.style.display = 'flex';
  if (btn) btn.style.display = 'none';
}
function hideLoading() {
  const spinner = $('send-spinner');
  const btn = $('btn-send');
  if (spinner) spinner.style.display = 'none';
  if (btn) btn.style.display = '';
}

// ── 辅助 setter ──
function setWorldState(ws) { worldState = ws; }
function setActiveCombat(ac) { activeCombat = ac; }
function setInteractionCount(n) { interactionCount = n; }

// ═══════════════════════════════════════════════════════════
//  叙事历史管理
// ═══════════════════════════════════════════════════════════

function escapeHtml(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

worldConfig._helpers = { mapping, K, P, timeToString, escapeHtml };
const changeLog = createChangeLogManager();
const nm = createNarrativeManager(narrativeHistory, {
  getInteractionCount: () => interactionCount, setInteractionCount: (n) => { interactionCount = n; },
  getLastSummary: () => lastNarrativeSummary, setLastSummary: (s) => { lastNarrativeSummary = s; },
  escapeHtml, sendMessage,
});
const hud = createCombatHUD({ getActiveCombat: () => activeCombat });
const panels = createPanels(worldConfig, playerId, bpContent, worldState);
const panelMap = {
  self: panels.renderSelf, map: panels.renderMap,
  worldline: panels.renderWorldline, backpack: panels.renderBackpack,
  factions: panels.renderFactions, apilog: renderAPILog,
  changelog: renderChangeLogPanel,
};

function restoreNarrative() { nm.restoreNarrative(); }
function saveNarrative() { nm.saveNarrative(); }
function clearNarrative() { nm.clearNarrative(); }
function addNarrativeParagraph(text, isWorldFlow) { nm.addNarrativeParagraph(text, isWorldFlow); }

// ── 玩家气泡 ──
function addPlayerActionEcho(input) {
  const div = document.createElement('div');
  div.className = 'player-action-echo';
  div.innerHTML = `<span class="echo-label">▸</span> ${escapeInput(input)}`;
  narrativeHistory.appendChild(div);
  narrativeHistory.scrollTop = narrativeHistory.scrollHeight;
}

function escapeInput(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ── 资源流转提示（叙事下方显示）──
function showResourceFlowNotices(changeLogs) {
  if (!changeLogs || changeLogs.length === 0) return;

  const lines = [];
  for (const log of changeLogs) {
    const s = String(log);

    // 玩家资源变化
    let m = s.match(/^\[变更·资源\]\s+CHAR_player:\s+(.+?)\s+([+-]\d+)/);
    if (m) {
      const name = m[1];
      const delta = parseInt(m[2]);
      if (delta > 0) {
        lines.push(`<span class="rfn-gain">◇</span> ${name} <span class="rfn-num rfn-pos">+${delta}</span>`);
      } else if (delta < 0) {
        lines.push(`<span class="rfn-loss">◆</span> ${name} <span class="rfn-num rfn-neg">${delta}</span>`);
      }
      continue;
    }

    // 物品转移给玩家
    m = s.match(/^\[变更·转移\]\s+(.+?)\s+→\s+(.+?):\s+(.+?)×(\d+)/);
    if (m) {
      const from = m[1];
      const to = m[2];
      const resName = m[3];
      const qty = m[4];
      const poolNote = s.includes('[池补') ? s.match(/\[池补(\d+)\]/)?.[1] : null;

      if (to.includes('CHAR_player') || to.includes('你')) {
        const fromLabel = from === '系统' ? '系统奖励' : `从 <b>${from}</b>`;
        lines.push(`<span class="rfn-transfer">↔</span> ${fromLabel} 获得 <b>${resName}</b> ×${qty}${poolNote ? ` <span class="rfn-pool">(池补${poolNote})</span>` : ''}`);
      }
      continue;
    }

    // 玩家 HP 变化
    m = s.match(/^\[变更·HP\]\s+(.+?):\s+([+-]?\d+)\s+→\s+(\d+)\/(\d+)/);
    if (m) {
      const name = m[1];
      const delta = parseInt(m[2]);
      if (name === '你' || name.includes('林玄') || name === '玩家') {
        if (delta < 0) {
          lines.push(`<span class="rfn-hp">♥</span> HP <span class="rfn-num rfn-neg">${delta}</span> → ${m[3]}/${m[4]}`);
        } else if (delta > 0) {
          lines.push(`<span class="rfn-hp">♥</span> HP <span class="rfn-num rfn-pos">+${delta}</span> → ${m[3]}/${m[4]}`);
        }
      }
      continue;
    }

    // 玩家关系变化
    m = s.match(/^\[变更·关系\]\s+(.+?)\s+[↔⟷]\s+(.+?):\s+([+-]\d+)好感/);
    if (m) {
      const a = m[1], b = m[2];
      const delta = parseInt(m[3]);
      if (a.includes('CHAR_player') || b.includes('CHAR_player')) {
        const other = a.includes('CHAR_player') ? b : a;
        if (delta > 0) {
          lines.push(`<span class="rfn-rel">♥</span> 与 <b>${other}</b> 好感 <span class="rfn-num rfn-pos">+${delta}</span>`);
        } else {
          lines.push(`<span class="rfn-rel">♥</span> 与 <b>${other}</b> 好感 <span class="rfn-num rfn-neg">${delta}</span>`);
        }
      }
      continue;
    }

    // 玩家修为变化
    m = s.match(/^\[变更·修为\]\s+(.+?):\s+(.+?)\s+→\s+(.+)/);
    if (m) {
      const name = m[1];
      if (name === '你' || name.includes('林玄') || name === '玩家') {
        lines.push(`<span class="rfn-level">⚡</span> 修为突破：<b>${m[2]}</b> → <b>${m[3]}</b>`);
      }
      continue;
    }

    // 玩家身份变化
    m = s.match(/^\[变更·身份\]\s+(.+?):\s+(.+?)\s+→\s+(.+)/);
    if (m) {
      const name = m[1];
      if (name === '你' || name.includes('林玄') || name === '玩家') {
        lines.push(`<span class="rfn-rank">★</span> 身份晋升：<b>${m[2]}</b> → <b>${m[3]}</b>`);
      }
      continue;
    }

    // 交互记忆
    m = s.match(/^\[变更·记忆\]\s+(.+?):\s+(.+)/);
    if (m) {
      const npcName = m[1];
      const summary = m[2];
      lines.push(`<span class="rfn-mem">💭</span> <b>${npcName}</b> 记住了：${summary}`);
      continue;
    }
  }

  if (lines.length === 0) return;

  const div = document.createElement('div');
  div.className = 'resource-flow-notices';
  div.innerHTML = lines.map(l => `<div class="rfn-line">${l}</div>`).join('');
  narrativeHistory.appendChild(div);
  narrativeHistory.scrollTop = narrativeHistory.scrollHeight;
}

// ── 上下文历史管理 ──
function pushActionHistory(input, resultSummary) {
  recentActions.push({
    input,
    summary: resultSummary.slice(0, 100),
    full: `玩家"${input}" → ${resultSummary.slice(0, 150)}`
  });
  if (recentActions.length > 8) recentActions.shift();
}

function recentActionsContext() {
  if (recentActions.length === 0) return '（尚无历史行动）';
  return '【最近行动历史】\n' + recentActions.map((a, i) => `${i + 1}. ${a.full}`).join('\n');
}

// ═══════════════════════════════════════════════════════════
//  全量世界目录
// ═══════════════════════════════════════════════════════════

function buildWorldCatalog(playerLocationId) {
  const locs = worldConfig.locations || [];
  const chars = worldConfig.characters || [];
  const factions = worldConfig.factions || [];
  const resources = worldConfig.resource_types || [];

  const locList = locs.map(l =>
    `  - ${l.name}（${l.location_id}）：${(l.description || '').slice(0, 60)}${l.danger_level ? ' | 危险度' + l.danger_level : ''}${(l.resources || []).length ? ' | 藏有' + l.resources.map(r => { const def = resources.find(rt => rt.resource_type_id === r.resource_type_id); return (def?.name || r.resource_type_id) + '×' + r.quantity; }).join('、') : ''}`
  ).join('\n');

  const npcList = chars
    .filter(c => !c.is_player)
    .map(c => {
      const locName = locs.find(l => l.location_id === c.position.location_id)?.name || '未知';
      const items = (c.inventory || []).slice(0, 5).map(i => {
        const def = resources.find(rt => rt.resource_type_id === i.resource_type_id);
        return `${def?.name || i.resource_type_id}×${i.quantity}`;
      }).join('、') || '无';
      let detail = `${c.name}（ID:${c.character_id}，${c.identity.title}，K${c.identity.k_level}，P${c.stats.p_level}，在${locName}，持${items}）：${c.permanent_memory.core_identity.slice(0, 60)}`;

      // 展开当前地点 NPC 的详细信息
      if (playerLocationId && c.position.location_id === playerLocationId) {
        const pers = c.permanent_memory.personality;
        if (pers) detail += `\n    性格：${pers.speech_style} | 正式${pers.formality}/10 | 口头禅：${pers.quirks?.join('、') || '无'}`;
        if (c.relationships?.length) {
          const rels = c.relationships.slice(0, 5).map(r => {
            const tgt = chars.find(ch => ch.character_id === r.target_id);
            return `${tgt?.name || r.target_id}:好感${r.affinity}`;
          }).join(' ');
          detail += `\n    关系：${rels}`;
        }
        if (c.drives?.length) {
          detail += `\n    目的：${c.drives.map(d => `「${d.description}」${Math.round(d.progress * 100)}%`).join(' | ')}`;
        }
      }
      return `  - ${detail}`;
    }).join('\n');

  const facList = factions.map(f =>
    `  - ${f.name}（${f.faction_id}，K${f.k_level}）：${f.core_interests?.join('、') || '未设定'}`
  ).join('\n');

  const resList = resources.map(r => `${r.name}（${r.resource_type_id}，${r.rarity}）`).join('、');

  return `【世界全量目录——禁止编造以下未列出的内容】

【全量资源（只能使用以下ID）】
${resList}

【全量地点（只能使用以下ID）】
${locList}

【全量角色（只能使用以下ID）】
${npcList}

【势力】
${facList}`;
}

// ═══════════════════════════════════════════════════════════
//  构建叙事上下文（新AI用）
// ═══════════════════════════════════════════════════════════

async function buildNarrativeContext(mode, playerAction, systemActionResult) {
  const player = await loadCharacter(playerId);
  if (!player) throw new Error('玩家角色未找到');

  const allChars = await loadAllCharacters();
  const currentLoc = player.position.location_id;
  const locDef = (worldConfig.locations || []).find(l => l.location_id === currentLoc);

  const time = worldState.game_time;
  const timeStr = timeToString(time);
  const season = time.season;
  const timeFlavor = (mapping.time_flavors || {})[time.timeOfDay]?.[season] || `${season}·${time.timeOfDay}`;

  // 在场 NPC 详情
  const npcsAtLoc = allChars.filter(c =>
    !c.is_player && c.position.location_id === currentLoc && c.agent_state !== 'dormant'
  );
  const nearbyNPCsStr = npcsAtLoc.map(c => {
    const items = c.inventory.slice(0, 5).map(i => {
      const def = worldConfig.resource_types.find(rt => rt.resource_type_id === i.resource_type_id);
      return `${def?.name || i.resource_type_id}×${i.quantity}`;
    }).join('、') || '无';
    const rel = player.relationships.find(r => r.target_id === c.character_id);
    const aff = rel?.affinity ?? 0;
    let txt = `${c.name}（ID:${c.character_id}，${c.identity.title}，持${items}，好感${aff}）`;
    const pers = c.permanent_memory.personality;
    if (pers) txt += ` | 性格：${pers.speech_style}`;
    if (c.drives?.length) txt += ` | 目的：${c.drives[0]?.description}`;
    return txt;
  }).join('\n') || '周围无人';

  // 所有 NPC 摘要
  const allNPCsSummary = allChars.filter(c => !c.is_player).map(c => {
    const locName = worldConfig.locations.find(l => l.location_id === c.position.location_id)?.name || '未知';
    return `${c.name}（ID:${c.character_id}，${c.identity.title}，在${locName}）`;
  }).join('\n');

  // 玩家关系
  const relationshipsSummary = player.relationships.map(r => {
    const target = allChars.find(c => c.character_id === r.target_id);
    return `${target?.name || r.target_id}:好感${r.affinity}`;
  }).join('、') || '暂无关系';

  // 玩家物品
  const playerInventorySummary = player.inventory.map(r => {
    const def = worldConfig.resource_types.find(rt => rt.resource_type_id === r.resource_type_id);
    return `${def?.name || r.resource_type_id}×${r.quantity}`;
  }).join('、') || '空';

  // 当前地点可采集资源
  const locResources = (locDef?.resources || []).filter(r => r.quantity > 0);
  const playerLocationResources = locResources.length > 0
    ? locResources.map(r => {
        const def = worldConfig.resource_types.find(rt => rt.resource_type_id === r.resource_type_id);
        return `${def?.name || r.resource_type_id}×${r.quantity}`;
      }).join('、')
    : '';

  // 修炼状态
  const ct = worldConfig.prompt_config?.cultivation_thresholds || {};
  const nextKey = `${player.stats.p_level}→${player.stats.p_level + 1}`;
  const nextCt = ct[nextKey];
  const playerCultivationInfo = nextCt
    ? `${P(player.stats.p_level)}，进度${player.stats.cultivation_progress}/${nextCt.required_progress}，突破需：灵石${nextCt.required_spirit_stones}、丹药${nextCt.required_pills}、${nextCt.require_skill}`
    : `${P(player.stats.p_level)}，已达最高境界`;

  return {
    worldName: worldConfig.world_name,
    worldDescription: worldConfig.world_description.slice(0, 200),
    worldMood: worldConfig.prompt_config.event_stage_mood || '修真世界缓缓运转',
    worldCatalog: buildWorldCatalog(currentLoc),

    timeStr,
    timeFlavor,
    season,

    playerName: player.name || '你',
    playerIdentity: player.identity.title,
    playerPLevel: P(player.stats.p_level),
    playerHP: `${player.stats.hp}/${player.stats.max_hp}`,
    playerLocation: locDef?.name || currentLoc,
    playerLocationDesc: locDef?.description || '',
    playerLocationResources,
    playerPurpose: player.drives[0]?.description || '问道长生',
    playerInventorySummary,
    playerCultivationInfo,

    nearbyNPCsStr,
    allNPCsSummary,
    relationshipsSummary,

    previousNarrative: lastNarrativeSummary,

    playerAction,
    recentActionsHistory: recentActionsContext(),

    mode,
    systemActionResult,
  };
}

// ═══════════════════════════════════════════════════════════
//  核心交互处理（简化版）
//  输入 → 叙事AI（提纲+写作+变更提取）→ 变更应用 → 展示
// ═══════════════════════════════════════════════════════════

async function handlePlayerInput(input) {
  if (isProcessing) return;
  if (sm.isWorldFlow) { addNarrativeParagraph('[系统提示] 世界流转中，请稍候...'); return; }
  if (!sm.canExecute(input.trim())) {
    addNarrativeParagraph(`[系统提示] 当前状态（${sm.description}）下不允许此操作。`);
    return;
  }
  isProcessing = true;
  showLoading();

  try {
    const player = await loadCharacter(playerId);
    if (!player) {
      addNarrativeParagraph('[系统提示] 玩家角色未找到，请刷新页面重试。');
      return;
    }

    // 玩家回声
    addPlayerActionEcho(input);

    // 如果是 /指令，直接处理不走AI
    if (input.startsWith('/')) {
      await handleDirectCommand(input, player);
      return;
    }

    // ── 核心管线：叙事AI ──
    const ctx = await buildNarrativeContext('action', input, '');
    const result = await generateFullNarrative(ctx);

    // ── 后置：应用系统变更 ──
    const changeLogs = await applyWorldChanges(result.changeSet, worldState.game_time, worldConfig);

    // 记录变更日志到持久化存储
    if (changeLogs.length > 0) {
      changeLog.addEntry(changeLogs, result.changeSet.narrative_summary || '', timeToString(worldState.game_time), worldState.flow_count);
    }

    // ── 记录操作历史 ──
    pushActionHistory(input, result.narrative.slice(0, 100));
    logPlayerAction('conversation', '叙事', result.changeSet.narrative_summary || input.slice(0, 20),
      result.narrative.slice(0, 100), worldState.game_time);

    // ── 展示叙事 ──
    let narrativeBody = result.narrative.split(/\n---+\n/)[0]?.trim();
    if (!narrativeBody) narrativeBody = result.narrative.trim();
    if (!narrativeBody) narrativeBody = `时光继续流淌...`;
    addNarrativeParagraph(narrativeBody, false);
    showResourceFlowNotices(changeLogs);
    lastNarrativeSummary = narrativeBody;

    // ── 检查世界流触发 ──
    interactionCount++;
    if (interactionCount >= WF_TRIGGER) {
      await triggerWorldFlow();
    }

    updateUI();
  } catch (e) {
    console.error('[handlePlayerInput]', e);
    addNarrativeParagraph(`[系统提示] ${e.message || '处理失败，请重试。'}`, false);
  } finally {
    isProcessing = false;
    hideLoading();
  }
}

// ── 直接指令处理（仅 4 个信息查询指令）──
async function handleDirectCommand(input, player) {
  const cmdResult = await handleCommand(input, player, worldState, worldConfig);
  addNarrativeParagraph(`[系统] ${cmdResult.response}`, false);
  updateUI();
}

// ═══════════════════════════════════════════════════════════
//  世界流触发（固定计数）—— 内联进度块
// ═══════════════════════════════════════════════════════════

async function triggerWorldFlow() {
  // 在叙事面板中插入进度块
  const block = addWorldFlowProgressBlock();
  sm.transition('world_flow');

  try {
    const result = await executeWorldFlow(
      worldState, worldConfig, false,
      (step, lines) => {
        const stepDiv = document.createElement('div');
        stepDiv.className = 'wf-step-entry';
        stepDiv.innerHTML = `<div class="wf-step-label">${step}</div>${lines.filter(Boolean).map(l => `<div class="wf-step-line">${l}</div>`).join('')}`;
        block.body.appendChild(stepDiv);
        block.body.scrollTop = block.body.scrollHeight;
        narrativeHistory.scrollTop = narrativeHistory.scrollHeight;
      }
    );

    setWorldState(result.newWorldState);
    interactionCount = 0;

    // 标记完成
    block.markDone(result.changeSummary?.length || 0);

    // 世界流后叙事
    try {
      const wfCtx = await buildNarrativeContext('world_flow', '', '');
      wfCtx.worldFlowSummary = result.changeSummary.slice(0, 10).join('；');
      wfCtx.worldFlowDays = worldConfig.time_config.world_flow_step_days;

      const wfResult = await generateFullNarrative(wfCtx);

      const wfChangeLogs = await applyWorldChanges(wfResult.changeSet, worldState.game_time, worldConfig);
      if (wfChangeLogs.length > 0) {
        changeLog.addEntry(wfChangeLogs, '世界流·' + (wfResult.changeSet.narrative_summary || worldState.flow_count + '次'), timeToString(worldState.game_time), worldState.flow_count);
      }

      const wfBody = wfResult.narrative.split(/\n---+\n/)[0]?.trim() || wfResult.narrative.trim() || '世界照常运转...';
      addNarrativeParagraph(wfBody, true);
      showResourceFlowNotices(wfChangeLogs);
    } catch (e) {
      console.error('[世界流叙事] 失败:', e);
      addNarrativeParagraph(`时光流转，${worldConfig.time_config.world_flow_step_days}天过去了。世界继续运转着...`, true);
    }

    updateUI();
    updateWFIndicator();
    sm.toIdle();
  } catch (e) {
    console.error('[世界流] 失败:', e);
    sm.toIdle();
    block.markError(e.message);
    addNarrativeParagraph(`[系统提示] 世界流转异常：${e.message}`);
  }
}

// ── 世界流内联进度块 ──
function addWorldFlowProgressBlock() {
  const block = document.createElement('div');
  block.className = 'wf-inline-block wf-inline-expanded';

  const header = document.createElement('div');
  header.className = 'wf-inline-header';
  header.innerHTML = `<span class="wf-inline-icon">⏳</span> 世界流转中... <span class="wf-inline-flow">#${worldState.flow_count + 1}</span>`;
  header.addEventListener('click', () => block.classList.toggle('wf-inline-expanded'));

  const body = document.createElement('div');
  body.className = 'wf-inline-body';

  block.appendChild(header);
  block.appendChild(body);
  narrativeHistory.appendChild(block);
  narrativeHistory.scrollTop = narrativeHistory.scrollHeight;

  return {
    body,
    markDone(changeCount) {
      header.innerHTML = `<span class="wf-inline-icon">✅</span> 世界流 #${worldState.flow_count} 完成 <span class="wf-inline-flow">${changeCount} 条变更</span>`;
      block.classList.remove('wf-inline-expanded');
    },
    markError(msg) {
      header.innerHTML = `<span class="wf-inline-icon">❌</span> 世界流失败 <span class="wf-inline-flow" style="color:#c06050">${escapeHtml(msg.slice(0, 30))}</span>`;
      block.classList.remove('wf-inline-expanded');
    },
  };
}

// ═══════════════════════════════════════════════════════════
//  叙事初始化
// ═══════════════════════════════════════════════════════════

async function generateInitialNarrative() {
  showLoading();
  isProcessing = true;

  // 在叙事区插入加载提示
  const loadingMsg = document.createElement('div');
  loadingMsg.className = 'narrative-paragraph';
  loadingMsg.innerHTML = '<p style="color:#6a8a7a;font-size:.75rem">正在生成开篇叙事：构思提纲...</p>';
  narrativeHistory.appendChild(loadingMsg);

  try {
    const ctx = await buildNarrativeContext('action', '', '冒险开始了。你站在山门广场，准备踏上修真之路。');
    loadingMsg.innerHTML = '<p style="color:#6a8a7a;font-size:.75rem">正在生成开篇叙事：书写正文...</p>';
    const result = await generateFullNarrative(ctx);
    loadingMsg.innerHTML = '<p style="color:#6a8a7a;font-size:.75rem">正在生成开篇叙事：整理世界状态...</p>';

    const body = result.narrative.split(/\n---+\n/)[0]?.trim() || result.narrative.trim() || '青云界的晨风拂过山门...';
    loadingMsg.remove();
    addNarrativeParagraph(body, false);
    lastNarrativeSummary = body;

    updateUI();
    updateWFIndicator();
  } catch (e) {
    console.error('[初始叙事] 失败:', e);
    loadingMsg.remove();
    addNarrativeParagraph(`[系统提示] ${e.message}\n请刷新页面重试，或检查 API Key 是否正确。`, false);
  } finally {
    hideLoading();
    isProcessing = false;
  }
}

async function generateContinueNarrative() {
  showLoading();
  isProcessing = true;
  try {
    const ctx = await buildNarrativeContext('action', '', `冒险继续。你在${worldState.flow_count}次世界流后站在当前的位置，故事仍在书写中。`);
    const result = await generateFullNarrative(ctx);

    const body = result.narrative.split(/\n---+\n/)[0]?.trim() || result.narrative.trim() || '故事仍在继续...';
    addNarrativeParagraph(body, false);
    lastNarrativeSummary = body;

    updateUI();
    updateWFIndicator();
  } catch (e) {
    console.error('[继续叙事] 失败:', e);
    addNarrativeParagraph(`[系统提示] ${e.message}\n请刷新页面重试。`, false);
  } finally {
    hideLoading();
    isProcessing = false;
  }
}

// ═══════════════════════════════════════════════════════════
//  updateUI / updateWFIndicator / updateCombatHUD
// ═══════════════════════════════════════════════════════════

function updateUI() {
  loadCharacter(playerId).then(player => {
    if (player) {
      const locName = (worldConfig.locations || []).find(
        l => l.location_id === player.position.location_id
      )?.name || '?';
      locationDisplay.textContent = locName;
    }
  }).catch(() => {});
  timeDisplay.textContent = timeToString(worldState.game_time);
}

function updateWFIndicator() {
  if (wfIndicator) {
    wfIndicator.textContent = `[流#${worldState.flow_count}]`;
  }
}

function updateCombatHUD() { hud.updateCombatHUD(); }

// ═══════════════════════════════════════════════════════════
//  面板系统
// ═══════════════════════════════════════════════════════════

async function renderSelf() { await panels.renderSelf(); }
async function renderMap() { await panels.renderMap(); }
async function renderFactions() { await panels.renderFactions(); }
async function renderWorldline() { await panels.renderWorldline(); }
async function renderBackpack() { await panels.renderBackpack(); }

function renderChangeLogPanel() { renderChangeLog(bpContent, worldConfig); }

function showWorldFlowDetail(record) {
  const modal = document.getElementById('wf-detail-modal');
  const body = document.getElementById('wf-detail-body');
  if (!modal || !body) return;

  const steps = record.steps || {};
  let html = '';

  if (record.narrative) {
    html += `<div class="wf-step-block wf-narrative-block"><div class="wf-step-head">2 · 世界叙事</div><div class="wf-narrative-text">${escapeHtml(record.narrative.replace(/^#+\s*.*$/gm, '').trim())}</div></div>`;
  }

  if (steps.step4_personalActions?.length) {
    html += `<div class="wf-step-block"><div class="wf-step-head">4 · 个人行动（${steps.step4_personalActions.length}人）</div>${steps.step4_personalActions.map(a => `<div class="wf-step-line">${escapeHtml(a)}</div>`).join('')}</div>`;
  }

  const dipCount = steps.step5_diplomacy?.length;
  const stateCount = steps.step5_state?.length;
  if (dipCount || stateCount) {
    html += '<div class="wf-step-block"><div class="wf-step-head">5 · 外交+状态</div>';
    if (dipCount) {
      html += '<div class="wf-sub-label">外交</div>' + steps.step5_diplomacy.map(l => `<div class="wf-step-line">${escapeHtml(l)}</div>`).join('');
    }
    if (stateCount) {
      html += '<div class="wf-sub-label">状态</div>' + steps.step5_state.map(l => `<div class="wf-step-line">${escapeHtml(l)}</div>`).join('');
    }
    html += '</div>';
  }

  if (steps.step6_cognition?.length) {
    html += `<div class="wf-step-block"><div class="wf-step-head">6 · 认知同步</div>${steps.step6_cognition.map(l => `<div class="wf-step-line">${escapeHtml(l)}</div>`).join('')}</div>`;
  }

  if (steps.step7_reactions?.length || steps.step7_memory?.length) {
    html += '<div class="wf-step-block"><div class="wf-step-head">7 · 执行</div>';
    if (steps.step7_reactions?.length) {
      html += '<div class="wf-sub-label">变化</div>' + steps.step7_reactions.map(l => `<div class="wf-step-line">${escapeHtml(l)}</div>`).join('');
    }
    if (steps.step7_memory?.length) {
      html += '<div class="wf-sub-label">记忆与修正</div>' + steps.step7_memory.map(l => `<div class="wf-step-line">${escapeHtml(l)}</div>`).join('');
    }
    html += '</div>';
  }

  body.innerHTML = html;
  modal.classList.add('show');
  window._closeWfDetail = () => { modal.classList.remove('show'); };
}

// ── API 日志面板 ──
let selectedSlashIds = new Set();

async function renderAPILog() {
  const logs = await getAllAPILogs();
  const totalTokens = logs.reduce((sum, l) => sum + (l.response?.tokenUsage?.total_tokens || 0), 0);
  const inputTokens = logs.reduce((sum, l) => sum + (l.response?.tokenUsage?.prompt_tokens || 0), 0);
  const outputTokens = logs.reduce((sum, l) => sum + (l.response?.tokenUsage?.completion_tokens || 0), 0);
  const avgMs = logs.length > 0 ? Math.round(logs.reduce((s, l) => s + l.durationMs, 0) / logs.length) : 0;
  const errors = logs.filter(l => l.error).length;

  const typeLabels = {
    conversation: '对话', world_narrative: '世界叙事', narrative_outline: '提纲', narrative_writing: '写作', narrative_parsing: '解析',
    report: '报告', init_world: '初始化',
    diplomacy: '外交', state_orchestration: '状态', creation_certify: '校验', personal_action: '个人',
    memory_compression: '记忆', player_summary: '玩家总结', drive_check: '目的', action_parser: '指令',
  };

  // 按时间倒序
  const sorted = [...logs].reverse();
  const flowNumbers = [...new Set(sorted.map(l => l.flow_number).filter(n => n !== undefined && n !== null))].sort((a, b) => b - a);

  let html = '';
  let lastFlowNum = null;

  for (const log of sorted) {
    // 世界流分隔标记：当 flow_number 变化时插入分隔线
    if (log.flow_number !== undefined && log.flow_number !== lastFlowNum) {
      lastFlowNum = log.flow_number;
      const flowLabel = lastFlowNum > 0 ? `世界流 #${lastFlowNum}` : '创建世界';
      html += `<div class="api-separator"><span>${flowLabel}</span></div>`;
    }

    const timeStr = new Date(log.timestamp).toLocaleTimeString('zh-CN');
    const typeLabel = typeLabels[log.type] || log.type;
    const dotClass = log.error ? 'dot-err' : log.response ? 'dot-ok' : 'dot-pending';
    const tokenInfo = log.response?.tokenUsage
      ? `<span class="api-tok">${log.response.tokenUsage.total_tokens}T (${log.response.tokenUsage.prompt_tokens}+${log.response.tokenUsage.completion_tokens})</span>`
      : '';
    const charTag = log.characterName ? `<span class="api-char">${log.characterName}</span>` : '';

    html += `<div class="api-log-entry${selectedSlashIds.has(log.id) ? ' selected' : ''}" data-id="${log.id}">
        <div class="api-log-header" onclick="event.stopPropagation();this.parentElement.classList.toggle('expanded')">
          <span class="api-hd-left"><span class="api-dot ${dotClass}"></span>${timeStr} <b>${typeLabel}</b> ${charTag} ${tokenInfo}</span>
          <span class="api-hd-right">${log.durationMs}ms</span>
        </div>
        <div class="api-log-body">
          <div class="label">System (${log.request.systemPrompt.length}字)</div><pre>${escapeHtml(log.request.systemPrompt)}</pre>
          <div class="label">User (${log.request.userPrompt.length}字)</div><pre>${escapeHtml(log.request.userPrompt)}</pre>
          ${log.response ? `<div class="label">响应 (${log.response.text.length}字)${log.response.tokenUsage ? ' · ' + log.response.tokenUsage.prompt_tokens + '+' + log.response.tokenUsage.completion_tokens + ' tokens' : ''}</div><pre class="resp">${escapeHtml(log.response.text)}</pre>` : ''}
          ${log.error ? `<div class="label err">错误</div><pre class="err">${escapeHtml(log.error)}</pre>` : ''}
        </div></div>`;
  }

  bpContent.innerHTML = `
    <h3 class="panel-section">API 日志</h3>
    <div class="api-stats">
      <div class="api-stat"><div class="val">${logs.length}</div><div class="lbl">总调用</div></div>
      <div class="api-stat"><div class="val">${totalTokens.toLocaleString()}</div><div class="lbl">总Token</div></div>
      <div class="api-stat"><div class="val">${inputTokens.toLocaleString()}</div><div class="lbl">Input</div></div>
      <div class="api-stat"><div class="val">${outputTokens.toLocaleString()}</div><div class="lbl">Output</div></div>
      <div class="api-stat"><div class="val">${avgMs}ms</div><div class="lbl">平均耗时</div></div>
      <div class="api-stat"><div class="val" style="color:${errors ? '#e06060' : '#30b070'}">${errors}</div><div class="lbl">错误</div></div>
    </div>
    <div style="display:flex;gap:4px;justify-content:flex-end;margin-bottom:8px">
      <button class="btn btn-sm" onclick="window._apiToggleAll()">全选</button>
      <button class="btn btn-sm btn-danger" onclick="window._apiDeleteSelected()">删除选中</button>
      <button class="btn btn-sm btn-danger" onclick="window._apiDeleteAll()">全部清空</button>
    </div>
    <div id="api-log-list">${html}</div>`;

  document.querySelectorAll('#api-log-list .api-log-entry').forEach(entry => {
    entry.addEventListener('contextmenu', e => {
      e.preventDefault();
      const id = entry.dataset.id;
      if (selectedSlashIds.has(id)) selectedSlashIds.delete(id);
      else selectedSlashIds.add(id);
      entry.classList.toggle('selected', selectedSlashIds.has(id));
    });
  });

  window._apiToggleAll = () => {
    const allIds = sorted.map(l => l.id);
    if (selectedSlashIds.size === allIds.length) selectedSlashIds.clear();
    else allIds.forEach(id => selectedSlashIds.add(id));
    renderAPILog();
  };
  window._apiDeleteSelected = async () => {
    if (selectedSlashIds.size) {
      await deleteAPILogs([...selectedSlashIds]);
      selectedSlashIds.clear();
      renderAPILog();
    }
  };
  window._apiDeleteAll = async () => {
    if (await confirmDialog('清空日志', `清空全部 ${logs.length} 条日志？`)) {
      await deleteAllAPILogs();
      selectedSlashIds.clear();
      renderAPILog();
    }
  };
}

function confirmDialog(title, body) {
  return new Promise(resolve => {
    const modal = document.getElementById('confirm-modal');
    document.getElementById('confirm-modal-title').textContent = title;
    document.getElementById('confirm-modal-body').textContent = body || '';
    modal.style.display = 'flex';
    document.getElementById('btn-confirm-ok').onclick = () => { modal.style.display = 'none'; resolve(true); };
    document.getElementById('btn-confirm-cancel').onclick = () => { modal.style.display = 'none'; resolve(false); };
    modal.onclick = e => { if (e.target === modal) { modal.style.display = 'none'; resolve(false); } };
  });
}

// ═══════════════════════════════════════════════════════════
//  sendMessage
// ═══════════════════════════════════════════════════════════

function sendMessage() {
  if (isProcessing) return;
  const input = chatInput.value.trim();
  if (!input) return;
  chatInput.value = '';
  handlePlayerInput(input);
}

// ═══════════════════════════════════════════════════════════
//  存档
// ═══════════════════════════════════════════════════════════

async function autoSave() {
  try { await saveGameToSlot(currentSlotId || 1, '自动存档'); } catch {}
}

function setupSaveButton() {
  const btn = document.getElementById('btn-save');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    try {
      await saveGameToSlot(currentSlotId || 1, '手动存档');
      addNarrativeParagraph('[系统提示] 存档成功。');
    } catch (e) {
      addNarrativeParagraph(`[系统提示] 存档失败：${e.message}`);
    }
  });
}

// ═══════════════════════════════════════════════════════════
//  结束世界
// ═══════════════════════════════════════════════════════════

function setupEndWorldButton() {
  const btn = document.getElementById('btn-end-world');
  if (!btn) return;
  window._confirmEndWorld = () => { alert('请先点击"结束"按钮。'); };

  btn.addEventListener('click', async () => {
    if (!(await confirmDialog('结束世界', '确定要结束这个世界吗？结束后将根据你的成就结算命石，无法撤销。'))) return;
    btn.disabled = true;

    const modal = document.getElementById('end-world-modal');
    const body = document.getElementById('end-world-body');
    if (!modal || !body) { btn.disabled = false; return; }

    try {
      const player = await loadCharacter(playerId);
      if (!player) { btn.disabled = false; return; }
      const result = await settleDestiny(player, worldState);
      body.innerHTML = `
        <p style="text-align:left;line-height:2.2"><strong>${player.name}</strong> 的传奇在此终结。</p>
        <p style="text-align:left;font-size:.75rem;color:#8a8a7a">P${player.stats.p_level} · K${player.identity.k_level} · 世界流 ${worldState.flow_count}次<br>${result.breakdown.join('<br>')}</p>
        <p style="color:#3a8a7a;font-weight:700;font-size:1.1rem;margin-top:8px">获得 +${result.earned} 命石</p>`;
      modal.classList.add('show');

      window._confirmEndWorld = async () => {
        worldState.is_ended = true;
        await saveWorldState(worldState);
        modal.classList.remove('show');
        try { localStorage.removeItem('to-rpg_narrative'); } catch {}
        setTimeout(() => { window.location.href = 'setup.html'; }, 500);
      };
    } catch (e) {
      console.error('[结束世界] 失败:', e);
      addNarrativeParagraph(`[系统提示] 结束世界失败：${e.message}`);
    } finally { btn.disabled = false; }
  });
}

// ═══════════════════════════════════════════════════════════
//  init()
// ═══════════════════════════════════════════════════════════

async function init() {
  const appState = await loadAppState();
  if (appState) {
    if (appState.slotId) currentSlotId = appState.slotId;
    // interactionCount 不恢复 —— 它仅在当次会话中计世界流触发，跨页面刷新应重置
  }

  const savedWS = await loadWorldState();
  if (savedWS) setWorldState({ ...worldState, ...savedWS });

  updateUI();
  updateWFIndicator();
  restoreNarrative();
  await initPlayerLog();

  // 如果世界已初始化（flow_count > 0 或已有叙事），隐藏开篇按钮
  if (worldState.flow_count > 0 || narrativeHistory?.querySelector('.narrative-paragraph')) {
    const btnIntro = document.getElementById('btn-intro');
    const introPrompt = document.getElementById('intro-prompt');
    if (btnIntro) btnIntro.style.display = 'none';
    if (introPrompt) introPrompt.style.display = 'none';
  }

  // 发送按钮
  const sendBtn = document.getElementById('btn-send');
  if (sendBtn) sendBtn.addEventListener('click', sendMessage);

  chatInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  });

  // 面板导航
  document.querySelectorAll('.pnav-item').forEach(item => {
    item.addEventListener('click', () => {
      const panel = item.dataset.panel;
      if (!panel || !panelMap[panel]) return;
      if (bottomPanel?.classList.contains('bottom-panel-open') && currentPanel === panel) {
        bottomPanel.classList.remove('bottom-panel-open');
        document.querySelectorAll('.pnav-item').forEach(i => i.classList.remove('active'));
        return;
      }
      currentPanel = panel;
      bottomPanel?.classList.add('bottom-panel-open');
      panelMap[panel]();
      document.querySelectorAll('.pnav-item').forEach(i => i.classList.remove('active'));
      item.classList.add('active');
    });
  });

  const handle = document.getElementById('bp-handle');
  if (handle) {
    handle.addEventListener('click', () => { bottomPanel?.classList.toggle('collapsed'); });
  }

  setupSaveButton();
  setupEndWorldButton();

  // 叙事初始化
  if (worldState.flow_count === 0) {
    const hasNarrative = narrativeHistory?.querySelector('.narrative-paragraph');
    if (!hasNarrative) {
      const btnIntro = document.getElementById('btn-intro');
      const introPrompt = document.getElementById('intro-prompt');
      if (introPrompt) introPrompt.style.display = '';
      if (btnIntro) {
        btnIntro.addEventListener('click', async () => {
          btnIntro.textContent = '世界初始化中...';
          btnIntro.disabled = true;
          showLoading();

          // 在叙事区显示进度
          const progressDiv = document.createElement('div');
          progressDiv.className = 'narrative-paragraph wf-progress-inline';
          progressDiv.innerHTML = '<div class="spinner" style="margin:0 0 8px"></div><p style="color:#6a8a7a;font-size:.75rem">Step 0/8 · 准备...</p>';
          narrativeHistory.appendChild(progressDiv);

          try {
            await initializeWorld(worldState, worldConfig, (step, detail) => {
              progressDiv.innerHTML = `<p style="color:#2a7a6a;font-size:.75rem;margin:2px 0">${step}</p><p style="color:#8a8a7a;font-size:.65rem">${detail}</p>`;
              btnIntro.textContent = step.split('·')[0]?.trim() || '初始化中...';
              narrativeHistory.scrollTop = narrativeHistory.scrollHeight;
            });
            const saved = await loadWorldState();
            if (saved) setWorldState({ ...worldState, ...saved });
            updateWFIndicator();
            // 移除进度条和按钮
            progressDiv.remove();
            btnIntro.style.display = 'none';
            if (introPrompt) introPrompt.style.display = 'none';
            // 生成开篇叙事
            await generateInitialNarrative();
          } catch (e) {
            console.error('[世界初始化] 失败:', e);
            progressDiv.remove();
            btnIntro.style.display = 'none';
            if (introPrompt) introPrompt.style.display = 'none';
            addNarrativeParagraph(`[系统提示] 初始化失败：${e.message}`, false);
          } finally {
            hideLoading();
          }
        });
      }
    }
  } else if (!narrativeHistory?.children.length) {
    await generateContinueNarrative();
  }
}

// ═══════════════════════════════════════════════════════════
//  生命周期
// ═══════════════════════════════════════════════════════════

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    saveNarrative();
    saveAppState({ slotId: currentSlotId }).catch(() => {});
    autoSave().catch(() => {});
  }
});

window.addEventListener('pagehide', () => {
  saveNarrative();
  saveAppState({ slotId: currentSlotId }).catch(() => {});
  autoSave().catch(() => {});
});

init().catch(err => {
  console.error('[game.js] 初始化失败:', err);
  hideLoading();
  if (narrativeHistory) {
    narrativeHistory.innerHTML = `<p style="color:#e06060">初始化失败：${err.message || '未知错误'}<br>请刷新页面重试。</p>`;
  }
});
