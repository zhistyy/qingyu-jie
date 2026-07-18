// 系统变更日志管理
// 记录每次叙事生成的系统层面变动：资源流转、关系变化、位置移动、HP、记忆等

const CHANGE_LOG_KEY = 'to-rpg_changelog';
const MAX_ENTRIES = 100; // 最多保留 100 条

export function createChangeLogManager() {
  function getAllEntries() {
    try {
      const raw = localStorage.getItem(CHANGE_LOG_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch { return []; }
  }

  function saveEntries(entries) {
    try {
      localStorage.setItem(CHANGE_LOG_KEY, JSON.stringify(entries.slice(-MAX_ENTRIES)));
    } catch { /* quota */ }
  }

  function addEntry(changeLogs, narrativeSummary, timeStr, flowNumber) {
    if (!changeLogs || changeLogs.length === 0) return;
    const entries = getAllEntries();
    entries.push({
      id: 'cl_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
      timestamp: Date.now(),
      timeStr: timeStr || '',
      flowNumber: flowNumber || 0,
      summary: (narrativeSummary || '').slice(0, 80),
      logs: changeLogs.map(l => String(l).slice(0, 200)), // 每条截断
    });
    saveEntries(entries);
  }

  function clearAll() {
    try { localStorage.removeItem(CHANGE_LOG_KEY); } catch { /* */ }
  }

  return { getAllEntries, addEntry, clearAll };
}

// 渲染变更日志面板
export function renderChangeLog(bpContent, worldConfig) {
  const manager = createChangeLogManager();
  const entries = manager.getAllEntries();

  if (entries.length === 0) {
    bpContent.innerHTML = '<p style="color:#8a8a7a;font-size:.75rem;padding:20px;text-align:center">暂无系统日志。进行一次行动后，变更日志将在此显示。</p>';
    return;
  }

  // 按时间倒序
  const sorted = [...entries].reverse();

  let html = '<h3 class="panel-section">系统变更日志</h3>';
  html += `<div style="font-size:.65rem;color:#8a8a7a;margin-bottom:8px">最近 ${sorted.length} 条记录</div>`;

  for (const entry of sorted) {
    const timeLabel = new Date(entry.timestamp).toLocaleTimeString('zh-CN');
    const flowTag = entry.flowNumber ? ` | 流#${entry.flowNumber}` : '';

    html += `<div class="change-log-entry">
      <div class="change-log-header" onclick="this.parentElement.classList.toggle('expanded')">
        <span class="change-log-chevron">▶</span>
        <span class="change-log-time">${timeLabel}${flowTag}</span>
        <span class="change-log-count">${entry.logs.length}条变更</span>
        <span class="change-log-summary">${escapeHtml(entry.summary)}</span>
      </div>
      <div class="change-log-body">`;

    for (const log of entry.logs) {
      let className = 'change-log-line';
      let icon = '◆';
      if (log.startsWith('[变更·资源]')) { className += ' cl-resource'; icon = '◆'; }
      else if (log.startsWith('[变更·关系]')) { className += ' cl-relation'; icon = '♥'; }
      else if (log.startsWith('[变更·移动]')) { className += ' cl-move'; icon = '➤'; }
      else if (log.startsWith('[变更·HP]')) { className += ' cl-hp'; icon = '✚'; }
      else if (log.startsWith('[变更·状态]')) { className += ' cl-state'; icon = '◉'; }
      else if (log.startsWith('[变更·记忆]')) { className += ' cl-memory'; icon = '◈'; }
      else if (log.startsWith('[变更·转移]')) { className += ' cl-transfer'; icon = '↔'; }
      else { className += ' cl-other'; icon = '·'; }

      html += `<div class="${className}"><span class="cl-icon">${icon}</span> ${escapeHtml(log)}</div>`;
    }

    html += `</div></div>`;
  }

  bpContent.innerHTML = html;
}

function escapeHtml(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
