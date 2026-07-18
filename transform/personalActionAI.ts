// 转化层 —— 个人行动 AI（世界流 Step 4 调用）
// 每个 NPC 独立调用，根据角色身份、性格、目的和外界事件决定本轮行动
// 调用方负责并发（Promise.all），本函数处理单个角色
import type { CharacterInstance, WorldState, WorldCardConfig } from '../engine/types';
import { timeToString } from '../engine/time';
import { callDeepSeek, getCurrentFlowNumber } from '../engine/agent';
import { genId, formatKLevel, formatPLevel } from '../engine/config';
import { retrieveMemories } from '../engine/memory';

export interface PersonalActionResult {
  characterId: string;
  characterName: string;
  summary: string;           // 行动摘要，用于日志和下游 AI 输入
  moveToLocation?: string;   // 目标地点ID（不移动则为 undefined）
  resourceUses: { resourceTypeId: string; amount: number; purpose: string }[];
  interactionIntents: { targetName: string; intent: string }[];
}

export async function personalActionAI(
  character: CharacterInstance,
  worldState: WorldState,
  config: WorldCardConfig,
  allCharacters: CharacterInstance[],
  playerActivitySummary?: string,
): Promise<PersonalActionResult> {
  const timeStr = timeToString(worldState.game_time);

  // ── 构建角色完整上下文 ──

  const loc = config.locations.find(l => l.location_id === character.position.location_id);
  const locName = loc?.name || character.position.location_id;
  const locDesc = loc?.description || '';

  // 同地点角色
  const nearbyChars = allCharacters.filter(c =>
    c.character_id !== character.character_id &&
    c.position.location_id === character.position.location_id
  );
  const nearbyNames = nearbyChars.map(c => c.name).join('、') || '无人';

  // 角色对他人的认知
  const knowsOthersText = character.permanent_memory.knows_others
    .map(k => {
      const known = allCharacters.find(c => c.character_id === k.character_id);
      const name = known?.name || k.character_id;
      return `- ${name}（${k.description}）`;
    }).join('\n') || '（你还不认识什么人）';

  // 目的
  const drivesText = character.drives.map(d =>
    `[${d.type}] ${d.description}（进度${Math.round(d.progress * 100)}%）`
  ).join('\n') || '无明确目的';

  // 待处理事件（世界叙事摘要 + 大事件 + 其他）
  const eventsText = character.short_term_buffer.pending_events
    .map(e => e.summary)
    .join('；') || '暂无新消息';

  // 关系网
  const relsText = character.relationships
    .filter(r => Math.abs(r.affinity) > 5)
    .map(r => {
      const target = allCharacters.find(c => c.character_id === r.target_id);
      const name = target?.name || r.target_id;
      const state = r.affinity >= 40 ? '至交' : r.affinity >= 15 ? '友好' : r.affinity <= -30 ? '敌对' : '中立';
      return `${name}: ${state}(好感${r.affinity > 0 ? '+' : ''}${r.affinity})`;
    }).join('；') || '暂无重要关系';

  // 物品
  const invText = character.inventory.length > 0
    ? character.inventory.map(r => {
        const def = config.resource_types.find(rt => rt.resource_type_id === r.resource_type_id);
        return `${def?.name || r.resource_type_id}×${r.quantity}`;
      }).join('、')
    : '无';

  // 势力
  const facName = config.factions.find(f => f.faction_id === character.faction_binding.faction_id)?.name || '无势力';
  const factionBlock = facName !== '无势力'
    ? `所属势力：【${facName}】，忠诚度${character.faction_binding.loyalty}/100`
    : '无势力归属';

  // 可选移动目标
  const availableLocs = config.locations
    .map(l => `【${l.name}】危险${l.danger_level} ${l.description.slice(0, 30)}`)
    .join('\n');

  const pers = character.permanent_memory.personality;

  // 检索角色记忆
  const memories = await retrieveMemories(character, character.position.location_id, null);
  const memoryText = memories.length > 0
    ? memories.map(m => `- ${timeToString(m.timestamp)} | ${m.summary}`).join('\n')
    : '（暂无重要记忆）';

  // ── Prompt 构建 ──
  const prompt = `你是 ${character.name} 的行动决策者。你的职责是为角色规划本轮世界流（几天）中的行动。行动要有驱动、有目的、会对世界产生显著影响。务必给出具体的行动，而不是"按部就班"或"日常"。
【世界背景】${config.world_description.slice(0, 300)}

【当前时间与地点】${timeStr}
你身在【${locName}】—${locDesc}
与你同在此地的人：${nearbyNames}

【你的角色档案】
姓名：${character.name}
身份：${character.identity.title}（${formatKLevel(character.identity.k_level, config.mapping.k_level_names)}层级）
修为：${formatPLevel(character.stats.p_level, config.mapping.p_level_names)} | HP ${character.stats.hp}/${character.stats.max_hp} | 战力 ${character.stats.base_combat_power}
性格：${pers.speech_style} | 正式：${pers.formality}/10 话痨：${pers.talkativeness}/10 情绪外露：${pers.emotional_express}/10
核心身份认知：${character.permanent_memory.core_identity}
${factionBlock}

【你的目的（按优先级排列）】
${drivesText}

【你听到的世界消息】
${eventsText}
${playerActivitySummary ? `
【玩家近期动向】${playerActivitySummary}
` : ''}【你的记忆】
${memoryText}

【你的关系网】
${relsText}

【你身上的物品】
${invText}

【你对周围人的了解】
${knowsOthersText}

【你可以去的地方】
${availableLocs}

---
请根据以上信息，决定${character.name}本轮（几天内）要做什么。你是一个有血有肉的人，不是背景板。
1. 目的需要推进——必须取得阶段性进展，哪怕是一小步
2. 听到的消息驱动你采取行动——你在意的事、你害怕的事、你渴望的事
3. 你需要和谁互动？交易？谈判？冲突？
4. 如果当前位置不合适你的目的，移动到别处去
5. 使用你的物品和资源达成目的
6. 性格决定行为方式——冲动者行动，谨慎者观望但不静止，贪婪者谋利
7. 如果有玩家近期动向，你对玩家行动的关注要体现在你的行动中
8. 如果当前目的进展缓慢或不太合理，考虑改变计划——你的行动描述可以暗示方向转变，系统会据此更新你的目的

输出格式（至少输出[行动]，其他可选但鼓励多输出）：
[行动] 具体行动描述（如"前往炼丹阁向药姑换取灵草配方"而非"日常"）
[移动] 地点名（如果行动需要去别处）
[使用] 资源ID 数量 用途（消耗资源完成行动）
[互动] 目标角色名 意图描述（接触某人达成目的）`;

  const emptyResult: PersonalActionResult = {
    characterId: character.character_id,
    characterName: character.name,
    summary: `${character.name}按部就班地度过。`,
    resourceUses: [],
    interactionIntents: [],
  };

  try {
    const { text } = await callDeepSeek(
      '你是一个角色行动决策AI。根据角色档案决定行动，输出格式严格遵循：[类型] 内容。不输出无关内容。',
      prompt,
      {
        type: 'personal_action',
        gameTime: timeStr,
        characterName: character.name,
        flowNumber: getCurrentFlowNumber(),
      },
      300,
      0.6,
    );

    // ── 解析结构化输出 ──
    const result: PersonalActionResult = {
      characterId: character.character_id,
      characterName: character.name,
      summary: `${character.name}按部就班地度过。`,
      resourceUses: [],
      interactionIntents: [],
    };

    const lines = text.split('\n').filter((l: string) => l.trim());
    for (const line of lines) {
      const trimmed = line.trim();

      const actionMatch = trimmed.match(/^\[行动\]\s*(.+)$/);
      if (actionMatch) {
        result.summary = actionMatch[1].slice(0, 50);
        continue;
      }

      const moveMatch = trimmed.match(/^\[移动\]\s*(.+)$/);
      if (moveMatch) {
        const locName = moveMatch[1].trim();
        const targetLoc = config.locations.find(l => l.name === locName || l.name.includes(locName));
        if (targetLoc && targetLoc.location_id !== character.position.location_id) {
          result.moveToLocation = targetLoc.location_id;
        }
        continue;
      }

      const useMatch = trimmed.match(/^\[使用\]\s*(\S+)\s+(\d+)\s*(.*)$/);
      if (useMatch) {
        const [, resId, qtyStr, purpose] = useMatch;
        const qty = parseInt(qtyStr);
        if (!isNaN(qty) && qty > 0) {
          // 校验资源ID必须存在于世界配置中
          const resDef = config.resource_types.find(rt => rt.resource_type_id === resId);
          if (!resDef) continue; // 跳过非法资源ID
          result.resourceUses.push({ resourceTypeId: resId, amount: qty, purpose: purpose?.trim() || '' });
        }
        continue;
      }

      const interactMatch = trimmed.match(/^\[互动\]\s*(\S+)\s*(.*)$/);
      if (interactMatch) {
        const [, targetName, intent] = interactMatch;
        result.interactionIntents.push({ targetName: targetName.trim(), intent: intent?.trim() || '交谈' });
        continue;
      }
    }

    return result;
  } catch (e: any) {
    console.error(`[个人行动AI] ${character.name} 调用失败:`, e.message);
    return emptyResult;
  }
}
