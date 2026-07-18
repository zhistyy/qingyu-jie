// ═══════════════════════════════════════════════════════════
//  青云界 · API 日志查看器
//  独立页面 — 无需游戏状态加载
// ═══════════════════════════════════════════════════════════

import { getAllAPILogs, deleteAllAPILogs } from '../engine/db.js';

// ── 类型显示名映射 ──
const TYPE_LABELS = {
  conversation: '对话',
  world_narrative: '世界叙事',
  narrative_outline: '提纲',
  narrative_writing: '写作',
  narrative_parsing: '解析',
  report: '报告',
  diplomacy: '外交',
  state_orchestration: '状态编排',
  init_world: '初始化',
  combat: '战斗',
  creation_certify: '创造认证',
  personal_action: '人物决策',
  memory_compression: '记忆压缩',
  drive_check: '目的消解',
  player_summary: '玩家总结',
  action_parser: '行动解析',
};

const FILTER_TYPES = ['all', 'conversation', 'world_narrative', 'narrative_outline', 'narrative_writing', 'narrative_parsing', 'diplomacy', 'state_orchestration', 'report', 'personal_action', 'other'];
const FILTER_LABELS = { all: '全部', conversation: '对话', world_narrative: '世界叙事', narrative_outline: '提纲', narrative_writing: '写作', narrative_parsing: '解析', diplomacy: '外交', state_orchestration: '状态编排', report: '报告', personal_action: '人物决策', other: '其他' };
const OTHER_TYPES = new Set(['init_world', 'combat', 'creation_certify', 'memory_compression', 'drive_check', 'player_summary', 'action_parser']);

// 短输出类型：响应直接呈现在卡片上
const COMPACT_TYPES = new Set(['personal_action', 'memory_compression', 'drive_check', 'player_summary', 'action_parser']);

// ── 状态 ──
let allLogs = [];
let activeFilter = 'all';

// ── 工具函数 ──
function escapeHtml(s) {
  if (!s) return '';
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function formatTime(ts) {
  const d = new Date(ts);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function formatDuration(ms) {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function groupLabel(type) {
  return TYPE_LABELS[type] || type;
}

// ── 按世界流分组（以 flow_number 变化为间隔） ──
function clusterLogsByTime(logs) {
  if (!logs.length) return [];
  const sorted = [...logs].sort((a, b) => a.timestamp - b.timestamp);
  const groups = [];
  let currentGroup = [];
  let lastFlow = undefined;

  for (const log of sorted) {
    const fn = log.flow_number;
    // flow_number 变化时，开启新分组
    if (fn !== lastFlow && currentGroup.length > 0) {
      groups.push({ flowNum: lastFlow, group: currentGroup });
      currentGroup = [];
    }
    currentGroup.push(log);
    lastFlow = fn;
  }
  // 最后一组
  if (currentGroup.length > 0) {
    groups.push({ flowNum: lastFlow, group: currentGroup });
  }

  // 最新分组在前，组内按时间从旧到新
  return groups.reverse();
}

function getGroupLabel(flowNum, group) {
  if (flowNum === undefined || flowNum === null) return '自由游玩';
  if (flowNum === 0) return '初始化';
  return `世界流 #${flowNum}`;
}

// ── 确认弹窗 ──
function systemConfirm(title, body) {
  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.className = 'modal show';
    overlay.style.cssText = 'display:flex;';
    overlay.innerHTML = `
      <div class="modal-content" style="text-align:center">
        <h2>${escapeHtml(title)}</h2>
        <p style="text-align:center">${escapeHtml(body)}</p>
        <div style="display:flex;gap:10px;justify-content:center;margin-top:16px">
          <button class="btn" id="confirm-cancel">取消</button>
          <button class="btn btn-danger" id="confirm-ok">确认</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    overlay.querySelector('#confirm-cancel').onclick = () => { overlay.remove(); resolve(false); };
    overlay.querySelector('#confirm-ok').onclick = () => { overlay.remove(); resolve(true); };
    overlay.addEventListener('click', e => { if (e.target === overlay) { overlay.remove(); resolve(false); } });
  });
}

// ═══════════════════ 渲染 ═══════════════════

function getFilteredLogs() {
  if (activeFilter === 'all') return allLogs;
  if (activeFilter === 'other') return allLogs.filter(l => OTHER_TYPES.has(l.type) || !TYPE_LABELS[l.type]);
  return allLogs.filter(l => l.type === activeFilter);
}

function renderSummary(logs) {
  const total = logs.length;
  const totalTokens = logs.reduce((s, l) => s + (l.response?.tokenUsage?.total_tokens || 0), 0);
  const totalDuration = logs.reduce((s, l) => s + (l.durationMs || 0), 0);
  const avgDuration = total ? Math.round(totalDuration / total) : 0;
  const errors = logs.filter(l => l.error).length;

  document.getElementById('api-summary').innerHTML = `
    <div class="api-summary-item"><div class="val">${total}</div><div class="lbl">总调用</div></div>
    <div class="api-summary-item"><div class="val">${totalTokens.toLocaleString()}</div><div class="lbl">总 Token</div></div>
    <div class="api-summary-item"><div class="val">${avgDuration}ms</div><div class="lbl">平均耗时</div></div>
    <div class="api-summary-item"><div class="val" style="color:${errors ? '#c06050' : '#4ac4a8'}">${errors}</div><div class="lbl">错误</div></div>
  `;
}

function renderFilterBar() {
  const container = document.getElementById('api-filter-bar');
  container.innerHTML = FILTER_TYPES.map(type => {
    const label = FILTER_LABELS[type];
    const count = type === 'all' ? allLogs.length
      : type === 'other' ? allLogs.filter(l => OTHER_TYPES.has(l.type) || !TYPE_LABELS[l.type]).length
      : allLogs.filter(l => l.type === type).length;
    return `<button class="api-filter-chip${activeFilter === type ? ' active' : ''}" data-type="${type}">
      ${label}<span style="font-size:.55rem;margin-left:4px;opacity:${activeFilter === type ? '.8' : '.6'}">${count}</span>
    </button>`;
  }).join('');

  container.querySelectorAll('.api-filter-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      activeFilter = chip.dataset.type;
      renderAll();
    });
  });
}

function renderCards(filteredLogs) {
  const content = document.getElementById('api-content');
  const groups = clusterLogsByTime(filteredLogs);

  if (!groups.length) {
    content.innerHTML = `<div class="api-empty">
      <span class="empty-icon">◇</span>
      <span class="empty-text">暂无 API 调用日志</span>
    </div>`;
    return;
  }

  content.innerHTML = groups.map(({ flowNum, group }) => {
    const firstTime = formatTime(group[group.length - 1].timestamp);
    const lastTime = formatTime(group[0].timestamp);
    const label = getGroupLabel(flowNum, group);

    let html = '' +
      '<div class="api-flow-group">' +
        '<div class="api-flow-group-header">' +
          '<span class="flow-chevron">▼</span>' +
          `<span class="flow-icon">${typeof flowNum === 'number' ? flowNum : '~'}</span>` +
          `<span>${label}</span>` +
          `<span style="color:#8a8a7a;font-size:.63rem;margin-left:4px">${lastTime} — ${firstTime}</span>` +
          `<span class="flow-count">${group.length} 次调用</span>` +
        '</div>' +
        '<div class="api-flow-group-body">' +
          group.map(log => renderCard(log)).join('') +
        '</div>' +
      '</div>';
    return html;
  }).join('');

  // 绑定流组折叠/展开
  content.querySelectorAll('.api-flow-group-header').forEach(header => {
    header.addEventListener('click', () => {
      header.parentElement.classList.toggle('flow-collapsed');
    });
  });

  // 绑定卡片展开/折叠
  content.querySelectorAll('.api-card-header').forEach(header => {
    header.addEventListener('click', (e) => {
      e.stopPropagation();
      header.parentElement.classList.toggle('expanded');
    });
  });
}

function renderCard(log) {
  const typeLabel = TYPE_LABELS[log.type] || log.type;
  const typeClass = log.type;
  const hasError = !!log.error;
  const tokenTotal = log.response?.tokenUsage?.total_tokens || 0;
  const isCompact = COMPACT_TYPES.has(log.type);
  const compactPreview = isCompact && log.response?.text
    ? `<div class="api-compact-preview">${escapeHtml(log.response.text)}</div>`
    : '';

  return `<div class="api-log-card" data-id="${log.id}" data-type="${log.type}">
    ${compactPreview}
    <div class="api-card-header">
      <span class="api-dot ${hasError ? 'dot-err' : 'dot-ok'}"></span>
      <span class="api-type-badge badge-${typeClass}">${typeLabel}</span>
      ${log.characterName ? `<span class="api-card-name" title="${escapeHtml(log.characterName)}">${escapeHtml(log.characterName)}</span>` : ''}
      <span class="api-card-stats">
        ${tokenTotal ? `<span class="stat-item"><span class="stat-val">${tokenTotal.toLocaleString()}</span>T</span>` : ''}
        <span class="stat-item"><span class="stat-val">${formatDuration(log.durationMs)}</span></span>
        <span class="api-card-chevron">▼</span>
      </span>
    </div>
    <div class="api-card-body">
      <div class="prompt-label">System Prompt（${log.request.systemPrompt.length} 字）</div>
      <pre>${escapeHtml(log.request.systemPrompt)}</pre>
      <div class="prompt-label">User Prompt（${log.request.userPrompt.length} 字）</div>
      <pre>${escapeHtml(log.request.userPrompt)}</pre>
      ${log.response ? `
        <div class="prompt-label">响应 · ${log.response.text.length} 字${log.response.tokenUsage ? ` · Input ${log.response.tokenUsage.prompt_tokens} / Output ${log.response.tokenUsage.completion_tokens}` : ''}</div>
        <pre>${escapeHtml(log.response.text)}</pre>
      ` : ''}
      ${log.error ? `
        <div class="prompt-label" style="color:#c06050">错误</div>
        <pre style="color:#e08080">${escapeHtml(log.error)}</pre>
      ` : ''}
    </div>
    <div class="api-card-footer">
      <span>${formatTime(log.timestamp)}</span>
      <span class="game-time" title="游戏时间">◆ ${escapeHtml(log.gameTime)}</span>
    </div>
  </div>`;
}

function renderAll() {
  const filtered = getFilteredLogs();
  renderSummary(filtered);
  renderFilterBar();
  renderCards(filtered);
}

// ═══════════════════ 初始化 ═══════════════════

async function init() {
  try {
    allLogs = await getAllAPILogs();
  } catch (e) {
    console.error('加载 API 日志失败:', e);
    allLogs = [];
  }

  renderAll();

  // ── 全部清除按钮 ──
  document.getElementById('btn-clear-all').addEventListener('click', async () => {
    if (!allLogs.length) return;
    const ok = await systemConfirm('清空日志', `确认清空全部 ${allLogs.length} 条 API 调用日志？此操作不可撤销。`);
    if (!ok) return;
    try {
      await deleteAllAPILogs();
      allLogs = [];
      activeFilter = 'all';
      renderAll();
    } catch (e) {
      console.error('清空日志失败:', e);
    }
  });

  // ── 返回游戏按钮 ──
  document.getElementById('btn-back').addEventListener('click', () => {
    if (document.referrer && document.referrer.includes('game.html')) {
      window.history.back();
    } else {
      window.location.href = 'game.html';
    }
  });
}

init();
