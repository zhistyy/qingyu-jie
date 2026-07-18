// 转化层 —— 玩家行动总结 AI
// 在世界流开始时调用，将玩家本轮操作汇总为一段叙事化摘要
// 输出链入世界叙事、信息派发、NPC 个人行动等各层
import type { PlayerActionRecord, WorldState, WorldCardConfig } from '../engine/types';
import { timeToString } from '../engine/time';
import { getCurrentFlowNumber, callDeepSeek } from '../engine/agent';

const MAX_INPUT_ACTIONS = 30; // 防止 Token 溢出，最多取最近30 条
export async function summarizePlayerActions(
  actions: PlayerActionRecord[],
  worldState: WorldState,
  config: WorldCardConfig,
  playerName: string,
): Promise<string> {
  if (actions.length === 0) return '';

  const timeStr = timeToString(worldState.game_time);

  // 限制输入条数，取最近的
  const limited = actions.length > MAX_INPUT_ACTIONS
    ? actions.slice(-MAX_INPUT_ACTIONS)
    : actions;

  // 列出操作（用 detail 更完整）
  const actionList = limited.map((a, i) =>
    `${i + 1}. [${a.type}] ${a.targetName ? '与' + a.targetName + '：' : ''}：${a.detail || a.summary}`
  ).join('\n');

  const prompt = `你是一个世界叙事助手。请将以下玩家在本次世界流间隔内的行动，汇总为一段100-200 字的叙事化摘要。用第三人称，武侠小说风格，简洁有力。
玩家：${playerName}
时间：${timeStr}
世界：${config.world_name}

玩家本轮行动记录（共 ${actions.length} 条${actions.length > MAX_INPUT_ACTIONS ? `，显示最近${MAX_INPUT_ACTIONS} 条` : ''}）：
${actionList}

请输出一段连贯的叙事摘要，描述玩家这段时间做了什么、与谁互动、取得了什么结果。用第三人称（"他"或玩家名）。不要分点列出，要连贯通顺。`;

  try {
    const { text } = await callDeepSeek(
      '你是一个玩家行动总结AI。将零散的行动记录汇总为简洁的叙事摘要。只输出摘要文本，不要其他内容。',
      prompt,
      {
        type: 'player_summary',
        gameTime: timeStr,
        characterName: playerName,
        flowNumber: getCurrentFlowNumber(),
      },
      400,
      0.5,
    );
    return text || fallbackSummary(limited);
  } catch (e: any) {
    console.error('[玩家行动总结AI] 调用失败:', e.message);
    return fallbackSummary(limited);
  }
}

// ── 降级摘要：不依赖 AI，按类型分组拼接 ──
function fallbackSummary(actions: PlayerActionRecord[]): string {
  const byType: Record<string, string[]> = {};
  for (const a of actions) {
    if (!byType[a.type]) byType[a.type] = [];
    byType[a.type].push(a.summary);
  }

  const parts: string[] = [];
  const typeLabels: Record<string, string> = {
    conversation: '与人交谈',
    command: '执行指令',
    combat: '战斗',
    move: '移动探索',
    trade: '交易',
    gift: '送礼',
    collect: '采集资源',
    cultivate: '修炼成长',
    other: '其他行动',
  };

  for (const [type, summaries] of Object.entries(byType)) {
    if (summaries.length === 1) {
      parts.push(summaries[0]);
    } else {
      const label = typeLabels[type] || type;
      parts.push(`${label}${summaries.length}次`);
    }
  }

  return parts.join('；') || '玩家在本轮间隙中按部就班地活动。';
}
