import type { MemoryCard, CharacterInstance, GameTime, ConversationTurn, PlayerConversationMemory } from './types';
import { loadCharacter, saveCharacter, loadMemoryCards, saveMemoryCard } from './db';
import { saveAPILog } from './db';
import { callDeepSeek } from './agent';
import { timeToString } from './time';
import { getCurrentFlowNumber } from './agent';

// 创建记忆卡片
export function createMemoryCard(
  title: string, summary: string, timestamp: GameTime,
  importance: number, linkedChars: string[], tags: string[] = []
): MemoryCard {
  return {
    id: `mem_${Date.now()}_${Math.random().toString(36).slice(2,8)}`,
    timestamp, title, summary: summary.slice(0, 50),
    tags, links: [], linked_characters: linkedChars,
    importance: Math.min(1, Math.max(0, importance)), archived: false,
  };
}

// 压缩长期记忆（超过容量上限时）
export async function compressMemory(ch: CharacterInstance): Promise<void> {
  const limit = ch.long_term_memory.capacity;
  const allCards = await loadMemoryCards(ch.character_id);
  const activeCards = allCards.filter(c => !c.archived);

  if (activeCards.length <= limit) return;

  // 弱链接合并：扫描重叠标签>50%且共享关联角色的卡片对，合并
  for (let i = 0; i < activeCards.length; i++) {
    if (activeCards[i].archived) continue;
    for (let j = i + 1; j < activeCards.length; j++) {
      if (activeCards[j].archived) continue;
      const a = activeCards[i];
      const b = activeCards[j];
      const tagOverlap = a.tags.filter(t => b.tags.includes(t)).length;
      const minLen = Math.min(a.tags.length, b.tags.length);
      if (minLen === 0) continue;
      const overlapRatio = tagOverlap / minLen;
      if (overlapRatio > 0.5) {
        const sharedChars = a.linked_characters.filter(c => b.linked_characters.includes(c));
        if (sharedChars.length > 0) {
          // 合并：保留高重要性卡片，合并摘要和标签/人物集
          if (a.importance >= b.importance) {
            a.summary = a.summary + '；' + b.summary;
            a.tags = [...new Set([...a.tags, ...b.tags])];
            a.linked_characters = [...new Set([...a.linked_characters, ...b.linked_characters])].filter((id): id is string => !!id && id !== '');
            b.archived = true;
            await saveMemoryCard(b);
          } else {
            b.summary = b.summary + '；' + a.summary;
            b.tags = [...new Set([...a.tags, ...b.tags])];
            b.linked_characters = [...new Set([...a.linked_characters, ...b.linked_characters])].filter((id): id is string => !!id && id !== '');
            a.archived = true;
            await saveMemoryCard(a);
          }
        }
      }
    }
  }
  // 过滤掉已被弱链接合并归档的卡片
  const remainingCards = activeCards.filter(c => !c.archived);

  // 策略1：归档低重要性卡片
  const sorted = remainingCards.sort((a, b) => b.importance - a.importance);
  const keep = sorted.slice(0, limit);
  const archive = sorted.slice(limit);

  for (const card of archive) {
    card.archived = true;
    await saveMemoryCard(card);
  }

  ch.long_term_memory.card_ids = keep.map(c => c.id);
  ch.long_term_memory.total_count = keep.length;
  await saveCharacter(ch);
}

// 处理短期缓冲 → 长期记忆（AI 摘要压缩）
export async function processShortTermBuffer(
  ch: CharacterInstance, time: GameTime
): Promise<MemoryCard[]> {
  const events = ch.short_term_buffer.pending_events;
  const conversations = ch.short_term_buffer.conversations;

  // 如果缓冲为空，无需处理
  if (events.length === 0 && conversations.length === 0) return [];

  // ── 降级处理：当缓冲超过 20 条时，先尝试简单合并保底 ──
  const totalItems = events.length + conversations.length;
  if (totalItems > 20) {
    // 不用 AI，直接取前 5 条事件的摘要拼接成 1 张降级卡片
    const topEvents = events.slice(0, 5);
    const topConvs = conversations.slice(0, 5);
    const mergedSummary = [
      ...topEvents.map(e => e.summary.slice(0, 40)),
      ...topConvs.map(t => t.content.slice(0, 40)),
    ].join('；').slice(0, 120) || '累积经历';

    // 收集涉及的字符
    const allCharIds = [...new Set([
      ...topEvents.flatMap(e => (e.involved_characters || [])),
    ])].filter((id): id is string => !!id && id !== '');

    const fallbackCard = createMemoryCard(
      '近期累积经历', mergedSummary, time, 0.3,
      allCharIds, ['累积', '降级']
    );

    await saveMemoryCard(fallbackCard);
    ch.long_term_memory.card_ids.push(fallbackCard.id);
    ch.long_term_memory.total_count = ch.long_term_memory.card_ids.length;
    await saveCharacter(ch);

    // 清空已处理的缓冲（保留最近 5 条以防万一）
    ch.short_term_buffer.pending_events = events.slice(-5);
    ch.short_term_buffer.conversations = conversations.slice(-5);
    await saveCharacter(ch);

    // 缓冲超限已降级合并处理
    return [fallbackCard];
  }

  // 构建给 AI 的摘要输入
  const eventLines = events.map(e => `- [事件] ${e.summary}`);
  const convLines = conversations.map(t =>
    `- [对话] ${t.speaker_id === ch.character_id ? '我' : t.speaker_id}: ${t.content.slice(0, 60)}`
  );
  const allLines = [...eventLines, ...convLines].join('\n');

  const timeStr = timeToString(time);

  // 在 try 外部声明，确保 catch 可访问
  let savedCardIds: string[] = [];
  let oldCardIds: string[] = [];

  const prompt = `你是角色 ${ch.name}（${ch.permanent_memory.core_identity}）的记忆助手。以下是角色本轮经历的事件和对话，请将其压缩为最多 5 张记忆卡片。

经历内容：
${allLines}

输出格式（每行一张记忆卡片）：
[记忆] 标题（10字以内）| 摘要（30字以内）| 重要性（0-1，数字越大越重要）| 标签（逗号分隔）

要求：
- 合并相关事件，保留关键信息
- 重要性根据事件对角色影响判断（关系变化>资源得失>日常琐事）
- 不超过 5 张卡片
- 如果内容很少，可以输出 1-2 张卡片`;

  try {
    const { text } = await callDeepSeek(prompt, '请压缩记忆。', {
      type: 'memory_compression',
      gameTime: timeStr,
      characterName: ch.name,
      flowNumber: getCurrentFlowNumber(),
    }, 400);

    const newCards: MemoryCard[] = [];
    const lines = text.split('\n').filter((l: string) => l.trim());

    for (const line of lines) {
      const match = line.match(/^\[记忆\]\s*(.+?)\s*\|\s*(.+?)\s*\|\s*([0-9.]+)\s*\|\s*(.+)$/);
      if (match) {
        const [, title, summary, impStr, tagsStr] = match;
        const importance = Math.min(1, Math.max(0, parseFloat(impStr) || 0.3));
        const tags = tagsStr.split(/[,，]/).map(t => t.trim()).filter(Boolean);
        const allCharIds = [...new Set([
          ...events.flatMap(e => (e.involved_characters || [])),
        ])].filter((id): id is string => id && id.length > 0 && id !== ''); // 过滤空字符串/undefined/null
        const card = createMemoryCard(
          title.trim() || summary.slice(0, 10),
          summary.trim().slice(0, 50),
          time, importance,
          allCharIds, tags
        );
        newCards.push(card);
      }
    }

    // 如果 AI 没输出有效卡片，回退到简单摘要
    if (newCards.length === 0) {
      const summary = events.map(e => e.summary.slice(0, 30)).join('；').slice(0, 50) || '日常经历';
      newCards.push(createMemoryCard('近事', summary, time, 0.3, [], ['日常']));
    }

    // 保存记忆卡片（先持久化卡片，再清空缓冲）
    savedCardIds = [];
    for (const card of newCards) {
      await saveMemoryCard(card);
      savedCardIds.push(card.id);
    }

    // 先保存角色（含更新后的 card_ids 但缓冲尚未清空）
    oldCardIds = [...ch.long_term_memory.card_ids];
    ch.long_term_memory.card_ids.push(...savedCardIds);
    ch.long_term_memory.total_count = ch.long_term_memory.card_ids.length;
    await saveCharacter(ch);

    // 卡片和角色都保存成功后，才清空短期缓冲
    ch.short_term_buffer.conversations = [];
    ch.short_term_buffer.pending_events = [];
    await saveCharacter(ch);

    return newCards;
  } catch (e) {
    // 失败时恢复 card_ids，保留缓冲数据供下轮重试
    console.error('[memory] processShortTermBuffer 失败:', e);
    if (savedCardIds.length > 0) {
      ch.long_term_memory.card_ids = oldCardIds;
      ch.long_term_memory.total_count = oldCardIds.length;
    }
    return [];
  }
}

// 压缩 NPC 与玩家的对话记忆（保留细节，独立于普通记忆压缩）
export async function compressPlayerConversations(
  ch: CharacterInstance, playerId: string, time: GameTime
): Promise<PlayerConversationMemory[]> {
  // 找到玩家说话前后 1 轮内的 NPC 回应（时间戳相邻）
  const playerConvTurns = ch.short_term_buffer.conversations.filter(t =>
    t.speaker_id === playerId
  );

  const relevantConvs = ch.short_term_buffer.conversations.filter(t => {
    if (t.speaker_id === playerId) return true;
    const idx = ch.short_term_buffer.conversations.indexOf(t);
    if (idx > 0 && ch.short_term_buffer.conversations[idx - 1].speaker_id === playerId) return true;
    if (idx < ch.short_term_buffer.conversations.length - 1 && ch.short_term_buffer.conversations[idx + 1].speaker_id === playerId) return true;
    return false;
  });

  if (relevantConvs.length === 0) return [];

  // 构建对话摘要输入
  const convText = relevantConvs.map(t =>
    `[${t.speaker_id === playerId ? '玩家' : (t.speaker_id === ch.character_id ? ch.name : t.speaker_id)}] ${t.content.slice(0, 100)}`
  ).join('\n');

  const timeStr = timeToString(time);

  const prompt = `你是 ${ch.name} 的记忆助手。以下是角色本轮与「玩家」的对话记录。请将其压缩为 1-3 条与玩家的互动记忆，保留细节比普通记忆更多（摘要可达 100 字），捕捉对话中的关键信息和情感。

对话记录：
${convText}

输出格式（每行一条）：
[玩家记忆] 摘要（60-150字，保留对话关键信息和情感细节）| 重要性（0-1）

要求：
- 关注玩家说了什么，你对玩家的印象有何变化
- 注意玩家询问过什么信息、表达了什么意图
- 保留情感色彩（友好/疏远/好奇/敌意等）
- 如果对话很少，输出 1 条即可`;

  try {
    const { text } = await callDeepSeek(prompt, '请压缩玩家对话记忆。', {
      type: 'memory_compression',
      gameTime: timeStr,
      characterName: ch.name,
      flowNumber: getCurrentFlowNumber(),
    }, 500);

    const results: PlayerConversationMemory[] = [];
    const lines = text.split('\n').filter((l: string) => l.trim());

    for (const line of lines) {
      const match = line.match(/^\[玩家记忆\]\s*(.+?)\s*\|\s*([0-9.]+)$/);
      if (match) {
        const [, summary, impStr] = match;
        results.push({
          id: `pcm_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          timestamp: { ...time },
          summary: summary.trim().slice(0, 150),
          importance: Math.min(1, Math.max(0, parseFloat(impStr) || 0.5)),
        });
      }
    }

    // 回退：如果 AI 没输出，手动创建一条
    if (results.length === 0 && relevantConvs.length > 0) {
      const manual = playerConvTurns.map(t => t.content.slice(0, 40)).join('；').slice(0, 100);
      if (manual) {
        results.push({
          id: `pcm_${Date.now()}_fallback`,
          timestamp: { ...time },
          summary: `与玩家交谈：${manual}`,
          importance: 0.4,
        });
      }
    }

    return results;
  } catch (e) {
    console.error('[memory] compressPlayerConversations 失败:', e);
    return [];
  }
}

// 检索相关记忆（用于 Prompt 拼接）
export async function retrieveMemories(
  ch: CharacterInstance, currentLocation: string, otherCharId: string | null
): Promise<MemoryCard[]> {
  const allCards = await loadMemoryCards(ch.character_id);
  const active = allCards.filter(c => !c.archived);

  // 时效降权：以最新卡片的年份为参考，计算衰减因子
  const latestYear = active.reduce((max, c) => Math.max(max, c.timestamp.year), 0);

  // 相关性排序：标签匹配 + 链接匹配 + 时效性
  const scored = active.map(card => {
    const matchingTags = card.tags.filter(t => t === currentLocation || t.includes(currentLocation)).length;
    const tagScore = (matchingTags / Math.max(1, card.tags.length)) * 0.4;
    const linkScore = (card.linked_characters?.includes(otherCharId || '') ? 1 : 0) * 0.3;
    const recencyFactor = 1 - Math.min(0.5, (latestYear - card.timestamp.year) * 0.1);
    const recencyScore = recencyFactor * 0.3;
    const score = tagScore + linkScore + recencyScore;
    return { card, score };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, 10).map(s => s.card);
}

// 切换记忆模式（摘要/详细）
export async function toggleMemoryMode(characterId: string, mode: 'summary' | 'detailed'): Promise<void> {
  const ch = await loadCharacter(characterId);
  if (!ch) throw new Error(`角色未找到: ${characterId}`);
  ch.memory_mode = mode;
  await saveCharacter(ch);
}
