// 叙事历史管理 —— 从 game.js 提取
// 管理叙事段落的序列化/持久化/渲染

const NARRATIVE_STORAGE_KEY = 'to-rpg_narrative';

export function createNarrativeManager(narrativeHistory, state) {
  const { getInteractionCount, setInteractionCount,
          getLastSummary, setLastSummary,
          escapeHtml, sendMessage } = state;

  function serializeNarrative() {
    return JSON.stringify({
      html: narrativeHistory?.innerHTML || '',
      summary: getLastSummary(),
      interactionCount: getInteractionCount(),
    });
  }

  function restoreNarrative() {
    try {
      const raw = localStorage.getItem(NARRATIVE_STORAGE_KEY);
      if (!raw) return;
      const data = JSON.parse(raw);
      if (data.html) narrativeHistory.innerHTML = data.html;
      if (data.summary) setLastSummary(data.summary);
      if (typeof data.interactionCount === 'number') setInteractionCount(data.interactionCount);
      narrativeHistory.scrollTop = narrativeHistory.scrollHeight;
    } catch { /* ignore */ }
  }

  function saveNarrative() {
    try {
      localStorage.setItem(NARRATIVE_STORAGE_KEY, serializeNarrative());
    } catch { /* ignore */ }
  }

  function clearNarrative() {
    try { localStorage.removeItem(NARRATIVE_STORAGE_KEY); } catch { /* ignore */ }
    narrativeHistory.innerHTML = '';
    setLastSummary('');
    setInteractionCount(0);
  }

  // 添加叙事段落
  function addNarrativeParagraph(text, isWorldFlow) {
    const div = document.createElement('div');
    div.className = isWorldFlow ? 'narrative-paragraph narrative-worldflow' : 'narrative-paragraph';

    const cleanText = (text || '').replace(/^#+\s*.*$/gm, '').trim();
    const escaped = escapeHtml(cleanText);
    const formatted = escaped.split('\n').filter(Boolean).map(p => `<p>${p}</p>`).join('');
    div.innerHTML = formatted;

    narrativeHistory.appendChild(div);
    narrativeHistory.scrollTop = narrativeHistory.scrollHeight;
    saveNarrative();
  }

  return { restoreNarrative, saveNarrative, clearNarrative, addNarrativeParagraph };
}
