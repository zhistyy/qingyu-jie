// 转化层 —— 战斗 AI（语C式回合）
// 从 engine/agent.ts 提取

import type { CharacterInstance, WorldState, WorldCardConfig } from '../engine/types';
import { timeToString } from '../engine/time';

import { callDeepSeek } from '../engine/agent';
import { formatKLevel, formatPLevel } from '../engine/config';

function getGearSummary(ch: CharacterInstance, config: WorldCardConfig): string {
  return ch.inventory.filter(r => 
    config.resource_types.find(rt => rt.resource_type_id === r.resource_type_id)?.category === 'equipment' ||
    config.resource_types.find(rt => rt.resource_type_id === r.resource_type_id)?.category === 'skill'
  ).map(r => {
    const def = config.resource_types.find(rt => rt.resource_type_id === r.resource_type_id);
    return def?.name || r.resource_type_id;
  }).join('、') || '无';
}

export async function combatAI(
  player: CharacterInstance, enemy: CharacterInstance,
  playerAction: string, previousExchange: string,
  worldState: WorldState, config: WorldCardConfig
): Promise<{ narrative: string; playerDmg: number; enemyDmg: number; enemyFled: boolean }> {
  const loc = config.locations.find(l => l.location_id === player.position.location_id);
  const locName = loc?.name || '未知地点';
  const timeStr = timeToString(worldState.game_time);

  const playerGear = getGearSummary(player, config);
  const enemyGear = getGearSummary(enemy, config);

  const systemPrompt = `你是一个战斗叙述AI。根据双方状态和玩家的攻击描述，生成一段包含了双方动作、攻防结果和伤害的叙述。
规则：1. 同时描述玩家和对手的动作，像小说一样连贯 2. 根据双方实力差距（P层级、装备）合理判断打中/躲避/格挡
3. 伤害0~15之间，实力悬殊时可能更高
4. 对手HP低于30%时可能尝试逃跑
5. 回复末尾必须加一行：[COMBAT: playerHp:-N enemyHp:-M]（N和M是整数，表示各自受到的伤害，未受伤则为0） 6. 如果对手逃跑，末尾格式为：[COMBAT: playerHp:-N enemyHp:-M FLEE]

叙述控制：300字以内。`;

  const userPrompt = `【战场】${locName}
时间：${timeStr}

【${player.name}】${formatKLevel(player.identity.k_level, config.mapping.k_level_names)} ${formatPLevel(player.stats.p_level, config.mapping.p_level_names)} | HP:${player.stats.hp}/${player.stats.max_hp}
装备/技能：${playerGear}
${player.name}的行动：${playerAction}

【${enemy.name}】${formatKLevel(enemy.identity.k_level, config.mapping.k_level_names)} ${formatPLevel(enemy.stats.p_level, config.mapping.p_level_names)} | HP:${enemy.stats.hp}/${enemy.stats.max_hp}
身份：${enemy.identity.title} | 性格：${enemy.permanent_memory.personality.speech_style}
装备/技能：${enemyGear}

${previousExchange ? `前情：\n${previousExchange}` : '战斗刚刚开始。'}

请生成一段连贯的战斗叙述，同时描述双方的动作和结果。`;

  try {
    const { text } = await callDeepSeek(
      systemPrompt,
      userPrompt,
      {
        type: 'conversation',
        gameTime: timeStr,
        characterName: enemy.name,
        flowNumber: undefined,
      },
      300,
      0.7,
    );

    // 解析伤害数据
    let playerDmg = 0, enemyDmg = 0, enemyFled = false;
    const combatMatch = text.match(/\[COMBAT:\s*playerHp:([+-]?\d+)\s+enemyHp:([+-]?\d+)\s*(FLEE)?\]/i);
    if (combatMatch) {
      playerDmg = Math.abs(parseInt(combatMatch[1]));
      enemyDmg = Math.abs(parseInt(combatMatch[2]));
      enemyFled = !!combatMatch[3];
    } else {
      if (text.includes('逃跑') || text.includes('逃离') || text.includes('撤退')) enemyFled = true;
      playerDmg = Math.floor(Math.random() * 3);
      enemyDmg = player.stats.p_level + Math.floor(Math.random() * 5);
    }

    const cleanText = text.replace(/\[COMBAT:[^\]]*\]/gi, '').trim();
    return { narrative: cleanText, playerDmg, enemyDmg, enemyFled };
  } catch (e) {
    return {
      narrative: `${enemy.name}警惕地盯着你的一举一动。`,
      playerDmg: 0,
      enemyDmg: 2,
      enemyFled: false,
    };
  }
}
