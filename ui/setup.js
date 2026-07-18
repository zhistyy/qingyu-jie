// 青云界 · 游戏准备页面
import { $, RARITY_COLORS, RARITY_NAMES, saveAppState, loadAppState, formatTime } from './state.js';
import { initFromWorldCard, listSaveSlots, saveGameToSlot, loadGameFromSlot, deleteSaveSlot, loadWorldState, canDeleteCharacter, canDeleteLocation } from '../engine/db.js';
import { xianxiaConfig, initialWorldState } from '../data/xianxia.js';
import { setAPIKey, getAPIKey, MODEL_NAME, RES_SPIRIT_STONE, RES_PILL, RES_HEALING_PILL, RES_SPIRIT_CRYSTAL, RES_ANCIENT_FRAGMENT, RES_TALISMAN, RES_RATION, formatKLevel, formatPLevel } from '../engine/config.js';
import { seedPool, clearPool } from '../engine/pool.js';

const escapeHtml = (s) => typeof s === 'string' ? s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#039;') : s;

// ── K/P 等级映射（统一使用 engine/config.ts 的格式化函数） ──
const K_NAMES = xianxiaConfig.mapping.k_level_names;
const P_NAMES = xianxiaConfig.mapping.p_level_names;
const K_LEVEL = (k) => formatKLevel(k, K_NAMES);
const P_LEVEL = (p) => formatPLevel(p, P_NAMES);
const MAP = xianxiaConfig.mapping;

// ── 角色默认字段补全（AI生成的角色可能缺少字段） ──
const ZERO_TIME = { year: 0, season: '春', day: 1, timeOfDay: '卯时' };

function ensureCharDefaults(ch) {
  ch.is_player = false;
  if (!ch.stats) ch.stats = { p_level: 0, hp: 10, max_hp: 10, base_combat_power: 3, cultivation_progress: 0 };
  else {
    ch.stats.hp = ch.stats.hp ?? 10;
    ch.stats.max_hp = ch.stats.max_hp ?? ch.stats.hp ?? 10;
    ch.stats.p_level = ch.stats.p_level ?? 0;
    ch.stats.base_combat_power = ch.stats.base_combat_power ?? 3;
    ch.stats.cultivation_progress = ch.stats.cultivation_progress ?? 0;
  }
  if (!ch.position) ch.position = { location_id: worldConfig.locations[0]?.location_id || '', previous_location_id: '' };
  else ch.position.previous_location_id = ch.position.previous_location_id || ch.position.location_id;
  if (!ch.inventory) ch.inventory = [];
  if (!ch.permanent_memory) {
    ch.permanent_memory = {
      core_identity: ch.identity?.title || ch.name,
      personality: randomPersonality(),
      immutable_facts: [],
      knows_others: [],
    };
  }
  if (!ch.long_term_memory) ch.long_term_memory = { card_ids: [], total_count: 0, capacity: 50 };
  if (!ch.short_term_buffer) ch.short_term_buffer = { conversations: [], pending_events: [] };
  if (!ch.drives || ch.drives.length === 0) ch.drives = [{ type: 'maintain', description: '日常活动', priority: 0.3, progress: 0 }];
  if (!Array.isArray(ch.player_conversation_memory)) ch.player_conversation_memory = [];
  if (!ch.relationships) ch.relationships = [];
  if (!ch.faction_binding) ch.faction_binding = { faction_id: ch.identity?.faction_id || 'FAC_外门', loyalty: 50, contribution: 0, k_level: ch.identity?.k_level || 0 };
  if (!ch.schedule) ch.schedule = [{ time: '卯时', location_id: ch.position?.location_id || '', action: '日常' }];
  if (!ch.agent_state) ch.agent_state = 'active';
  if (!ch.last_known_positions) ch.last_known_positions = [];
  if (!ch.memory_mode) ch.memory_mode = 'summary';
  return ch;
}

// ═══════════════════════════════════════════════════════════
//  本地状态
// ═══════════════════════════════════════════════════════════

const worldConfig = xianxiaConfig;
let ws = { ...initialWorldState };
let _scaledEvents = null;
let currentSlotId = 0;
let hideBase = false;

// ═══════════════════════════════════════════════════════════
//  基底元素标记
// ═══════════════════════════════════════════════════════════

const BASE_LOC = xianxiaConfig.locations.map(l => l.location_id);
const BASE_FAC = xianxiaConfig.factions.map(f => f.faction_id);
const BASE_RES = xianxiaConfig.resource_types.map(r => r.resource_type_id);
const BASE_CHAR = xianxiaConfig.characters.filter(c => !c.is_player).map(c => c.character_id);
const BASE_CMD = (xianxiaConfig.preset_commands || []).map(c => c.command_id);
const BASE_ENM = (xianxiaConfig.enemies || []).map(m => m.enemy_id);
const BASE_EXCHANGE = new Set((xianxiaConfig.exchange_rates || []).map(r => r.from_resource + '→' + r.to_resource));
const BASE_RECIPES = new Set((xianxiaConfig.recipes || []).map(r => r.recipe_id));

function setHideBase(v) { hideBase = v; }

// ═══════════════════════════════════════════════════════════
//  NPC 地点唯一性校验
// ═══════════════════════════════════════════════════════════

/** 检查 NPC 是否出现在多个地点，返回冲突列表 [{npcId, npcName, locations}] */
function findNPCConflicts(config) {
  const npcMap = new Map(); // npcId → [{location_id, location_name}]
  for (const loc of config.locations) {
    for (const cid of (loc.present_characters || [])) {
      if (!npcMap.has(cid)) npcMap.set(cid, []);
      npcMap.get(cid).push({ location_id: loc.location_id, location_name: loc.name });
    }
  }
  const conflicts = [];
  for (const [npcId, locs] of npcMap) {
    if (locs.length > 1) {
      const ch = config.characters.find(c => c.character_id === npcId);
      conflicts.push({ npcId, npcName: ch?.name || npcId, locations: locs });
    }
  }
  return conflicts;
}

/** 获取 NPC 当前所在的地点 ID（如果已在某地点） */
function getNPCCurrentLocation(config, npcId) {
  for (const loc of config.locations) {
    if ((loc.present_characters || []).includes(npcId)) {
      return { location_id: loc.location_id, location_name: loc.name };
    }
  }
  return null;
}

/** 从所有地点中移除某个 NPC */
function removeNPCFromAllLocations(config, npcId) {
  for (const loc of config.locations) {
    loc.present_characters = (loc.present_characters || []).filter(id => id !== npcId);
  }
}

// ═══════════════════════════════════════════════════════════
//  删除保护
// ═══════════════════════════════════════════════════════════
//  设置列表渲染
// ═══════════════════════════════════════════════════════════

function refreshSetupLists() {
  // 更新计数
  const countEls = document.querySelectorAll('.setup-count');
  if (countEls.length >= 5) {
    countEls[0].textContent = `共${worldConfig.locations.length}个（${BASE_LOC.length}个基础）`;
    countEls[1].textContent = `共${worldConfig.characters.filter(c=>!c.is_player).length}个NPC（${BASE_CHAR.length}个基础）`;
    countEls[2].textContent = `共${worldConfig.factions.length}个（${BASE_FAC.length}个基础）`;
    countEls[3].textContent = `共${worldConfig.resource_types.length}种（${BASE_RES.length}种基础）`;
  }

  const card = (isBase, id, type, header, body) =>
    `<div class="setup-card"><div class="sc-header">${header}${isBase?' <span class="base-tag">[基础]</span>':''}${isBase?'':` <span class="del" onclick="window._delSetup('${type}','${id}')">✕</span>`}</div><div class="sc-body">${body}</div></div>`;

  // 地点
  const locs = worldConfig.locations.filter(l => !hideBase || !BASE_LOC.includes(l.location_id)).map(l => {
    const resStr = (l.resources||[]).slice(0,4).map(r => {
      const d = worldConfig.resource_types.find(rt => rt.resource_type_id === r.resource_type_id);
      return `${d?.name||r.resource_type_id}×${r.quantity}`;
    }).join('、') || '—';
    const npcStr = (l.present_characters||[]).map(cid => {
      const ch = worldConfig.characters.find(c => c.character_id === cid);
      return ch?.name||cid;
    }).join('、') || '—';
    const monStr = (l.present_enemies||[]).join('、') || '—';
    const ruleStr = l.access_rule ? `准入: ${l.access_rule.description}` : '';
    return card(BASE_LOC.includes(l.location_id), l.location_id, 'loc',
      `<strong>${escapeHtml(l.name)}</strong> <span class="sc-tag danger-${l.danger_level}">${l.danger_level}危</span>`,
      `<div>${escapeHtml(l.description)}</div><div class="sc-detail">环境 ${l.environment_modifier>0?'+':''}${l.environment_modifier} | 资源: ${resStr}</div><div class="sc-detail">NPC: ${npcStr}</div><div class="sc-detail">敌人: ${monStr}</div>${ruleStr?`<div class="sc-detail">${ruleStr}</div>`:''}`
    );
  }).join('');
  $('setup-locations').innerHTML = locs || '<span class="empty-text">(无)</span>';

  // 角色
  const chars = worldConfig.characters.filter(c => !c.is_player && (!hideBase || !BASE_CHAR.includes(c.character_id))).map(c => {
    const invStr = c.inventory.slice(0,5).map(r => {
      const d = worldConfig.resource_types.find(rt => rt.resource_type_id === r.resource_type_id);
      return `${d?.name||r.resource_type_id}×${r.quantity}`;
    }).join('、') || '—';
    const driveStr = c.drives.map(d => `${MAP.drive_type_names[d.type] || d.type}:${d.description}(${Math.round(d.progress*100)}%)`).join('<br>') || '—';
    const relStr = c.relationships.map(r => {
      const ch = worldConfig.characters.find(ch => ch.character_id === r.target_id);
      return `${ch?.name||r.target_id}:${r.affinity>0?'+':''}${r.affinity}`;
    }).join('、') || '—';
    const factStr = c.faction_binding ? `${worldConfig.factions.find(f=>f.faction_id===c.faction_binding.faction_id)?.name||c.faction_binding.faction_id} 忠诚${c.faction_binding.loyalty}` : '无';
    return card(BASE_CHAR.includes(c.character_id), c.character_id, 'char',
      `<strong>${escapeHtml(c.name)}</strong> <span class="sc-tag">${escapeHtml(c.identity.title)}</span><span class="p-level-tag p-level-${c.stats.p_level}">${P_LEVEL(c.stats.p_level)}</span><span class="sc-tag">${K_LEVEL(c.identity.k_level)}</span>`,
      `<div>${escapeHtml(c.permanent_memory.core_identity)}</div><div class="sc-detail">势力: ${factStr} | 类型: ${c.identity.character_type} | HP${c.stats.hp}/${c.stats.max_hp}</div><div class="sc-detail">战力: ${c.stats.base_combat_power} | 修炼: ${c.stats.cultivation_progress} | 位置: ${c.position.location_id}</div><div class="sc-detail">物品: ${invStr}</div><div class="sc-detail">目的:<br>${driveStr}</div><div class="sc-detail">关系: ${relStr}</div>`
    );
  }).join('');
  $('setup-characters').innerHTML = chars || '<span class="empty-text">(无)</span>';

  // 敌人
  const enmsEl = document.getElementById('setup-enemies');
  if (enmsEl) {
    const enms = (worldConfig.enemies || []).filter(m => !hideBase || !BASE_ENM.includes(m.enemy_id)).map(m => {
      const lootText = m.loot.map(l => {
        const def = worldConfig.resource_types.find(rt => rt.resource_type_id === l.resource_type_id);
        return `${def?.name||l.resource_type_id}×${l.quantity}`;
      }).join('、') || '—';
      return card(BASE_ENM.includes(m.enemy_id), m.enemy_id, "enm",
        `<strong>${escapeHtml(m.name)}</strong> <span class="sc-tag danger-${m.danger_level}">${m.danger_level}危</span> <span class="p-level-tag p-level-${m.p_level}">${P_LEVEL(m.p_level)}</span>`,
        `<div>${escapeHtml(m.description)}</div><div class="sc-detail">战力 ${m.combat_power} | HP ${m.hp} | 掉落: ${lootText}</div>`
      );
    }).join('') || '<span class="empty-text">(无)</span>';
    enmsEl.innerHTML = enms;
  }

  // 势力
  const facs = worldConfig.factions.filter(f => !hideBase || !BASE_FAC.includes(f.faction_id)).map(f => {
    const diploStr = Object.entries(f.diplomatic_states||{}).map(([k,v]) => {
      const fn = worldConfig.factions.find(ff=>ff.faction_id===k)?.name||k;
      return `${fn}: ${v}`;
    }).join('、') || '—';
    const interestsStr = f.core_interests.join('、');
    return card(BASE_FAC.includes(f.faction_id), f.faction_id, 'fac',
      `<strong>${escapeHtml(f.name)}</strong> <span class="sc-tag">${K_LEVEL(f.k_level)}</span>`,
      `<div class="sc-detail">核心利益: ${interestsStr}</div><div class="sc-detail">管辖地点: ${f.controlled_locations.join('、')||'—'}</div><div class="sc-detail">外交: ${diploStr}</div><div class="sc-detail">成员要求: ${f.member_requirements||'—'}</div>`
    );
  }).join('');
  $('setup-factions').innerHTML = facs || '<span class="empty-text">(无)</span>';

  // 资源
  const ress = worldConfig.resource_types.filter(r => !hideBase || !BASE_RES.includes(r.resource_type_id)).map(r => {
    return card(BASE_RES.includes(r.resource_type_id), r.resource_type_id, 'res',
      `<strong><span class="rarity-${r.rarity}">${escapeHtml(r.name)}</span></strong> <span class="sc-tag">${RARITY_NAMES[r.rarity]||r.rarity}</span> <span class="sc-tag">${MAP.resource_category_names[r.category]||r.category}</span>`,
      `<div>${escapeHtml(r.description||'—')}</div><div class="sc-detail">ID: ${r.resource_type_id} | 价值: ${r.base_value} | 可堆叠: ${r.stackable?'是':'否'}</div>`
    );
  }).join('');
  $('setup-resources').innerHTML = ress || '<span class="empty-text">(无)</span>';

  // 计数同步
  const rateCount = document.querySelector('#sp-rate .setup-count');
  if (rateCount) rateCount.textContent = `共${(worldConfig.exchange_rates||[]).length}条`;
  const recipeCount = document.querySelector('#sp-recipe .setup-count');
  if (recipeCount) recipeCount.textContent = `共${(worldConfig.recipes||[]).length}条`;
  const enmCount = document.querySelector('#sp-enm .setup-count');
  if (enmCount) enmCount.textContent = `共${(worldConfig.enemies||[]).length}种`;
}

// ═══════════════════════════════════════════════════════════
//  添加弹窗
// ═══════════════════════════════════════════════════════════

let _addType = '';
let _tempItems = []; // 通用临时资源列表（角色背包/地点资源/敌人掉落/势力金库/指令消耗产出等）

// ── 通用标签列表渲染 ──
function renderTagList(listId, items, labelFn) {
  const el = document.getElementById(listId);
  if (!el) return;
  if (items.length === 0) {
    el.innerHTML = '<span class="empty-text" style="font-size:.7rem">(暂未添加)</span>';
    return;
  }
  el.innerHTML = items.map((item, i) => {
    const label = labelFn(item);
    return `<span class="char-inv-tag">${label} <span class="del" onclick="window._removeTagItem('${listId}',${i})">✕</span></span>`;
  }).join('');
}

// 通用：渲染资源标签（resource_type_id → name）
function renderResTags(listId, items) {
  renderTagList(listId, items, item => {
    const def = worldConfig.resource_types.find(r => r.resource_type_id === item.resource_type_id);
    return `${def?.name || item.resource_type_id} ×${item.quantity}`;
  });
}

// 通用：从下拉+数量框添加资源项
window._addResItem = (listId, selId, qtyId) => {
  const resId = document.getElementById(selId)?.value;
  const qty = parseInt(document.getElementById(qtyId)?.value) || 1;
  if (!resId || qty < 1) return;
  if (!worldConfig.resource_types.some(r => r.resource_type_id === resId)) return;
  const data = _getActiveTagData(listId);
  if (!data) return;
  data.push({ resource_type_id: resId, quantity: qty });
  _renderActiveTags(listId);
};

// 通用：从下拉添加 ID 项（用于 NPC/敌人/地点等非资源选择）
window._addIdItem = (listId, selId) => {
  const val = document.getElementById(selId)?.value;
  if (!val) return;
  const data = _getActiveTagData(listId);
  if (!data) return;
  if (data.some(item => item.id === val)) return;
  data.push({ id: val });
  _renderActiveTags(listId);
};

// 通用：删除标签项（按 listId 维度）
window._removeTagItem = (listId, index) => {
  // 查找当前活跃的标签列表并移除对应项
  const activeData = _getActiveTagData(listId);
  if (activeData && index >= 0 && index < activeData.length) {
    activeData.splice(index, 1);
    _renderActiveTags(listId);
  }
};

// 标签数据映射
let _tagDataMap = {}; // { listId: { data: [], render: fn } }
function _registerTags(listId, dataArr, renderFn) {
  _tagDataMap[listId] = { data: dataArr, render: () => renderFn(listId, dataArr) };
  _tempItems = dataArr; // 同步通用引用
}
function _getActiveTagData(listId) { return _tagDataMap[listId]?.data; }
function _renderActiveTags(listId) { _tagDataMap[listId]?.render(); }
function _clearAllTagData() { _tagDataMap = {}; _tempItems = []; }

const ADDLABELS = { loc:'添加地点', char:'添加角色', mon:'添加敌人', fac:'添加势力', res:'添加资源', beh:'添加行为', cmd:'添加指令', rate:'添加兑换', recipe:'添加配方' };

function showAddForm(type) {
  _addType = type;
  const modal = document.getElementById('add-modal');
  const title = document.getElementById('add-modal-title');
  const body = document.getElementById('add-modal-body');
  if (!modal || !body) return;
  title.textContent = ADDLABELS[type] || '添加';
  modal.style.display = 'flex';

  const F = (html) => `<div class="add-modal-body">${html}</div>`;
  if (type === 'loc') {
    _clearAllTagData();
    const resOpts = worldConfig.resource_types.map(r => `<option value="${r.resource_type_id}">${r.name} (${RARITY_NAMES[r.rarity] || r.rarity})</option>`).join('');
    const npcOpts = worldConfig.characters.filter(c => !c.is_player).map(c => `<option value="${c.character_id}">${c.name}</option>`).join('');
    const enmOpts = (worldConfig.enemies || []).map(m => `<option value="${m.enemy_id}">${m.name}</option>`).join('');
    const locRes = [], locNpcs = [], locEnms = [];
    _registerTags('loc-res', locRes, renderResTags);
    _registerTags('loc-npc', locNpcs, (listId, items) => renderTagList(listId, items, item => {
      const c = worldConfig.characters.find(ch => ch.character_id === item.id);
      return c?.name || item.id;
    }));
    _registerTags('loc-enm', locEnms, (listId, items) => renderTagList(listId, items, item => {
      const m = (worldConfig.enemies || []).find(mm => mm.enemy_id === item.id);
      return m?.name || item.id;
    }));
    body.innerHTML = `
      <div class="add-modal-body">
        <div class="af-row"><input id="af-name" placeholder="地点名"><input id="af-desc" placeholder="描述"></div>
        <div class="af-row"><select id="af-danger"><option value="低">低危</option><option value="中">中危</option><option value="高">高危</option></select></div>
        ${_resPickerHTML('loc-res', 'loc-res-sel', 'loc-res-qty', resOpts, '地点资源分布（从已有资源库选取）')}
        ${npcOpts ? `<div class="char-inv-section"><div class="char-inv-header">常驻NPC（从已有角色选）</div><div id="loc-npc" class="char-inv-list"></div><div class="af-row"><select id="loc-npc-sel">${npcOpts}</select><button type="button" class="btn btn-sm" onclick="window._addIdItem('loc-npc','loc-npc-sel')">+</button></div></div>` : ''}
        ${enmOpts ? `<div class="char-inv-section"><div class="char-inv-header">出没敌人（从已有敌人选）</div><div id="loc-enm" class="char-inv-list"></div><div class="af-row"><select id="loc-enm-sel">${enmOpts}</select><button type="button" class="btn btn-sm" onclick="window._addIdItem('loc-enm','loc-enm-sel')">+</button></div></div>` : ''}
        <p class="setup-form-hint">中/高危地点会自动生成特产资源和守护兽。</p>
      </div>`;
    renderResTags('loc-res', locRes);
    renderTagList('loc-npc', locNpcs, item => { const c = worldConfig.characters.find(ch => ch.character_id === item.id); return c?.name || item.id; });
    renderTagList('loc-enm', locEnms, item => { const m = (worldConfig.enemies||[]).find(mm => mm.enemy_id === item.id); return m?.name || item.id; });
  } else if (type === 'char') {
    _clearAllTagData();
    const kOpts = K_NAMES.map((n,i) => `<option value="${i}">K${i} ${n}</option>`).join('');
    const pOpts = P_NAMES.map((n,i) => `<option value="${i}">P${i} ${n}</option>`).join('');
    const facOpts = worldConfig.factions.map(f => `<option value="${f.faction_id}">${f.name}</option>`).join('');
    const locOpts = worldConfig.locations.map(l => `<option value="${l.location_id}">${l.name}</option>`).join('');
    const driveOpts = Object.entries(MAP.drive_type_names).map(([k,v]) => `<option value="${k}">${v}</option>`).join('');
    const resOpts = worldConfig.resource_types.map(r => `<option value="${r.resource_type_id}">${r.name} (${RARITY_NAMES[r.rarity] || r.rarity})</option>`).join('');
    const charInv = [];
    _registerTags('char-inv', charInv, renderResTags);
    body.innerHTML = `
      <div class="add-modal-body">
        <div class="af-row"><input id="af-name" placeholder="角色名"><input id="af-title" placeholder="头衔"></div>
        <div class="af-row"><select id="af-klevel">${kOpts}</select><select id="af-char-type"><option value="修行者">修行者</option><option value="凡人">凡人</option></select><select id="af-plevel">${pOpts}</select></div>
        <div class="af-row"><select id="af-faction">${facOpts}</select><select id="af-location">${locOpts}</select></div>
        <div class="af-row"><input id="af-hp" placeholder="HP" type="number" value="10" min="1"><input id="af-power" placeholder="战力" type="number" value="3" min="0"><input id="af-cult-prog" placeholder="修炼进度" type="number" value="0" min="0"></div>
        ${_resPickerHTML('char-inv', 'char-inv-res', 'char-inv-qty', resOpts, '初始携带资源（从已有资源库选取）')}
        <div class="af-row"><select id="af-drive">${driveOpts}</select></div>
        <p class="setup-form-hint">所有下拉选项均引用当前世界已有数据，确保互相关联。</p>
      </div>`;
    renderResTags('char-inv', charInv);
  } else if (type === 'res') {
    body.innerHTML = F(`<input id="af-name" placeholder="资源名"><input id="af-id" placeholder="ID(如RES_xxx)"><select id="af-rarity"><option value="白">白</option><option value="绿">绿</option><option value="蓝">蓝</option><option value="紫">紫</option><option value="金">金</option><option value="红">红</option></select><select id="af-cat"><option value="material">材料</option><option value="consumable">消耗品</option><option value="currency">货币</option><option value="skill">技能书</option><option value="equipment">装备</option></select>`);
  } else if (type === 'fac') {
    _clearAllTagData();
    const kOpts = K_NAMES.map((n,i) => `<option value="${i}">K${i} ${n}</option>`).join('');
    const resOpts = worldConfig.resource_types.map(r => `<option value="${r.resource_type_id}">${r.name} (${RARITY_NAMES[r.rarity] || r.rarity})</option>`).join('');
    const locOpts = worldConfig.locations.map(l => `<option value="${l.location_id}">${l.name}</option>`).join('');
    const facTreasury = [], facLocs = [];
    _registerTags('fac-treasury', facTreasury, renderResTags);
    _registerTags('fac-locs', facLocs, (listId, items) => renderTagList(listId, items, item => {
      const l = worldConfig.locations.find(ll => ll.location_id === item.id);
      return l?.name || item.id;
    }));
    body.innerHTML = `
      <div class="add-modal-body">
        <div class="af-row"><input id="af-name" placeholder="势力名"><select id="af-k">${kOpts}</select></div>
        <input id="af-interests" placeholder="核心利益,逗号分隔">
        ${locOpts ? `<div class="char-inv-section"><div class="char-inv-header">管辖地点（从已有地点选）</div><div id="fac-locs" class="char-inv-list"></div><div class="af-row"><select id="fac-loc-sel">${locOpts}</select><button type="button" class="btn btn-sm" onclick="window._addIdItem('fac-locs','fac-loc-sel')">+</button></div></div>` : ''}
        ${_resPickerHTML('fac-treasury', 'fac-treasury-sel', 'fac-treasury-qty', resOpts, '金库资源（从已有资源库选取）')}
      </div>`;
    renderResTags('fac-treasury', facTreasury);
    renderTagList('fac-locs', facLocs, item => { const l = worldConfig.locations.find(ll => ll.location_id === item.id); return l?.name || item.id; });
  } else if (type === "enm") {
    _clearAllTagData();
    const resOpts = worldConfig.resource_types.map(r => `<option value="${r.resource_type_id}">${r.name} (${RARITY_NAMES[r.rarity] || r.rarity})</option>`).join('');
    const pOpts = P_NAMES.map((n,i) => `<option value="${i}">P${i} ${n}</option>`).join('');
    const monLoot = [];
    _registerTags('enm-loot', monLoot, renderResTags);
    body.innerHTML = `
      <div class="add-modal-body">
        <div class="af-row"><input id="af-name" placeholder="敌人名"><input id="af-id" placeholder="ID(如 ENM_xxx)"></div>
        <div class="af-row"><select id="af-danger"><option value="低">低危</option><option value="中">中危</option><option value="高">高危</option></select><select id="af-plevel">${pOpts}</select></div>
        <div class="af-row"><input id="af-hp" placeholder="HP" type="number" value="20"><input id="af-power" placeholder="战力" type="number" value="10"></div>
        <input id="af-desc" placeholder="描述">
        ${_resPickerHTML('enm-loot', 'enm-loot-sel', 'enm-loot-qty', resOpts, '击败掉落（从已有资源库选取）')}
      </div>`;
    renderResTags('enm-loot', monLoot);
  }
}

function closeModal() {
  const modal = document.getElementById('add-modal');
  if (modal) modal.style.display = 'none';
  _addType = '';
  _clearAllTagData();
}

// ── 通用资源选择器 HTML 工厂 ──
function _resPickerHTML(listId, selId, qtyId, resOpts, title) {
  return `
    <div class="char-inv-section">
      <div class="char-inv-header">${title}</div>
      <div id="${listId}" class="char-inv-list"></div>
      <div class="af-row"><select id="${selId}">${resOpts}</select><input id="${qtyId}" placeholder="数量" type="number" value="1" min="1" style="width:80px"><button type="button" class="btn btn-sm" onclick="window._addResItem('${listId}','${selId}','${qtyId}')">+</button></div>
    </div>`;
}

// ── 随机性格 ──
function randomPersonality() {
  const styles = ['接地气','文绉绉','江湖气','书卷气','乡土气'];
  const quirksPool = ['爱搓手','捋胡须','敲桌子','眯眼','咂嘴','踱步','叹气','自言自语','摇扇子','把玩玉佩'];
  return {
    formality: 3 + Math.floor(Math.random() * 7),
    talkativeness: 3 + Math.floor(Math.random() * 7),
    emotional_express: 3 + Math.floor(Math.random() * 7),
    speech_style: styles[Math.floor(Math.random() * styles.length)],
    quirks: [quirksPool[Math.floor(Math.random() * quirksPool.length)]],
  };
}

window._confirmAdd = async (type) => {
  const name = $('af-name')?.value?.trim(); if (!name) return;
  const ts = Date.now();
  if (type === 'loc') {
    const desc = $('af-desc')?.value || '';
    const danger = $('af-danger')?.value || '低';
    const id = 'LOC_' + ts;
    // 从标签系统读取用户选择的资源/NPC/敌人
    const locResData = _getActiveTagData('loc-res') || [];
    // 收集要添加的 NPC 列表
    const locNpcData = (_getActiveTagData('loc-npc') || []).map(i => i.id);
    // 先从其他地点移除这些 NPC（确保唯一性）
    for (const npcId of locNpcData) {
      removeNPCFromAllLocations(worldConfig, npcId);
    }
    const locEnmData = (_getActiveTagData('loc-enm') || []).map(i => i.id);
    const resources = locResData.map(item => ({
      resource_type_id: item.resource_type_id, quantity: item.quantity,
      last_updated: { year: 0, season: '春', day: 1, timeOfDay: '卯时' }, location_id: id,
    }));
    worldConfig.locations.push({
      location_id: id, name, danger_level: danger, description: desc,
      environment_modifier: 0, resources, present_characters: locNpcData, present_enemies: locEnmData,
    });
    // 自动生成特产资源（如果尚未在资源库中存在同名资源）
    const resId = 'RES_' + name.replace(/[^a-zA-Z\u4e00-\u9fff]/g, '') + '_' + ts;
    const resName = name + '特产';
    worldConfig.resource_types.push({ resource_type_id: resId, name: resName, category: 'material', rarity: danger === '高' ? '蓝' : danger === '中' ? '绿' : '白', base_value: 1, stackable: true, description: `来自${name}的特产资源。` });
    // 中高危险地点自动生成敌人
    if (danger === '中' || danger === '高') {
      const monId = 'ENM_' + name.replace(/[^a-zA-Z\u4e00-\u9fff]/g, '') + '_' + ts;
      const monPower = danger === '高' ? 25 : 15;
      const monHp = danger === '高' ? 60 : 40;
      const monPlevel = danger === '高' ? 2 : 1;
      if (!worldConfig.enemies) worldConfig.enemies = [];
      worldConfig.enemies.push({ enemy_id: monId, name: name + '守护兽', danger_level: danger, hp: monHp, combat_power: monPower, p_level: monPlevel, description: `守护${name}的凶兽。`, loot: [{ resource_type_id: resId, quantity: 2 }] });
    }
    _clearAllTagData();
  } else if (type === 'char') {
    const title = $('af-title')?.value || '未知';
    const faction = $('af-faction')?.value || worldConfig.factions[0]?.faction_id || 'FAC_外门';
    const locId = $('af-location')?.value || worldConfig.locations[0]?.location_id || '';
    const loc = worldConfig.locations.find(l => l.location_id === locId) || worldConfig.locations[0];
    if (!loc) { await systemAlert('无法添加', '请先添加至少一个地点。'); return; }
    const kLevel = parseInt($('af-klevel')?.value) || 0;
    const pLevel = parseInt($('af-plevel')?.value) || 0;
    const charType = $('af-char-type')?.value || '凡人';
    const hpVal = parseInt($('af-hp')?.value) || 10;
    const powerVal = parseInt($('af-power')?.value) || 3;
    const cultProg = parseInt($('af-cult-prog')?.value) || 0;
    const driveType = $('af-drive')?.value || 'maintain';
    const driveName = MAP.drive_type_names[driveType] || driveType;
    const id = 'CHAR_' + ts;
    const personality = randomPersonality();
    // 构建 inventory：从标签系统中读取
    const charInvData = _getActiveTagData('char-inv') || [];
    const inventory = charInvData.map(item => ({
      resource_type_id: item.resource_type_id,
      quantity: item.quantity,
      last_updated: { year: 0, season: '春', day: 1, timeOfDay: '卯时' },
      location_id: loc.location_id,
    }));
    worldConfig.characters.push({
      character_id: id, name, is_player: false,
      identity: { faction_id: faction, k_level: kLevel, title, character_type: charType },
      stats: { p_level: pLevel, hp: hpVal, max_hp: hpVal, base_combat_power: powerVal, cultivation_progress: cultProg },
      position: { location_id: loc.location_id, previous_location_id: loc.location_id },
      inventory,
      permanent_memory: { core_identity: name, personality, immutable_facts: [], knows_others: [] },
      long_term_memory: { card_ids: [], total_count: 0, capacity: 50 },
      short_term_buffer: { conversations: [], pending_events: [] },
      drives: [{ type: driveType, description: driveName, priority: 0.3, progress: 0 }],
      player_conversation_memory: [],
      relationships: [],
      faction_binding: { faction_id: faction, loyalty: 50, contribution: 0, k_level: kLevel },
      schedule: [{ time: '卯时', location_id: loc.location_id, action: '日常' }],
      agent_state: 'active', last_known_positions: [], memory_mode: 'summary',
    });
    // 确保 NPC 不会出现在两个地点：先从其他地点移除
    removeNPCFromAllLocations(worldConfig, id);
    loc.present_characters.push(id);
    _clearAllTagData();
  } else if (type === 'res') {
    const id = $('af-id')?.value || ('RES_' + ts);
    const rarity = $('af-rarity')?.value || '白';
    const cat = $('af-cat')?.value || 'material';
    worldConfig.resource_types.push({ resource_type_id: id, name, category: cat, rarity, base_value: 1, stackable: true, description: name });
    const giveInst = worldConfig.instruction_types.find(i => i.type === 'resource_give');
    if (giveInst && !giveInst.allowed_targets.includes(id)) giveInst.allowed_targets.push(id);
  } else if (type === 'fac') {
    const k = parseInt($('af-k')?.value) || 1;
    const interests = ($('af-interests')?.value || '自定义').split(',').map(s => s.trim()).filter(Boolean);
    const id = 'FAC_' + ts;
    const locData = (_getActiveTagData('fac-locs') || []).map(i => i.id);
    const treasuryData = _getActiveTagData('fac-treasury') || [];
    const treasury = treasuryData.map(item => ({
      resource_type_id: item.resource_type_id, quantity: item.quantity,
      last_updated: { year: 0, season: '春', day: 1, timeOfDay: '卯时' }, location_id: id,
    }));
    worldConfig.factions.push({ faction_id: id, name, k_level: k, controlled_locations: locData, core_interests: interests, treasury, diplomatic_states: {}, member_requirements: '无限制' });
  } else if (type === "enm") {
    const monId = $('af-id')?.value?.trim() || ('ENM_' + ts);
    const danger = $('af-danger')?.value || '低';
    const hp = parseInt($('af-hp')?.value) || 20;
    const power = parseInt($('af-power')?.value) || 10;
    const pLevel = parseInt($('af-plevel')?.value) || 0;
    const desc = $('af-desc')?.value || '';
    const lootData = _getActiveTagData('enm-loot') || [];
    const loot = lootData.map(item => ({ resource_type_id: item.resource_type_id, quantity: item.quantity }));
    if (!worldConfig.enemies) worldConfig.enemies = [];
    worldConfig.enemies.push({ enemy_id: monId, name, danger_level: danger, hp, combat_power: power, p_level: pLevel, description: desc, loot });
    _clearAllTagData();
  }
  closeModal();
  refreshSetupLists();
};

window._delSetup = async (type, id) => {
  if (type === 'loc' && (BASE_LOC.includes(id) || !canDeleteLocation(id, worldConfig.locations))) return;
  if (type === 'char' && (BASE_CHAR.includes(id) || id === 'CHAR_player')) return;
  if (type === 'char' && !BASE_CHAR.includes(id) && !(await canDeleteCharacter(id))) { await systemAlert('无法删除', '不能删除此角色：可能是最后一个NPC或修行者。'); return; }
  if (type === 'fac' && BASE_FAC.includes(id)) return;
  if (type === 'res' && BASE_RES.includes(id)) return;
  if (type === "enm" && BASE_ENM.includes(id)) return;
  if (type === 'loc') worldConfig.locations = worldConfig.locations.filter(l => l.location_id !== id);
  else if (type === 'char') worldConfig.characters = worldConfig.characters.filter(c => c.character_id !== id);
  else if (type === 'res') {
    worldConfig.resource_types = worldConfig.resource_types.filter(r => r.resource_type_id !== id);
    // 同步清理指令白名单中的该资源
    for (const it of worldConfig.instruction_types) {
      it.allowed_targets = it.allowed_targets.filter(t => t !== id);
    }
  }
  else if (type === 'fac') worldConfig.factions = worldConfig.factions.filter(f => f.faction_id !== id);
  else if (type === "enm") {
    if (BASE_ENM.includes(id)) return;
    worldConfig.enemies = (worldConfig.enemies || []).filter(m => m.enemy_id !== id);
  }
  refreshSetupLists();
};

// ═══════════════════════════════════════════════════════════
//  隐藏基础元素
// ═══════════════════════════════════════════════════════════

window._toggleHideBase = () => {
  setHideBase($('hide-base-toggle')?.checked || false);
  refreshSetupLists();
};

// 暴露给滑块 oninput 调用
window._refreshSetup = () => refreshSetupLists();

// ═══════════════════════════════════════════════════════════
//  存档系统
// ═══════════════════════════════════════════════════════════

async function renderSaveSlots() {
  const container = document.getElementById('save-slots');
  if (!container) return;
  try {
    const slots = await listSaveSlots();
    let html = '';
    for (let i = 0; i < slots.length; i++) {
      const slot = slots[i];
      const slotId = i + 1;
      const isCurrent = slotId === currentSlotId;
      if (slot) {
        html += `<div class="save-slot${isCurrent ? ' current' : ''}">
          <span class="save-slot-id">#${slotId}</span>
          <span class="save-slot-name" title="${slot.name}">${slot.name}</span>
          <span class="save-slot-time">${slot.game_time}</span>
          <span class="save-slot-flow">#${slot.flow_count}</span>
          <span class="save-slot-date">${formatTime(slot.saved_at)}</span>
          <button class="btn btn-primary btn-sm" onclick="window._useSlot(${slotId})">以此开始</button>
          <button class="btn btn-sm save-slot-del-btn" onclick="window._delSlot(${slotId})">删除</button>
        </div>`;
      } else {
        html += `<div class="save-slot empty">
          <span class="save-slot-id-empty">#${slotId}</span>
          <span class="save-slot-name-empty">空槽位</span>
          <button class="btn btn-primary btn-sm" onclick="window._startFresh(${slotId})">以此空白存档开始</button>
          <span style="color:#8a8a7a;font-size:0.6rem">（进入世界后可保存到此）</span>
        </div>`;
      }
    }
    container.innerHTML = html;
  } catch (e) {
    container.innerHTML = `<p class="save-error">读取存档列表失败：${e.message}</p>`;
  }
}

// ── 系统弹窗代替浏览器 confirm / alert ──
function systemConfirm(title, body) {
  return new Promise(resolve => {
    const modal = document.getElementById('confirm-modal');
    document.getElementById('confirm-modal-title').textContent = title;
    document.getElementById('confirm-modal-body').textContent = body || '';
    document.getElementById('btn-confirm-ok').style.display = '';
    document.getElementById('btn-confirm-cancel').style.display = '';
    modal.style.display = 'flex';
    document.getElementById('btn-confirm-ok').onclick = () => { modal.style.display = 'none'; resolve(true); };
    document.getElementById('btn-confirm-cancel').onclick = () => { modal.style.display = 'none'; resolve(false); };
    modal.onclick = (e) => { if (e.target === modal) { modal.style.display = 'none'; resolve(false); } };
  });
}

function systemAlert(title, body) {
  return new Promise(resolve => {
    const modal = document.getElementById('confirm-modal');
    document.getElementById('confirm-modal-title').textContent = title;
    document.getElementById('confirm-modal-body').textContent = body || '';
    document.getElementById('btn-confirm-ok').style.display = '';
    document.getElementById('btn-confirm-cancel').style.display = 'none';
    modal.style.display = 'flex';
    document.getElementById('btn-confirm-ok').onclick = () => { modal.style.display = 'none'; resolve(true); };
    modal.onclick = (e) => { if (e.target === modal) { modal.style.display = 'none'; resolve(true); } };
  });
}

window._useSlot = async (slotId) => {
  if (!(await systemConfirm('加载存档', `以存档槽位 #${slotId} 开始游戏？`))) return;
  try {
    const meta = await loadGameFromSlot(slotId);
    if (!meta) { await systemAlert('加载失败', '存档为空或损坏'); return; }
    currentSlotId = slotId;
    location.href = 'game.html';
  } catch (e) {
    await systemAlert('加载失败', e.message);
  }
};

// ── API Key 管理 ──
function initAPIKey() {
  const input = document.getElementById('apikey-input');
  const status = document.getElementById('apikey-status');
  if (!input || !status) return;

  // 加载已保存的 key
  const saved = getAPIKey();
  if (saved) {
    input.value = saved;
    status.textContent = '已保存';
    status.style.color = '#3a8a7a';
  }

  // 输入时更新状态
  input.addEventListener('input', () => {
    if (input.value.trim()) {
      status.textContent = '未保存';
      status.style.color = '#c4a45a';
    } else {
      status.textContent = '';
    }
  });

  // 保存按钮
  const saveBtn = document.getElementById('btn-save-apikey');
  if (saveBtn) {
    saveBtn.addEventListener('click', async () => {
      const key = input.value.trim();
      if (!key) return;

      // 验证连通性
      saveBtn.disabled = true;
      status.textContent = '验证中...';
      status.style.color = '#c4a45a';

      try {
        const response = await fetch('https://api.deepseek.com/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
          body: JSON.stringify({
            model: MODEL_NAME,
            messages: [{ role: 'user', content: 'ping' }],
            max_tokens: 1,
          }),
        });

        if (response.ok) {
          setAPIKey(key);
          status.textContent = '已连接';
          status.style.color = '#3a8a7a';
        } else {
          const errData = await response.json().catch(() => ({}));
          const errMsg = errData.error?.message || `HTTP ${response.status}`;
          status.textContent = `验证失败：${errMsg}`;
          status.style.color = '#c06050';
        }
      } catch (e) {
        status.textContent = `网络错误：${e.message}`;
        status.style.color = '#c06050';
      } finally {
        saveBtn.disabled = false;
      }
    });
  }
}

window._startFresh = async (slotId) => {
  // 校验 API Key —— 必须是已验证通过的 Key
  const savedKey = getAPIKey();
  if (!savedKey) {
    await systemAlert('缺少 API Key', '请先填写 DeepSeek API Key 并点击"保存"验证连通性。');
    return;
  }
  setAPIKey(savedKey);
  const status = document.getElementById('apikey-status');
  if (status) { status.textContent = '已连接'; status.style.color = '#3a8a7a'; }
  // 校验 NPC 地点唯一性
  const conflicts = findNPCConflicts(worldConfig);
  if (conflicts.length > 0) {
    const conflictStr = conflicts.map(c => `${c.npcName}：${c.locations.map(l => l.location_name).join('、')}`).join('\n');
    if (!(await systemConfirm('NPC 重复地点', `以下角色同时出现在多个地点，是否自动清理（保留首个出现的地点）？\n\n${conflictStr}`))) return;
    // 自动清理：保留第一个地点，从其余移除
    for (const c of conflicts) {
      const keepLoc = c.locations[0];
      for (const loc of c.locations.slice(1)) {
        const locDef = worldConfig.locations.find(l => l.location_id === loc.location_id);
        if (locDef) locDef.present_characters = (locDef.present_characters || []).filter(id => id !== c.npcId);
      }
    }
    refreshSetupLists();
  }

  if (!(await systemConfirm('开始新游戏', `以空白槽位 #${slotId} 开始新游戏？`))) return;
  currentSlotId = slotId;
  // 命石消费检查
  const k = parseInt(document.getElementById('pf-klevel')?.value || '1');
  const p = parseInt(document.getElementById('pf-plevel')?.value || '1');
  const kCost = KLEVEL_COST[k] || 0;
  const pCost = PLEVEL_COST[p] || 0;
  const totalCost = kCost + pCost;
  if (totalCost > 0) {
    const { getDestinyStones, spendDestiny } = await import('../engine/destiny');
    const balance = await getDestinyStones();
    if (balance < totalCost) {
      await systemAlert('命石不足', `当前身份+修为需要 ✦${totalCost} 命石，你只有 ✦${balance}。\n请降低身份层级或修为起点。`);
      return;
    }
    if (!(await systemConfirm('命石消费', `当前身份+修为需要消耗 ✦${totalCost} 命石（余额 ✦${balance}），确认使用？`))) return;
    const ok = await spendDestiny(totalCost, `创建角色 K${k} P${p}`);
    if (!ok) { await systemAlert('扣费失败', '命石消费异常，请重试。'); return; }
    // 刷新余额显示
    const el = document.getElementById('destiny-stones');
    if (el) { const newBal = await getDestinyStones(); el.textContent = `✦ ${newBal} 命石`; }
  }
  // 应用玩家身份配置
  applyPlayerConfig();
  // 先初始化世界数据，再跳转
  ws.world_flow_step_length_days = worldConfig.time_config.world_flow_step_days;
  ws.total_time_span = worldConfig.time_config.total_time_span_years;
  try {
    await initFromWorldCard({ worldState: ws, characters: worldConfig.characters, locations: worldConfig.locations, factions: worldConfig.factions });
    // 初始化资源池种子
    await clearPool();
    await seedPool({
      RES_灵石: 200,
      RES_灵草: 100,
      RES_丹药: 20,
      RES_铁矿: 50,
      RES_干粮: 30,
      RES_基础功法: 5,
      RES_基础剑法: 3,
      RES_疗伤丹: 10,
    }, ws.game_time);
    // 新世界开始：清除旧聊天记录文件 + 叙事缓存
    try {
      const opfsRoot = await navigator.storage.getDirectory();
      const dir = await opfsRoot.getDirectoryHandle('to-rpg', { create: true });
      await dir.removeEntry('chat_messages.json');
    } catch { /* 文件不存在，无需处理 */ }
    // 清除叙事历史（新世界从零开始）
    try { localStorage.removeItem('to-rpg_narrative'); } catch {}
    // 清除旧聊天记录 localStorage 缓存
    try { localStorage.removeItem('to-rpg_chat'); } catch {}
  } catch (e) {
    await systemAlert('初始化失败', e.message);
    return;
  }
  location.href = 'game.html';
};

window._manualSaveToSlot = async (slotId) => {
  const name = prompt('给这个存档起个名字：', `存档 ${slotId}`);
  if (name === null) return;
  try {
    await saveGameToSlot(slotId, name || `存档 ${slotId}`);
    currentSlotId = slotId;
    await renderSaveSlots();
  } catch (e) {
    await systemAlert('保存失败', e.message);
  }
};

window._delSlot = async (slotId) => {
  if (!(await systemConfirm('删除存档', `确认删除槽位 #${slotId} 的存档？`))) return;
  try {
    await deleteSaveSlot(slotId);
    if (currentSlotId === slotId) currentSlotId = 0;
    await renderSaveSlots();
  } catch (e) {
    await systemAlert('删除失败', e.message);
  }
};

// ═══════════════════════════════════════════════════════════
//  玩家身份表单
// ═══════════════════════════════════════════════════════════

// K层级 → 初始物品映射
const K_INVENTORY = {
  0: [],  // 杂役：无
  1: [     // 外门弟子
    { resource_type_id: RES_SPIRIT_STONE, quantity: 10 },
    { resource_type_id: RES_RATION, quantity: 3 },
  ],
  2: [     // 内门弟子
    { resource_type_id: RES_SPIRIT_STONE, quantity: 50 },
    { resource_type_id: RES_PILL, quantity: 3 },
    { resource_type_id: RES_RATION, quantity: 5 },
  ],
  3: [     // 真传弟子
    { resource_type_id: RES_SPIRIT_STONE, quantity: 200 },
    { resource_type_id: RES_PILL, quantity: 10 },
    { resource_type_id: RES_SPIRIT_CRYSTAL, quantity: 2 },
  ],
  4: [     // 执事
    { resource_type_id: RES_SPIRIT_STONE, quantity: 500 },
    { resource_type_id: RES_PILL, quantity: 20 },
    { resource_type_id: RES_SPIRIT_CRYSTAL, quantity: 5 },
    { resource_type_id: RES_TALISMAN, quantity: 3 },
  ],
  5: [     // 长老
    { resource_type_id: RES_SPIRIT_STONE, quantity: 1000 },
    { resource_type_id: RES_SPIRIT_CRYSTAL, quantity: 20 },
    { resource_type_id: RES_PILL, quantity: 50 },
    { resource_type_id: RES_TALISMAN, quantity: 10 },
    { resource_type_id: RES_ANCIENT_FRAGMENT, quantity: 2 },
  ],
  6: [     // 掌门
    { resource_type_id: RES_SPIRIT_STONE, quantity: 5000 },
    { resource_type_id: RES_SPIRIT_CRYSTAL, quantity: 50 },
    { resource_type_id: RES_PILL, quantity: 100 },
    { resource_type_id: RES_TALISMAN, quantity: 20 },
    { resource_type_id: RES_ANCIENT_FRAGMENT, quantity: 5 },
  ],
};

// K层级 → 默认修为起点
const K_PLEVEL = { 0: 0, 1: 1, 2: 1, 3: 2, 4: 2, 5: 3, 6: 4 };

// 命石成本
const KLEVEL_COST = { 0: 0, 1: 0, 2: 1, 3: 3, 4: 5, 5: 8, 6: 12 };
const PLEVEL_COST = { 0: 0, 1: 0, 2: 2, 3: 5, 4: 10 };

function renderPlayer() {
  // 异步加载命石余额
  updatePlayerCosts();
  // 势力选项
  const facSelect = document.getElementById('pf-faction');
  facSelect.innerHTML = worldConfig.factions
    .map(f => `<option value="${f.faction_id}">${f.name}</option>`)
    .join('');

  // 地点选项
  const locSelect = document.getElementById('pf-location');
  locSelect.innerHTML = worldConfig.locations
    .map(l => `<option value="${l.location_id}">${l.name}</option>`)
    .join('');

  // K层级选项
  const kSelect = document.getElementById('pf-klevel');
  kSelect.innerHTML = K_NAMES
    .map((name, i) => `<option value="${i}">${name}（K${i}）</option>`)
    .join('');

  // P层级选项
  const pSelect = document.getElementById('pf-plevel');
  pSelect.innerHTML = P_NAMES
    .map((name, i) => `<option value="${i}">${name}（P${i}）</option>`)
    .join('');

  // 读取当前玩家配置
  const player = worldConfig.characters.find(c => c.is_player);
  if (player) {
    document.getElementById('pf-name').value = (player.name && player.name !== '你') ? player.name : '';
    document.getElementById('pf-title').value = player.identity?.title || '外门弟子';
    facSelect.value = player.identity?.faction_id || worldConfig.factions[0]?.faction_id || '';
    locSelect.value = player.position?.location_id || worldConfig.locations[0]?.location_id || '';
    kSelect.value = String(player.identity?.k_level ?? 1);
    pSelect.value = String(player.stats?.p_level ?? 1);
    document.getElementById('pf-charType').value = player.identity?.character_type || '修行者';
    document.getElementById('pf-wf-trigger').value = worldConfig.world_flow_trigger_count || 5;
  }

  // 初始物品展示
  updatePlayerInventory();

  // K层级变化时，更新推荐修为和物品
  kSelect.addEventListener('change', () => {
    const k = parseInt(kSelect.value);
    const recommendedP = K_PLEVEL[k] ?? 1;
    pSelect.value = String(Math.min(recommendedP, P_NAMES.length - 1));
    updatePlayerInventory();
    updatePlayerCosts();
  });
  pSelect.addEventListener('change', () => updatePlayerCosts());
}

async function updatePlayerCosts() {
  const k = parseInt(document.getElementById('pf-klevel')?.value || '1');
  const p = parseInt(document.getElementById('pf-plevel')?.value || '1');
  const kCost = KLEVEL_COST[k] || 0;
  const pCost = PLEVEL_COST[p] || 0;

  const kEl = document.getElementById('pf-kcost');
  const pEl = document.getElementById('pf-pcost');

  kEl.textContent = kCost > 0 ? `✦${kCost}` : '免费';
  kEl.style.color = kCost > 0 ? '#c4a45a' : '#8a8a7a';
  pEl.textContent = pCost > 0 ? `✦${pCost}` : '免费';
  pEl.style.color = pCost > 0 ? '#c4a45a' : '#8a8a7a';

  // 显示余额
  try {
    const { getDestinyStones } = await import('../engine/destiny');
    const balance = await getDestinyStones();
    const totalCost = kCost + pCost;
    if (totalCost > balance) {
      kEl.textContent += ` (不足，余额✦${balance})`;
      kEl.style.color = '#c06050';
    }
  } catch {}
}

function updatePlayerInventory() {
  const k = parseInt(document.getElementById('pf-klevel').value);
  const items = K_INVENTORY[k] || [];
  const container = document.getElementById('pf-inventory');
  
  if (items.length === 0) {
    container.innerHTML = '<span style="color:#8a8a7a;font-size:.7rem">无初始物品</span>';
    return;
  }

  container.innerHTML = items.map(item => {
    const def = worldConfig.resource_types.find(r => r.resource_type_id === item.resource_type_id);
    const name = def?.name || item.resource_type_id;
    return `<span class="pf-inv-tag">${name} ×${item.quantity}</span>`;
  }).join('');
}

/** 从表单读取配置并更新玩家角色数据 */
function applyPlayerConfig() {
  const player = worldConfig.characters.find(c => c.is_player);
  if (!player) return;

  const name = document.getElementById('pf-name')?.value?.trim() || '林玄';
  const title = document.getElementById('pf-title')?.value?.trim() || '外门弟子';
  const factionId = document.getElementById('pf-faction')?.value;
  const locationId = document.getElementById('pf-location')?.value;
  const kLevel = parseInt(document.getElementById('pf-klevel')?.value || '1');
  const pLevel = parseInt(document.getElementById('pf-plevel')?.value || '1');
  const charType = document.getElementById('pf-charType')?.value || '修行者';
  const wfTrigger = parseInt(document.getElementById('pf-wf-trigger')?.value || '5');

  // 写入世界流触发间隔配置
  worldConfig.world_flow_trigger_count = Math.max(1, Math.min(50, wfTrigger || 5));

  player.name = name;
  player.identity.title = title;
  player.identity.faction_id = factionId || player.identity.faction_id;
  player.identity.k_level = kLevel;
  player.identity.character_type = charType;
  player.position.location_id = locationId || player.position.location_id;
  player.position.previous_location_id = locationId || player.position.location_id;
  player.stats.p_level = pLevel;

  // 根据修为计算 HP
  const hpMap = { 0: 10, 1: 30, 2: 60, 3: 120, 4: 250 };
  player.stats.hp = hpMap[pLevel] || 30;
  player.stats.max_hp = hpMap[pLevel] || 30;

  // 战力 = 基础战力表
  const powerMap = { 0: 3, 1: 10, 2: 30, 3: 80, 4: 200 };
  player.stats.base_combat_power = powerMap[pLevel] || 10;
  player.stats.cultivation_progress = 0;

  // 初始物品
  const kItems = K_INVENTORY[kLevel] || [];
  player.inventory = kItems.map(item => ({
    resource_type_id: item.resource_type_id,
    quantity: item.quantity,
    last_updated: { year: 0, season: '春', day: 1, timeOfDay: '卯时' },
    location_id: 'CHAR_player',
  }));

  // 确保所在地点的 present_characters 包含玩家
  const targetLoc = worldConfig.locations.find(l => l.location_id === locationId);
  if (targetLoc && !targetLoc.present_characters.includes('CHAR_player')) {
    targetLoc.present_characters.push('CHAR_player');
  }

  // 更新 faction_binding
  player.faction_binding.faction_id = factionId || player.faction_binding.faction_id;
  player.faction_binding.k_level = kLevel;

  // 根据身份更新核心认知
  const facName = worldConfig.factions.find(f => f.faction_id === factionId)?.name || '无势力';
  player.permanent_memory.core_identity = `一个${title}，怀揣着问道长生的梦想踏上修行之路。`;
}

// ═══════════════════════════════════════════════════════════
//  初始化 - event listener 绑定
// ═══════════════════════════════════════════════════════════

async function init() {
  // 渲染玩家表单
  renderPlayer();

  // 添加按钮
  $('btn-add-loc').addEventListener('click', () => showAddForm('loc'));
  $('btn-add-char').addEventListener('click', () => showAddForm('char'));
  $('btn-add-res').addEventListener('click', () => showAddForm('res'));
  $('btn-add-fac').addEventListener('click', () => showAddForm('fac'));
  $('btn-add-beh')?.addEventListener('click', () => showAddForm('beh'));
  $('btn-add-enm')?.addEventListener('click', () => showAddForm("enm"));

  // Tab 切换
  document.querySelectorAll('.setup-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      closeModal(); // 切换 Tab 时自动关闭弹窗
      const targetTab = tab.dataset.tab;
      const targetPage = document.getElementById('sp-' + targetTab);
      if (!targetPage) return;
      targetPage.style.display = 'block';
      document.querySelectorAll('.setup-tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.setup-page').forEach(p => { if (p !== targetPage) p.style.display = 'none'; });
      tab.classList.add('active');
      targetPage.classList.add('active');
    });
  });

  // Tab 滚动箭头（移动端横向滚动辅助）
  const tabsContainer = document.getElementById('setup-tabs');
  const arrowL = document.getElementById('tabs-arrow-l');
  const arrowR = document.getElementById('tabs-arrow-r');
  if (tabsContainer && arrowL && arrowR) {
    const updateArrows = () => {
      arrowL.classList.toggle('show', tabsContainer.scrollLeft > 2);
      arrowR.classList.toggle('show', tabsContainer.scrollLeft + tabsContainer.clientWidth < tabsContainer.scrollWidth - 2);
    };
    tabsContainer.addEventListener('scroll', updateArrows);
    arrowL.addEventListener('click', () => tabsContainer.scrollBy({ left: -140, behavior: 'smooth' }));
    arrowR.addEventListener('click', () => tabsContainer.scrollBy({ left: 140, behavior: 'smooth' }));
    setTimeout(updateArrows, 100);
    window.addEventListener('resize', updateArrows);
  }

  // 弹窗确认/取消
  document.getElementById('btn-add-confirm')?.addEventListener('click', () => { if (_addType) window._confirmAdd(_addType); });
  document.getElementById('btn-add-cancel')?.addEventListener('click', closeModal);
  document.getElementById('add-modal')?.addEventListener('click', (e) => { if (e.target.id === 'add-modal') closeModal(); });

  // 切换隐藏基础
  $('hide-base-toggle')?.addEventListener('change', () => {
    setHideBase($('hide-base-toggle')?.checked || false);
    refreshSetupLists();
  });

  // 进入世界按钮 — 自动使用第一个空白存档槽位
  $('btn-start-game')?.addEventListener('click', async () => {
    // 找到第一个空白槽位
    let targetSlot = 1;
    try {
      const slots = await listSaveSlots();
      for (let i = 0; i < slots.length; i++) {
        if (!slots[i]) { targetSlot = i + 1; break; }
      }
    } catch {}
    await window._startFresh(targetSlot);
  });

  // 存档tab切换时刷新列表
  const saveTab = document.querySelector('.setup-tab[data-tab="save"]');
  if (saveTab) {
    saveTab.addEventListener('click', () => {
      renderSaveSlots();
    });
  }

  // 命石tab切换时刷新
  const destinyTab = document.querySelector('.setup-tab[data-tab="destiny"]');
  if (destinyTab) {
    destinyTab.addEventListener('click', () => {
      renderDestiny();
    });
  }

  // 初始渲染：激活第一个 Tab 对应的页面
  const firstTab = document.querySelector('.setup-tab.active');
  if (firstTab) {
    const pageId = 'sp-' + firstTab.dataset.tab;
    const page = document.getElementById(pageId);
    if (page) {
      page.classList.add('active');
      page.style.display = 'block';
    }
  }
  refreshSetupLists();
  renderDestinyInit();

  // API Key 初始化
  initAPIKey();
}

// ── 命石系统 ──
async function renderDestinyInit() {
  const { getDestinyStones } = await import('../engine/destiny');
  const stones = await getDestinyStones();
  const el = document.getElementById('destiny-stones');
  if (el) el.textContent = `✦ ${stones} 命石`;
}

async function renderDestiny() {
  const { getDestinyStones, spendDestiny, DESTINY_SHOP } = await import('../engine/destiny');
  const stones = await getDestinyStones();
  const bal = document.getElementById('destiny-balance');
  if (bal) bal.textContent = `命石余额：✦ ${stones}`;
  const el = document.getElementById('destiny-stones');
  if (el) el.textContent = `✦ ${stones} 命石`;

  const shop = document.getElementById('destiny-shop');
  if (!shop) return;
  shop.innerHTML = DESTINY_SHOP.map(item => {
    const canBuy = stones >= item.cost;
    return `<div class="setup-card">
      <div class="sc-header">
        <strong>${item.name}</strong> <span class="sc-tag" style="color:#c4a45a">✦${item.cost}</span>
        <button class="btn btn-sm" ${canBuy ? '' : 'disabled'} onclick="window._buyDestiny('${item.id}')" style="margin-left:auto">${canBuy ? '购买' : '不足'}</button>
      </div>
      <div class="sc-body"><div>${item.description}</div></div>
    </div>`;
  }).join('');
}

window._buyDestiny = async (itemId) => {
  const { DESTINY_SHOP, spendDestiny } = await import('../engine/destiny');
  const item = DESTINY_SHOP.find(i => i.id === itemId);
  if (!item) return;
  // 购买确认
  if (!(await systemConfirm('购买命石强化', `确认消耗 ✦${item.cost} 命石购买「${item.name}」？\n${item.description}`))) return;
  const ok = await spendDestiny(item.cost, `购买: ${item.name}`);
  if (!ok) { await systemAlert('命石不足', '你的命石不够，多经历几个世界再来吧。'); return; }
  // 立即应用增强到当前世界配置
  item.apply(worldConfig.characters);
  await systemAlert('购买成功', `已获得「${item.name}」，进入新世界时生效。`);
  renderDestiny();
};

init();
