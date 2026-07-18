// ═══════════════════════════════════════════════════════════
//  chat.js — NPC 对话页面（聊天软件风格）
//  显示所有地图的 NPC，支持一对一对话和 NPC 状态查询
// ═══════════════════════════════════════════════════════════

import { xianxiaConfig } from '../data/xianxia.js';
import { loadAllCharacters, loadCharacter, saveCharacter, loadWorldState } from '../engine/db.js';
import { processMicroTurn } from '../engine/microLoop.js';
import { timeToString } from '../engine/time.js';
import { formatKLevel, formatPLevel } from '../engine/config.js';
import { fuzzyQuantity } from './state.js';

const playerId = 'CHAR_player';
const worldConfig = xianxiaConfig;
const K = (n) => formatKLevel(n, xianxiaConfig.mapping.k_level_names);
const P = (n) => formatPLevel(n, xianxiaConfig.mapping.p_level_names);

let allChars = [];
let activeNpcId = null;
let worldState = null;
let isSending = false;

// DOM 引用
const contactList = document.getElementById('contact-list');
const chatTopbar = document.getElementById('chat-topbar');
const chatAvatar = document.getElementById('chat-avatar');
const chatNameEl = document.getElementById('chat-name');
const chatTitle = document.getElementById('chat-title');
const chatProfile = document.getElementById('chat-profile');
const chatMsgs = document.getElementById('chat-msgs');
const chatInputRow = document.getElementById('chat-input-row');
const chatInput = document.getElementById('chat-input');
const chatLoading = document.getElementById('chat-loading');
const btnSend = document.getElementById('btn-send');

// ═══════════════════════════════════════════════════════════
//  初始化
// ═══════════════════════════════════════════════════════════

async function init() {
  worldState = await loadWorldState();
  if (!worldState) {
    contactList.innerHTML = '<p style="color:#8a8a7a;padding:20px;text-align:center">未找到世界数据，请先在游戏中进行初始化。</p>';
    return;
  }

  await refreshContacts();
}

async function refreshContacts() {
  allChars = await loadAllCharacters();
  allChars = allChars.filter(c => !c.is_player);
  renderContacts(allChars);
}

// ═══════════════════════════════════════════════════════════
//  渲染联系人列表
// ═══════════════════════════════════════════════════════════

function renderContacts(chars) {
  if (chars.length === 0) {
    contactList.innerHTML = '<p style="color:#5a7a9a;padding:20px;text-align:center">暂无角色</p>';
    return;
  }

  const locs = worldConfig.locations || [];
  contactList.innerHTML = chars.map(c => {
    const locName = locs.find(l => l.location_id === c.position.location_id)?.name || '未知';
    const statusClass = c.agent_state === 'active' ? 'active' : c.agent_state === 'dormant' ? 'dormant' : 'alert';
    const initial = c.name.charAt(0);
    return `
      <div class="chat-contact${activeNpcId === c.character_id ? ' active' : ''}"
           data-id="${c.character_id}" onclick="window._selectNpc('${c.character_id}')">
        <div class="chat-avatar">${initial}</div>
        <div class="chat-contact-info">
          <div class="chat-contact-name">${c.name}</div>
          <div class="chat-contact-title">${c.identity.title} · ${P(c.stats.p_level)}</div>
          <div class="chat-contact-loc">${locName}</div>
        </div>
        <div class="chat-status ${statusClass}"></div>
      </div>`;
  }).join('');
}

// 搜索过滤
window.filterContacts = function() {
  const query = (document.getElementById('search-input')?.value || '').toLowerCase();
  if (!query) { renderContacts(allChars); return; }
  const filtered = allChars.filter(c =>
    c.name.toLowerCase().includes(query) ||
    c.identity.title.toLowerCase().includes(query)
  );
  renderContacts(filtered);
};

// ═══════════════════════════════════════════════════════════
//  选择 NPC
// ═══════════════════════════════════════════════════════════

window._selectNpc = async function(npcId) {
  activeNpcId = npcId;
  const npc = allChars.find(c => c.character_id === npcId);
  if (!npc) return;

  // 更新高亮
  document.querySelectorAll('.chat-contact').forEach(el => el.classList.remove('active'));
  document.querySelector(`[data-id="${npcId}"]`)?.classList.add('active');

  // 显示聊天头
  chatTopbar.style.display = 'flex';
  chatAvatar.textContent = npc.name.charAt(0);
  chatNameEl.textContent = npc.name;
  chatTitle.textContent = `${npc.identity.title} · ${P(npc.stats.p_level)} · ${K(npc.identity.k_level)}`;

  // 显示 NPC 详细信息
  await renderNpcProfile(npc);

  // 显示对话历史
  renderConversations(npc);

  // 显示输入区
  chatInputRow.style.display = 'flex';
  chatInput.focus();
};

// ═══════════════════════════════════════════════════════════
//  渲染 NPC 详细信息
// ═══════════════════════════════════════════════════════════

async function renderNpcProfile(npc) {
  const locs = worldConfig.locations || [];
  const locName = locs.find(l => l.location_id === npc.position.location_id)?.name || '未知';
  const resources = worldConfig.resource_types || [];

  // 背包
  const invStr = npc.inventory.length > 0
    ? npc.inventory.map(r => {
        const def = resources.find(rt => rt.resource_type_id === r.resource_type_id);
        const name = def?.name || r.resource_type_id;
        const fq = fuzzyQuantity(r.quantity);
        return fq ? `${fq}${name}` : name;
      }).join('、')
    : '空';

  // 关系（对其他 NPC）
  // 获取玩家名字用于显示（玩家被过滤了，单独加载）
  const playerRel = npc.relationships.find(r => r.target_id === playerId);
  let playerName = '玩家';
  if (playerRel) {
    try {
      const pc = await loadCharacter(playerId);
      if (pc) playerName = pc.name;
    } catch { /* ignore */ }
  }
  const relStr = npc.relationships.length > 0
    ? npc.relationships.map(r => {
        if (r.target_id === playerId) return `${playerName}:好感${r.affinity}`;
        const target = allChars.find(c => c.character_id === r.target_id);
        return `${target?.name || r.target_id}:好感${r.affinity}`;
      }).join('、')
    : '暂无';

  // 目的
  const drivesStr = npc.drives.length > 0
    ? npc.drives.map(d => `「${d.description}」${Math.round(d.progress * 100)}%`).join(' | ')
    : '日常活动';

  // 对玩家的记忆
  const playerMems = (npc.player_conversation_memory || []).slice(-5);
  const memStr = playerMems.length > 0
    ? playerMems.map(m => m.summary).join('；')
    : '尚未交流';

  chatProfile.classList.add('show');
  chatProfile.innerHTML = `
    <div class="row"><span class="lbl">身份</span><span class="val">${npc.identity.title} · ${K(npc.identity.k_level)} · ${P(npc.stats.p_level)}</span></div>
    <div class="row"><span class="lbl">位置</span><span class="val">${locName}</span></div>
    <div class="row"><span class="lbl">状态</span><span class="val">HP ${npc.stats.hp}/${npc.stats.max_hp} | 战力 ${npc.stats.base_combat_power} | ${npc.agent_state === 'active' ? '活跃' : npc.agent_state === 'dormant' ? '休眠' : '警戒'}</span></div>
    <div class="row"><span class="lbl">随身</span><span class="val">${invStr}</span></div>
    <div class="row"><span class="lbl">心性</span><span class="val">${npc.permanent_memory.personality.speech_style} | 口头禅：${npc.permanent_memory.personality.quirks?.join('、') || '无'}</span></div>
    <div class="row"><span class="lbl">所欲</span><span class="val">${drivesStr}</span></div>
    <div class="row"><span class="lbl">人脉</span><span class="val">${relStr}</span></div>
    <div class="row"><span class="lbl">记忆</span><span class="val">${memStr}</span></div>
  `;
}

// ═══════════════════════════════════════════════════════════
//  渲染对话历史
// ═══════════════════════════════════════════════════════════

function renderConversations(npc) {
  const convs = npc.short_term_buffer.conversations || [];
  if (convs.length === 0) {
    chatMsgs.innerHTML = '<div class="chat-empty"><div class="icon">青云</div><div class="text" style="font-size:.8rem;margin-top:6px">暂无对话记录</div></div>';
    return;
  }

  const relevant = convs.filter(t =>
    t.speaker_id === playerId || t.speaker_id === npc.character_id
  );

  chatMsgs.innerHTML = relevant.map(t => {
    const isPlayer = t.speaker_id === playerId;
    const timeStr = t.timestamp ? timeToString(t.timestamp) : '';
    return `
      <div class="chat-msg ${isPlayer ? 'player' : 'npc'}">
        <div>${escapeHtml(t.content)}</div>
        ${timeStr ? `<span class="t">${timeStr}</span>` : ''}
      </div>`;
  }).join('');

  chatMsgs.scrollTop = chatMsgs.scrollHeight;
}

function escapeHtml(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ═══════════════════════════════════════════════════════════
//  发送消息
// ═══════════════════════════════════════════════════════════

window.sendChat = async function() {
  if (isSending) return;
  const input = chatInput.value.trim();
  if (!input || !activeNpcId || !worldState) return;

  isSending = true;
  chatInput.value = '';
  btnSend.disabled = true;
  chatLoading.style.display = 'flex';

  try {
    const result = await processMicroTurn(
      playerId, input, worldState, worldConfig, activeNpcId
    );

    // 刷新 NPC 数据
    const npc = await loadCharacter(activeNpcId);
    if (npc) {
      // 更新内存中的 NPC
      const idx = allChars.findIndex(c => c.character_id === activeNpcId);
      if (idx >= 0) allChars[idx] = npc;
      renderConversations(npc);
      await renderNpcProfile(npc);
    }

    // 同步玩家数据到联系人列表
    await refreshContacts();
    // 重新选中（因为 refreshContacts 重建了 DOM）
    document.querySelectorAll('.chat-contact').forEach(el => el.classList.remove('active'));
    document.querySelector(`[data-id="${activeNpcId}"]`)?.classList.add('active');
  } catch (e) {
    console.error('[chat] 发送失败:', e);
    chatMsgs.innerHTML += `<div class="chat-msg npc"><div>[系统] 发送失败：${e.message}</div></div>`;
  } finally {
    isSending = false;
    btnSend.disabled = false;
    chatLoading.style.display = 'none';
    chatInput.focus();
    chatMsgs.scrollTop = chatMsgs.scrollHeight;
  }
};

// ═══════════════════════════════════════════════════════════
//  初始化
// ═══════════════════════════════════════════════════════════

init().catch(err => {
  console.error('[chat] 初始化失败:', err);
  contactList.innerHTML = `<p style="color:#e06060;padding:20px;text-align:center">初始化失败：${err.message}</p>`;
});
