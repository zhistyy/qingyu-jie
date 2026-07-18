// 引擎层 —— 微观回合处理（v3 简化版）
// 处理玩家与 NPC 的直接对话（chat.html 用）和战斗交互
// 行为指令系统已废弃，全 AI 驱动

import type { CharacterInstance, WorldState, WorldCardConfig } from './types';
import { loadCharacter, loadAllCharacters, saveCharacter } from './db';
import { buildConversationPrompt } from '../transform/prompt';
import { converseAI, validateInstruction } from './agent';
import { combatAI } from '../transform/combatAI';
import { addResource, setRelation, moveEntity } from './crud';
import { logPlayerAction } from './playerLog';
import { handleCommand } from './commands';

// ── 内联：NPC 给玩家物品（AI 对话中的 [给予:] 标签处理）──
async function handleNpcGive(
  player: CharacterInstance, npc: CharacterInstance,
  resourceTypeId: string, config: WorldCardConfig, time: any, safeQty: number,
): Promise<string> {
  const npcHas = npc.inventory.find(r => r.resource_type_id === resourceTypeId);
  if (!npcHas || npcHas.quantity < safeQty) {
    return `${npc.name}没有足够的物品可以给。`;
  }
  await addResource(npc.character_id, resourceTypeId, -safeQty, time, `赠予${player.name}`);
  await addResource(player.character_id, resourceTypeId, safeQty, time, `从${npc.name}获得`);
  // 同步内存
  npcHas.quantity -= safeQty;
  if (npcHas.quantity <= 0) npc.inventory = npc.inventory.filter(r => r.resource_type_id !== resourceTypeId);
  const existing = player.inventory.find(r => r.resource_type_id === resourceTypeId);
  if (existing) { existing.quantity += safeQty; existing.last_updated = time; }
  else player.inventory.push({ resource_type_id: resourceTypeId, quantity: safeQty, last_updated: time, location_id: player.character_id });
  const resName = config.resource_types.find(rt => rt.resource_type_id === resourceTypeId)?.name || resourceTypeId;
  await setRelation(player.character_id, npc.character_id, 3, time, '获赠');
  return `${npc.name}给了你${resName}×${safeQty}。好感度 +3`;
}

export async function processMicroTurn(
  playerId: string, rawInput: string, worldState: WorldState, config: WorldCardConfig,
  targetCharId?: string, combatTargetId?: string
): Promise<{ response: string; systemLog: string[]; combat?: { enemyId: string; playerHp: number; enemyHp: number; ended: boolean; fled: boolean }; }> {
  const logs: string[] = [];
  const player = await loadCharacter(playerId);
  if (!player) return { response: '角色未找到', systemLog: [] };
  const time = worldState.game_time;

  // ── 战斗模式：自由文本走 combatAI ──
  if (combatTargetId && !rawInput.startsWith('/')) {
    return handleCombatTurn(player, rawInput, combatTargetId, playerId, worldState, config, time, logs);
  }

  // ── /指令路由 ──
  if (rawInput.startsWith('/')) {
    const hcResult = await handleCommand(rawInput, player, worldState, config);
    return { response: hcResult.response, systemLog: hcResult.systemLog };
  }

  // ── 自由文本对话 ──
  const currentLoc = player.position.location_id;
  const allChars = await loadAllCharacters();
  const othersAtLoc = allChars.filter(c =>
    c.character_id !== playerId && c.position.location_id === currentLoc && c.agent_state !== 'dormant'
  );

  if (othersAtLoc.length === 0) {
    const locName = config.locations.find(l => l.location_id === currentLoc)?.name || currentLoc;
    return { response: `你在${locName}。周围没有其他人。\n输入 /去XXX 移动到目标地点，或 /地图 查看世界。`, systemLog: [] };
  }

  let target: CharacterInstance | null = null;
  if (targetCharId) {
    target = allChars.find(c => c.character_id === targetCharId) || null;
  }
  if (!target) {
    const locName = config.locations.find(l => l.location_id === currentLoc)?.name || currentLoc;
    const nameList = othersAtLoc.map(c => c.name).join('、');
    return { response: `你在${locName}。周围有：${nameList}。\n在角色对话页面选择想交谈的对象，或输入 /帮助 查看指令。`, systemLog: [] };
  }

  // 构建对话历史
  const history = target.short_term_buffer.conversations.slice(-10).map(t => {
    const speaker = t.speaker_id === playerId ? player.name :
      allChars.find(c => c.character_id === t.speaker_id)?.name || t.speaker_id;
    return `${speaker}: ${t.content}`;
  }).join('\n');

  // 调用对话 AI
  const { system, user } = await buildConversationPrompt(target, rawInput, worldState, config, history, playerId);
  const aiResp = await converseAI(target, worldState, config, system, user);

  // 记录对话
  target.short_term_buffer.conversations.push({ speaker_id: playerId, content: rawInput, timestamp: time });
  target.short_term_buffer.conversations.push({ speaker_id: target.character_id, content: aiResp.text, timestamp: time });
  await saveCharacter(target);

  // 提取AI自然文本中的 CRUD 标签：[给予: res_id, qty] 或 [交换: npcRes, npcQty, playerRes, playerQty]
  let displayText = aiResp.text;

  const giveMatch = aiResp.text.match(/\[给予:\s*(\S+)\s*,\s*(\d+)\s*\]/);
  if (giveMatch) {
    const resId = giveMatch[1];
    const qty = parseInt(giveMatch[2]) || 1;
    displayText = aiResp.text.replace(/\[给予:\s*\S+\s*,\s*\d+\s*\]\s*/g, '').trim();
    if (!config.resource_types.some(rt => rt.resource_type_id === resId)) {
      logs.push(`[CRUD·赠与拒绝] 未知资源类型: ${resId}`);
    } else {
      const safeQty = Math.min(qty, 50);
      const giveResult = await handleNpcGive(player, target, resId, config, time, safeQty);
      logs.push(`[CRUD·赠与] ${resId}×${safeQty}: ${giveResult}`);
      if (!displayText.includes(giveResult)) {
        displayText += `\n\n*${giveResult}*`;
      }
    }
  }

  const tradeMatch = aiResp.text.match(/\[交换:\s*(\S+)\s*,\s*(\d+)\s*,\s*(\S+)\s*,\s*(\d+)\s*\]/);
  if (tradeMatch) {
    const npcRes = tradeMatch[1], npcQty = Math.min(parseInt(tradeMatch[2]) || 1, 50);
    const playerRes = tradeMatch[3], playerQty = Math.min(parseInt(tradeMatch[4]) || 1, 50);
    displayText = aiResp.text.replace(/\[交换:\s*\S+\s*,\s*\d+\s*,\s*\S+\s*,\s*\d+\s*\]\s*/g, '').trim();
    if (!config.resource_types.some(rt => rt.resource_type_id === npcRes)) {
      logs.push(`[CRUD·交易拒绝] 未知资源类型: ${npcRes}`);
    } else if (!config.resource_types.some(rt => rt.resource_type_id === playerRes)) {
      logs.push(`[CRUD·交易拒绝] 未知资源类型: ${playerRes}`);
    } else {
      const npcHas = target.inventory.find(r => r.resource_type_id === npcRes);
      const playerHas = player.inventory.find(r => r.resource_type_id === playerRes);
      if (!npcHas || npcHas.quantity < npcQty) {
        logs.push(`[CRUD·交易失败] NPC 没有足够库存: ${npcRes}`);
      } else if (!playerHas || playerHas.quantity < playerQty) {
        logs.push(`[CRUD·交易失败] 玩家没有足够库存: ${playerRes}`);
      } else {
        await addResource(target.character_id, npcRes, -npcQty, time, `交易给${player.name}`);
        await addResource(player.character_id, npcRes, npcQty, time, `从${target.name}交易获得`);
        await addResource(player.character_id, playerRes, -playerQty, time, `交易给${target.name}`);
        await addResource(target.character_id, playerRes, playerQty, time, `从${player.name}交易获得`);
        await setRelation(player.character_id, target.character_id, 5, time, '交易');
        const npcResName = config.resource_types.find(rt => rt.resource_type_id === npcRes)?.name || npcRes;
        const playerResName = config.resource_types.find(rt => rt.resource_type_id === playerRes)?.name || playerRes;
        const tradeMsg = `${target.name}用${npcResName}×${npcQty} 换取了你的${playerResName}×${playerQty}。好感度 +5`;
        logs.push(`[CRUD·交易] ${tradeMsg}`);
        displayText += `\n\n*${tradeMsg}*`;
      }
    }
  }

  // AI指令管线验证
  if (aiResp.instructions?.length) {
    for (const inst of aiResp.instructions) {
      const validation = validateInstruction(inst, config.instruction_types);
      if (validation.valid) {
        if (inst.instruction_type === 'relation_change') {
          await setRelation(playerId, inst.target_id, inst.delta, time, 'AI指令');
          logs.push(`[管线] 关系变更 ${inst.delta > 0 ? '+' : ''}${inst.delta}`);
        } else if (inst.instruction_type === 'state_change') {
          await addResource(playerId, inst.target_id, inst.delta, time, 'AI指令');
          logs.push(`[管线] 资源变更 ${inst.delta > 0 ? '+' : ''}${inst.delta}`);
        } else if (inst.instruction_type === 'resource_give') {
          const giveMsg = await handleNpcGive(player, target, inst.target_id, config, time, 1);
          logs.push(`[管线] ${giveMsg}`);
          if (giveMsg.includes('没有足够的')) {
            return { response: displayText + '\n\n[系统] ' + giveMsg, systemLog: logs };
          }
        }
      } else {
        logs.push(`[管线] AI指令被拒绝: ${validation.reason}`);
      }
    }
  }

  // 记录对话操作
  const convTargetName = target?.name || '某人';
  logPlayerAction('conversation', convTargetName, `与${convTargetName}交谈`,
    `${player.name}对${convTargetName}说：${rawInput.slice(0, 50)}`, time);

  return { response: `${target.name}：${displayText}`, systemLog: logs };
}

// ── 战斗回合处理 ──
async function handleCombatTurn(
  player: CharacterInstance, rawInput: string, combatTargetId: string,
  playerId: string, worldState: WorldState, config: WorldCardConfig, time: any, logs: string[],
) {
  const allChars = await loadAllCharacters();
  const enemy = allChars.find(c => c.character_id === combatTargetId);
  if (!enemy || enemy.stats.hp <= 0 || enemy.agent_state === 'dormant') {
    return { response: '战斗已结束，对手已无法战斗。', systemLog: logs, combat: { enemyId: combatTargetId, playerHp: player.stats.hp, enemyHp: 0, ended: true, fled: false } };
  }
  if (enemy.position.location_id !== player.position.location_id) {
    return { response: '对手已不在当前地点。', systemLog: logs, combat: { enemyId: combatTargetId, playerHp: player.stats.hp, enemyHp: enemy.stats.hp, ended: true, fled: false } };
  }

  const prevExchange = enemy.short_term_buffer.conversations.slice(-4)
    .map(t => `${t.speaker_id === playerId ? player.name : enemy.name}: ${t.content}`).join('\n');
  const result = await combatAI(player, enemy, rawInput, prevExchange, worldState, config);

  player.stats.hp = Math.max(0, player.stats.hp - result.playerDmg);
  enemy.stats.hp = Math.max(0, enemy.stats.hp - result.enemyDmg);

  enemy.short_term_buffer.conversations.push({ speaker_id: playerId, content: rawInput, timestamp: time });
  enemy.short_term_buffer.conversations.push({ speaker_id: enemy.character_id, content: result.narrative, timestamp: time });

  const combatEnded = player.stats.hp <= 0 || enemy.stats.hp <= 0 || result.enemyFled;
  if (combatEnded) {
    if (player.stats.hp <= 0) {
      player.agent_state = 'dormant';
      logs.push(`[战斗] ${player.name} 被击败了！`);
    }
    if (enemy.stats.hp <= 0) {
      enemy.agent_state = 'dormant';
      for (const item of enemy.inventory) {
        if (item.quantity > 0) await addResource(playerId, item.resource_type_id, item.quantity, time, '战斗战利品');
      }
      enemy.inventory = [];
      logs.push(`[战斗] ${enemy.name} 被击败！获得全部战利品。`);
      await setRelation(playerId, enemy.character_id, -30, time, '战斗击败');
    }
    if (result.enemyFled) {
      logs.push(`[战斗] ${enemy.name} 逃跑了！`);
      const otherLoc = config.locations.find(l => l.location_id !== player.position.location_id);
      if (otherLoc) {
        await moveEntity(enemy.character_id, enemy.position.location_id, otherLoc.location_id, time, '战斗逃跑');
      }
    }
  }

  await Promise.all([saveCharacter(player), saveCharacter(enemy)]);

  const combatSummary = result.enemyFled ? `${enemy.name}逃跑了` : player.stats.hp > 0 ? `击败了${enemy.name}` : `被${enemy.name}击败`;
  logPlayerAction('combat', enemy.name, combatSummary, `${player.name}与${enemy.name}战斗：${result.narrative.slice(0, 50)}`, time);

  const hpInfo = `\nHP 你:${player.stats.hp}/${player.stats.max_hp} | ${enemy.name}:${enemy.stats.hp}/${enemy.stats.max_hp}${combatEnded ? '\n[战斗结束]' + (result.enemyFled ? ` ${enemy.name}逃跑了。` : player.stats.hp > 0 ? ' 你赢了！' : ' 你被击败了...') : ''}`;
  return {
    response: `${result.narrative}${hpInfo}`,
    systemLog: logs,
    combat: { enemyId: combatTargetId, playerHp: player.stats.hp, enemyHp: enemy.stats.hp, ended: combatEnded, fled: result.enemyFled },
  };
}
