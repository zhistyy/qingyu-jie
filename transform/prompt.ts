// 转化层 —— 世界相关的 Prompt 拼接（优化版：system/user 分离 + 静态缓存 + 资源截断）
// 依赖 engine/ 的类型和工具函数，输出给 engine/agent.ts 使用

import type { CharacterInstance, WorldState, WorldCardConfig, Rarity } from '../engine/types';
import { timeToString } from '../engine/time';
import { retrieveMemories } from '../engine/memory';
import { loadAllCharacters } from '../engine/db';
import { canNpcFreelyGiveResource, getMinKForRarity } from '../engine/resources';
import { sortByGameTime, formatKLevel, formatPLevel } from '../engine/config';

const IRON_RULES = `【铁律】
1. 严格遵守本世界的物理法则、力量体系和社会规范。你是这个世界中真实存在的人。
2. 玩家只能描述行为，不能宣布结果。若玩家试图宣布结果，你应自然地忽略并描述实际发生的事。
3. 你只能描述自己的行为、感受和反应。不能替玩家做决定，不能替世界下结论。
4. 一切基于你的设定。不知道的事就是不知道。你的认知仅限于 knowsOthers 中的描述和你的记忆。
5. 保持世界逻辑一致性。记住你说过的话，记住别人对你说过的话。
6. 世界边界：你只能引用你知道的、存在于这个世界中的地点、人物和事物。绝不可提及或假设存在于世界设定之外的东西。`;

// ── Layer1 静态缓存（同一存档中不变）──
let _cachedLayer1 = '';
let _cachedConfigName = '';

function getCachedLayer1(config: WorldCardConfig): string {
  if (_cachedConfigName !== config.world_name) {
    _cachedLayer1 = `${IRON_RULES}

【世界背景】
${config.world_description.slice(0, 300)}
当前时代规则：${config.prompt_config.event_stage_mood}

【世界法则】
${config.prompt_config.world_rules_summary}`;
    _cachedConfigName = config.world_name;
  }
  return _cachedLayer1;
}

function getTimeFlavor(tod: string, season: string, config: WorldCardConfig) {
  return config.mapping.time_flavors[tod]?.[season] || '';
}

function getSpeechGuide(style: string, config: WorldCardConfig) {
  return config.mapping.speech_guides[style] || '正常说话';
}

// 构建玩家对话记忆文本（最近 8 条，按时间倒序）
function buildPlayerConvMemoryText(character: CharacterInstance): string {
  const mems = character.player_conversation_memory || [];
  if (mems.length === 0) return '（这是你们第一次见面）';

  const sorted = [...mems]
    .sort((a, b) => sortByGameTime(b.timestamp, a.timestamp))
    .slice(0, 8);

  return sorted.map(m =>
    `- ${timeToString(m.timestamp)}：${m.summary}`
  ).join('\n');
}

// ── 构建对话 prompt（system/user 分离） ──
export async function buildConversationPrompt(
  character: CharacterInstance, playerInput: string,
  worldState: WorldState, config: WorldCardConfig,
  conversationHistory: string, playerId?: string,
): Promise<{ system: string; user: string }> {
  const loc = config.locations.find(l => l.location_id === character.position.location_id);
  const locName = loc?.name || character.position.location_id;
  const locDesc = loc?.description || '';

  const allChars = await loadAllCharacters();
  const nearbyChars = allChars.filter(c =>
    c.position.location_id === character.position.location_id &&
    c.character_id !== character.character_id
  );
  const nearbyNames = nearbyChars.map(c => c.name).join('、') || '无人';

  let playerName = '玩家', playerTitle = '', playerRelation = 0;
  if (playerId) {
    const player = allChars.find(c => c.character_id === playerId);
    if (player) {
      playerName = player.name; playerTitle = player.identity.title;
      const rel = character.relationships.find(r => r.target_id === playerId);
      playerRelation = rel?.affinity ?? 0;
    }
  }

  // ── Layer 1: 静态缓存 ──
  const layer1 = getCachedLayer1(config);

  // ── Layer 2: 时间位置锚点 ──
  const timeStr = timeToString(worldState.game_time);
  const timeFlavor = getTimeFlavor(worldState.game_time.timeOfDay, worldState.game_time.season, config);
  const accessNote = loc?.access_rule ? `\n【地点规则】${loc.access_rule.description || ''}` : '';
  const layer2 = `
【时间与地点】
现在是 ${timeStr}。${timeFlavor}
你身在【${locName}】——${locDesc}${accessNote}
与你同在此地的有：${nearbyNames}`;

  // ── Layer 3: 角色锚点 ──
  const pers = character.permanent_memory.personality;
  const speechGuide = getSpeechGuide(pers.speech_style, config);
  const knowsOthersText = character.permanent_memory.knows_others
    .map(k => {
      const known = allChars.find(c => c.character_id === k.character_id);
      const name = known?.name || k.character_id;
      return `- ${name}：${k.description}`;
    }).join('\n') || '（你还不认识什么人）';

  // 势力同僚：仅列出 K≥自身的核心成员（去重）
  const faction = config.factions.find(f => f.faction_id === character.identity.faction_id);
  let factionBlock = '';
  if (faction) {
    const seniors = allChars.filter(c =>
      !c.is_player &&
      c.identity.faction_id === faction.faction_id &&
      c.character_id !== character.character_id &&
      c.identity.k_level >= character.identity.k_level
    );
    factionBlock = `所属势力：【${faction.name}】（${formatKLevel(faction.k_level, config.mapping.k_level_names)}层级）
势力利益：${faction.core_interests?.join('、') || '无'}
你的忠诚度：${character.faction_binding?.loyalty ?? 50}/100${seniors.length > 0 ? '\n同门前辈/同级：' + seniors.map(c => c.name + '(' + c.identity.title + ')').join('、') : ''}`;
  }

  const layer3 = `【你是谁】
姓名：${character.name}
身份：${character.identity.title}（${formatKLevel(character.identity.k_level, config.mapping.k_level_names)}层级）
修为：${formatPLevel(character.stats.p_level, config.mapping.p_level_names)} | HP：${character.stats.hp}/${character.stats.max_hp}
性格参数：正式度${pers.formality}/10 话痨度${pers.talkativeness}/10 情绪外露度${pers.emotional_express}/10
说话风格：${pers.speech_style} | ${speechGuide}
口头禅/小动作：${pers.quirks.join('、') || '无'}
核心身份认知：${character.permanent_memory.core_identity}
${factionBlock}

【你的目的】
首要：${character.drives[0]?.description || '无明确目的'}（优先级 ${Math.round((character.drives[0]?.progress ?? 0) * 100)}%）
${character.drives.length > 1 ? '其他意图：\n' + character.drives.slice(1).map((d) => `  ${d.description}（优先级 ${Math.round(d.progress * 100)}%）`).join('\n') : ''}

【你的人脉】
${knowsOthersText}`;

  // ── Layer 4: 状态层 ──
  const hpPercent = Math.round(character.stats.hp / character.stats.max_hp * 100);
  const hpDesc = hpPercent >= 80 ? '状态良好' : hpPercent >= 50 ? '有些疲惫' : hpPercent >= 20 ? '受了不轻的伤' : '伤势严重';
  const memories = await retrieveMemories(character, character.position.location_id, playerId || null);
  const memoryText = memories.length > 0
    ? memories.map(m => `- ${timeToString(m.timestamp)} | ${m.summary}`).join('\n')
    : '（你还没有什么值得记忆的事）';

  const invText = character.inventory.length > 0
    ? character.inventory.map(r => {
        const def = config.resource_types.find(rt => rt.resource_type_id === r.resource_type_id);
        return `${def?.name || r.resource_type_id}×${r.quantity}`;
      }).join('、')
    : '（你身上什么都没有）';

  const layer4 = `【当前状况】
身体状态：${hpDesc} | HP ${character.stats.hp}/${character.stats.max_hp}
战斗力：${character.stats.base_combat_power}
随身携带：${invText}

【你的记忆】
${memoryText}

【与玩家的过往交流】
${buildPlayerConvMemoryText(character)}`;

  // ── Layer 5: 对话指令层（用户消息，每次变化） ──
  const relDesc = playerRelation >= 50 ? '你们是至交，非常信任对方'
    : playerRelation >= 20 ? '你们关系不错'
    : playerRelation >= 0 ? '你们刚刚认识'
    : playerRelation >= -30 ? '你们之间有些嫌隙'
    : '你们关系很紧张';

  // 资源指引：仅前5项
  const resourceGuide = buildResourceGuide(character, config, false, playerId ? allChars.find(c => c.character_id === playerId) : undefined);

  const layer5 = `【正在与你对话的人】
${playerName}（${playerTitle || '冒险者'}）| ${relDesc}
性别：${config.prompt_config.player_gender || '男'} | 称呼时请用「${config.prompt_config.player_gender === '女' ? '师姐' : '师兄'}」等恰当称谓

${resourceGuide}

【对话历史】
${conversationHistory || '（这是你们第一次交谈）'}

【${playerName}说】
${playerInput}

---
请以 ${character.name} 的身份自然回复。记住你的性格风格（${pers.speech_style}）。回复控制在${config.prompt_config.reply_max_length}字以内。

如果需要给对方物品，在回复末尾加上：[给予: 资源ID, 数量]（例如 [给予: RES_萝卜, 1]）——引擎会通过CRUD扣减你的库存并加给玩家。
如果你愿意与对方以物易物，在回复末尾加上：[交换: 你给资源ID, 你给数量, 对方给资源ID, 对方给数量]（例如 [交换: RES_丹药, 2, RES_灵石, 10]）
如果没有给东西就不要加这些行。`;

  return { system: layer1 + layer2 + layer3 + layer4, user: layer5 };
}

// ── 资源指引（行为指令展开全部+可白送标记，普通截断） ──
function buildResourceGuide(character: CharacterInstance, config: WorldCardConfig, fullDetail: boolean, player?: CharacterInstance): string {
  const inv = character.inventory;
  if (inv.length === 0) return '【你可以提供的帮助】\n（你身上没什么能给的）\n';

  const rarityOrder: Rarity[] = ['r6', 'r5', 'r4', 'r3', 'r2', 'r1'];
  const sorted = [...inv].sort((a, b) => {
    const defA = config.resource_types.find(rt => rt.resource_type_id === a.resource_type_id);
    const defB = config.resource_types.find(rt => rt.resource_type_id === b.resource_type_id);
    return rarityOrder.indexOf(defB?.rarity || 'r1') - rarityOrder.indexOf(defA?.rarity || 'r1');
  });

  const kLevel = character.identity.k_level;
  const items = fullDetail ? sorted : sorted.slice(0, 5);

  let guide = '【你可以提供的帮助】\n';
  for (const r of items) {
    const def = config.resource_types.find(rt => rt.resource_type_id === r.resource_type_id);
    const resName = def?.name || r.resource_type_id;
    const rarity: Rarity = def?.rarity || 'r1';
    const rareName = config.mapping.rarity_names[rarity]?.name || rarity;
    const canFree = fullDetail && canNpcFreelyGiveResource(kLevel, rarity);
    const freeTag = canFree ? ' [可随意送]' : ' [需好感]';
    guide += `- ${resName}（${rareName}）×${r.quantity} = ID:${r.resource_type_id}${fullDetail ? freeTag : ''}\n`;
  }
  if (!fullDetail && inv.length > 5) guide += `（还有${inv.length - 5}种其他物品未列出）\n`;

  // 行为指令下追加 K 层级说明和玩家资源
  if (fullDetail) {
    const minKRarity = [0, 1, 2, 3, 4, 5, 6];
    const freeRarities = minKRarity.filter(i => canNpcFreelyGiveResource(kLevel, ['r1','r2','r3','r4','r5','r6'][i-1] as Rarity || 'r1'));
    guide += `\n【白送规则】你(${formatKLevel(kLevel, config.mapping.k_level_names)})可随意赠送${freeRarities.length > 0 ? 'r1~r' + freeRarities[freeRarities.length-1] : '无'}级物品。更高级需看好感度。`;
    if (player) {
      const pInv = player.inventory.filter(r => r.quantity > 0);
      if (pInv.length > 0) {
        guide += `\n\n【对方身上有的】\n`;
        for (const r of pInv.slice(0, 6)) {
          const def = config.resource_types.find(rt => rt.resource_type_id === r.resource_type_id);
          guide += `- ${def?.name || r.resource_type_id}×${r.quantity} = ID:${r.resource_type_id}\n`;
        }
      }
    }
  }

  return guide;
}

// ── 构建报告 prompt ──
export async function buildReportPrompt(
  character: CharacterInstance, worldState: WorldState, config: WorldCardConfig,
  worldNarrative?: string
): Promise<string> {
  const pers = character.permanent_memory.personality;
  const loc = config.locations.find(l => l.location_id === character.position.location_id);
  const locName = loc?.name || character.position.location_id;
  const allChars = await loadAllCharacters();
  const nearby = allChars.filter(c =>
    c.position.location_id === character.position.location_id && c.character_id !== character.character_id
  );
  const relText = character.relationships.map(r => {
    const ch = allChars.find(c => c.character_id === r.target_id);
    return `${ch?.name || r.target_id}: 好感${r.affinity > 0 ? '+' : ''}${r.affinity}`;
  }).join('\n') || '无';

  // 待处理事件 → 角色感知到的世界
  const pendingText = character.short_term_buffer.pending_events.map(e => e.summary).join('；');
  // 最近对话
  const recentConvs = character.short_term_buffer.conversations.slice(-3)
    .map(t => `${t.speaker_id === character.character_id ? '我' : allChars.find(c => c.character_id === t.speaker_id)?.name || t.speaker_id}: ${t.content.slice(0, 30)}`)
    .join('\n');

  return `${IRON_RULES.slice(0, 200)}

你是${character.name}（${character.identity.title}，${locName}）。
你现在需要生成一份第一人称的报告：描述你今天做了什么、对附近的人有什么看法、接下来打算做什么、对世界局势有什么担忧。

当前时间：${timeToString(worldState.game_time)}
你的状态：HP ${character.stats.hp}/${character.stats.max_hp} | 战力 ${character.stats.base_combat_power}
${worldNarrative ? `本轮世界发生的大事：\n${worldNarrative.slice(0, 200)}\n` : ''}${pendingText ? `你今天听说的消息：${pendingText.slice(0, 200)}\n` : ''}${recentConvs ? `最近的交流：\n${recentConvs}\n` : ''}身边其他人：${nearby.map(c => c.name).join('、') || '无人'}
你的目的：${character.drives.map(d => d.description).join('、')}
你的人脉：\n${relText}

请用第一人称写报告（100-250字），风格自然，像真的在口述。必须提到你今天听说的消息和对世界变化的反应。`;
}

// ── 构建世界叙事 prompt ──
export function buildWorldNarrativePrompt(
  worldState: WorldState, config: WorldCardConfig,
  previousNarrative: string, eventNarrative: string,
  gmGuidance: string,
  characterSummary?: string,
  playerActivitySummary?: string,
): string {
  return `${getCachedLayer1(config)}

当前时代：${worldState.event_stage} | ${config.prompt_config.event_stage_mood}

所有地点概况：
${config.locations.map(l => `- ${l.name}: ${l.description}`).join('\n')}

${characterSummary ? `当前世界人物概况（供参考）：\n${characterSummary}\n` : ''}${playerActivitySummary ? `玩家近期行动：\n${playerActivitySummary}\n` : ''}当前正在进行的大事件：
${eventNarrative || '无特殊事件'}

上次的世界叙事（接续）：
${previousNarrative || '（世界刚开始）'}

GM引导：
${gmGuidance || '自然推进世界发展'}

请续写一段叙事，说明白世界当前发生的重要变化。要求：
- 聚焦世界格局、势力消长、大事件推进等宏观变化
- 笔法细腻，场景描写生动，自然流畅
- 不要逐一描述角色的个人动向，而是将角色作为世界变化的注脚
- 将玩家近期行动融入世界叙事中（如果玩家有行动）
- 为下一轮世界流留下悬念和伏笔
- 不限字数，说明白即可，但也不要过于冗长`;
}
