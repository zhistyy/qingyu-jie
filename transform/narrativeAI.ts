// 转化层 —— 双阶段叙事 + 后置系统变更提取
// Stage 1: 提纲 AI（接收全量上下文，输出结构化叙事提纲）
// Stage 2: 写作 AI（接收提纲 + 上一段叙事，输出连贯的第三人称叙事正文）
// Stage 3: 解析 AI（读取叙事正文，提取系统变更 JSON）

import { callDeepSeek, getCurrentFlowNumber } from '../engine/agent';
import type { WorldChangeSet } from '../engine/types';

// ══════════════════════════════════════════════════════════
//  输入上下文
// ══════════════════════════════════════════════════════════

export interface NarrativeContext {
  worldName: string;
  worldDescription: string;
  worldMood: string;
  worldCatalog: string;         // 全量世界目录（硬数据）

  timeStr: string;
  timeFlavor: string;
  season: string;

  playerName: string;
  playerIdentity: string;
  playerPLevel: string;
  playerHP: string;
  playerLocation: string;
  playerLocationDesc: string;
  playerLocationResources: string; // 当前地点可采集资源（如"灵石×15、灵草×20"），空表示无
  playerPurpose: string;
  playerInventorySummary: string;
  playerCultivationInfo: string;    // 修炼状态与突破条件（如"P1→P2需进度100/灵石50/丹药2/基础功法"）

  nearbyNPCsStr: string;        // 在场 NPC 详情（含随身物品）
  allNPCsSummary: string;       // 所有 NPC 摘要
  relationshipsSummary: string; // 玩家与各 NPC 的关系

  // 上一轮叙事（保持连贯性）
  previousNarrative: string;

  // 玩家操作上下文
  playerAction: string;          // 玩家输入的内容
  recentActionsHistory: string;  // 最近行动历史

  // 模式
  mode: 'action' | 'world_flow';

  // action 模式专用
  systemActionResult?: string;

  // world_flow 模式专用
  worldFlowSummary?: string;
  worldFlowDays?: number;
}

// ══════════════════════════════════════════════════════════
//  主入口
// ══════════════════════════════════════════════════════════

export interface NarrativeResult {
  narrative: string;           // 叙事正文
  changeSet: WorldChangeSet;   // 系统变更
}

export async function generateFullNarrative(
  ctx: NarrativeContext,
): Promise<NarrativeResult> {
  console.log('[叙事AI] Stage 1/3: 生成提纲...');
  // Stage 1: 提纲
  const outline = await generateOutline(ctx);
  if (!outline) {
    console.warn('[叙事AI] 提纲生成失败，使用兜底提纲');
  }

  console.log('[叙事AI] Stage 2/3: 写作...');
  // Stage 2: 写作
  const narrative = await generateNarrativeFromOutline(ctx, outline);

  console.log('[叙事AI] Stage 3/3: 提取变更...');
  // Stage 3: 解析变更
  const changeSet = await extractChanges(ctx, narrative);

  console.log('[叙事AI] 完成。');
  return { narrative, changeSet };
}

// ══════════════════════════════════════════════════════════
//  Stage 1: 提纲生成
// ══════════════════════════════════════════════════════════

async function generateOutline(ctx: NarrativeContext): Promise<string> {
  const systemPrompt = `你是"${ctx.worldName}"的世界叙述者。你负责为即将书写的故事段落制定详细提纲。

${ctx.worldCatalog.slice(0, 3000)}

【提纲铁律】
1. 一个提纲只覆盖一个连贯的场景——不要跳跃地点或时间
2. 场景直接从上一段结尾处开始推进，不要回头重述
3. 以角色的视角展开：他看到什么、听到什么、遇到谁、做了什么
4. 禁止编造目录中不存在的地名、人名、物品名
5. 禁止使用任何标题格式（#）
6. 提纲需要丰富：至少6-8个情节点，覆盖场景氛围、角色互动、细节展开、情感变化

【提纲结构】
- 开头句：环境氛围，但必须和上一段结尾的场景是同一地点的延续
- 中间 5-7 句：角色行动 + 互动 + 细节 + 内心感受 + 环境变化
- 收尾句：停在角色当前所在处的一个具体画面或动作上`;

  const userPrompt = buildOutlineUserPrompt(ctx);

  try {
    const { text } = await callDeepSeek(
      systemPrompt,
      userPrompt,
      { type: 'narrative_outline', gameTime: ctx.timeStr, flowNumber: getCurrentFlowNumber() },
      1200,
      0.7,
    );
    return (text?.trim()) ? text : buildFallbackOutline(ctx);
  } catch (e: any) {
    console.error('[提纲AI] 调用失败:', e.message);
    return buildFallbackOutline(ctx);
  }
}

function buildFallbackOutline(ctx: NarrativeContext): string {
  const isWF = ctx.mode === 'world_flow';
  if (isWF) {
    return `- 时光流转${ctx.worldFlowDays || 5}天，世界宏观变化
- ${ctx.playerName}所在之地的氛围
- 各方势力的暗流涌动
- ${ctx.playerName}的思考与打算`;
  }
  return `- ${ctx.playerLocation}的氛围延续
- ${ctx.playerName}在当前位置的所见所闻
- 周围角色的动态与互动
- 一个小小的进展或发现`;
}

function buildOutlineUserPrompt(ctx: NarrativeContext): string {
  const isWF = ctx.mode === 'world_flow';

  const lastSentence = ctx.previousNarrative
    ? ctx.previousNarrative.split(/[。！？\n]/).filter(s => s.trim()).pop()?.trim() || ''
    : '';

  let prompt = `【上一段结尾——提纲必须从此处开始，不能跳跃场景】
${lastSentence || '（新篇章）'}

【时间与地点】${ctx.timeStr}，${ctx.timeFlavor}
${ctx.playerName}身在【${ctx.playerLocation}】—${ctx.playerLocationDesc}
${ctx.playerLocationResources ? `【此地可采集】${ctx.playerLocationResources}` : ''}

【主角状态】
身份：${ctx.playerIdentity} | 修为：${ctx.playerPLevel} | HP：${ctx.playerHP}
${ctx.playerCultivationInfo ? `修炼：${ctx.playerCultivationInfo}` : ''}
主要目的：${ctx.playerPurpose}
随身物品：${ctx.playerInventorySummary || '无'}

【在场人物详情（含随身物品）】
${ctx.nearbyNPCsStr || '周围无人'}

【所有已知角色】
${ctx.allNPCsSummary || '无'}

【玩家关系】
${ctx.relationshipsSummary || '暂无关系'}

【上一轮叙事（承接上文）】
${ctx.previousNarrative || '（新篇章开始）'}

【最近行动历史】
${ctx.recentActionsHistory || '（首次行动）'}`;

  if (isWF) {
    prompt += `\n\n【世界时间推进】${ctx.worldFlowDays || 5} 天过去了。
【世界变化摘要】${ctx.worldFlowSummary || '世界平静地运转着。'}`;
  } else {
    prompt += `\n\n【玩家本轮行动】${ctx.playerAction}
【系统执行结果】${ctx.systemActionResult || '无'}`;
  }

  prompt += `\n\n请为接下来的叙事段落写一个详细的提纲（每条一行，10-30字），列出叙事将涵盖的关键情节节点和场景。`;

  return prompt;
}

// ══════════════════════════════════════════════════════════
//  Stage 2: 叙事写作
// ══════════════════════════════════════════════════════════

async function generateNarrativeFromOutline(
  ctx: NarrativeContext,
  outline: string,
): Promise<string> {
  const isWF = ctx.mode === 'world_flow';

  const systemPrompt = `你是"${ctx.worldName}"的专业小说写手。根据给定的叙事提纲和上一段叙事，续写一段连贯的第三人称仙侠小说叙事。

【写作铁律】
1. 第三人称。主角名为"${ctx.playerName}"，只用此名
2. 必须严格承接上一段叙事——人物、事件、对话都要延续，不能另起炉灶
3. 严格遵循提纲来写，提纲之外的不要乱加
4. 禁止编造新人名、新地名、新物品名
5. 禁止使用任何标题格式（#）
6. 禁止在正文中提及游戏机制或数值
7. 结尾必须落在当下的一个自然收束上：
   - 日常场景：某人的一句话、一个动作、一个念头（如"他深吸一口气，推开了木门"）
   - 禁止用"微小的发现"制造悬念——不要写人影、异响、疑点等钩子
   - 除非玩家明确在调查/追踪某件事，否则叙事中不要引入悬疑元素
   - 禁止扫镜式收尾（转身离去/身影渐远/走向XX/薄雾渐散）
8. 风格：修真仙侠小说，半文半白，细节丰富，笔触细腻
9. 可以插入无名龙套丰富场景，但龙套不留姓名
10. 除非玩家明确在收集信息/打听消息，否则不要在叙事结尾留"疑点/悬念/谜题"
11. 如果玩家试图采集/收集/搜寻当前地点的资源，且此地点确实藏有资源（见情境信息中的"此地可采集资源"），必须在叙事中描写玩家采集到了资源的具体过程——翻找、挖掘、拾取，并写清楚获得了什么、大约多少
12. 如果玩家打坐修炼/服药/使用物品/炼丹/打造/赠予NPC物品，必须描写这个过程的细节——消耗了什么、产生了什么效果
13. 篇幅要求：至少300字以上，充分展开场景、对话、心理活动，不要匆匆收尾

【行文铁律——极其重要】
14. 主语必须多变。同一段落内，"${ctx.playerName}"开头的句子不超过40%。交替使用：
    - "他..."（最常用）
    - 以其他角色为主语
    - 省略主语的短句
    - 以感官/动作/环境为起点（但不能连续两个段落以环境起头）
15. 段落开头必须承接 user prompt 中给出的"上一段结尾句"——第一句直接延续那个动作/对话/场景。除非是新篇章，否则绝不允许另起环境描写开头
16. 对话穿插动作和神态——"说"字前后必有肢体细节，杜绝"某某说：xxx"
17. 长短句交替。长句不超过 40 字
18. 多写环境细节、人物神态、内心波动——让读者身临其境`;

  const lastSentence = ctx.previousNarrative
    ? ctx.previousNarrative.split(/[。！？\n]/).filter(s => s.trim()).pop()?.trim() || ''
    : '';

  let bridge = '';
  if (lastSentence) {
    bridge = `【承接指令——你必须严格照做】
上一段结尾句："${lastSentence}"

你的第一句话必须直接延续这个结尾。如果结尾在描述一个动作——就写这个动作的后续结果或反应。如果结尾在描述一个场景——就写人物对这个场景的感受。如果结尾是对话——就写说话人的神态或对方的回应。

禁止：第一句从头开始环境描写("晨雾...""阳光...""微风..."等)。环境可以出现在第二句以后。`;
  }

  const userPrompt = `${bridge}
【叙事提纲】
${outline}

【当前情境】
时间：${ctx.timeStr}，${ctx.timeFlavor}
地点：${ctx.playerName}在【${ctx.playerLocation}】
${ctx.playerLocationResources ? `此地可采集的资源：${ctx.playerLocationResources}` : ''}
${isWF ? `世界时间推进了${ctx.worldFlowDays || 5}天。变化：${ctx.worldFlowSummary || '无特殊变化'}` : `玩家行动：${ctx.playerAction}`}

【在场人物】
${ctx.nearbyNPCsStr || '周围无人'}

【续写要求】
1. 第一句必须承接上文结尾句——不能另起环境描写，不能和上一段开头雷同
2. 接下来按提纲推进，逐条覆盖
3. 结尾要自然收束，不要制造悬念钩子（人影/异响/谜题等），除非玩家在主动调查`;

  try {
    console.log('[写作AI] 准备调用 API, outline长度:', outline.length, 'chars');
    // 双保险：外层 90s 超时 + 内层 AbortController 60s
    const apiPromise = callDeepSeek(
      systemPrompt,
      userPrompt,
      { type: 'narrative_writing', gameTime: ctx.timeStr, flowNumber: getCurrentFlowNumber() },
      3000,
      0.85,
    );
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error('写作AI 外层超时(90s)')), 90_000);
    });
    try {
      const { text } = await Promise.race([apiPromise, timeoutPromise]);
      console.log('[写作AI] API 返回, text长度:', text?.length || 0, 'chars');
      const clean = text?.trim();
      return clean ? clean : fallbackNarrative(ctx);
    } finally {
      // 无论成功失败，都清除超时定时器，避免内存泄漏
      if (timeoutId) clearTimeout(timeoutId);
    }
  } catch (e: any) {
    console.error('[写作AI] 调用失败:', e.message, e.stack);
    return fallbackNarrative(ctx);
  }
}

// ══════════════════════════════════════════════════════════
//  Stage 3: 解析系统变更
// ══════════════════════════════════════════════════════════

async function extractChanges(
  ctx: NarrativeContext,
  narrative: string,
): Promise<WorldChangeSet> {
  const systemPrompt = `你是"${ctx.worldName}"的系统变更解析器。你的任务是从一段叙事文本中，提取出所有对游戏系统产生影响的真实变更。

【核心规则——必须严格遵守】
1. 只提取叙事中明确发生的、有因果关联的变化。不要凭空推测。
2. 资源ID、角色ID、地点ID必须使用下面列出的有效ID。
3. 如果没有明确的变化，对应字段留空对象 {} 或空数组 []。
4. 变化量必须是整数。
5. user prompt 中的【玩家实时状态】包含当前背包和数值——变更必须基于这些数据：
   - 消耗资源时，数量不能超过玩家背包中的持有量
   - 增加HP时，不能超过最大HP（30/30时HP变化为0）
   - 突破时须检查修炼条件是否满足

【资源处理规则】
- 叙事中明确写到的"获得/失去"资源 → 必须提取到 resource_changes
- 叙事中暗示的"劳动/工作/完成任务/帮忙"等行为 → 也应提取合理的资源变化
  （例如：叙事写了"蹲在田里除了半天草"→ 应提取 RES_灵石 +3~5、RES_灵草 +3~5）
- 叙事中描写玩家"采集/收集/搜寻/挖掘/拾取"等行为 → 必须从当前地点可采集资源中提取
  （例如：叙事写了"翻了翻井台边的石缝，摸到几块灵石"→ 应提取 RES_灵石 +3~5）
- 资源从哪来不需要追踪——系统会自动从资源池调配，你只管写谁获得了多少

【修炼与突破】
- 玩家涉及修炼/打坐/冥想 → 必须提取 resource_changes：
  消耗 RES_灵石 -5~20（修炼消耗灵气）、RES_修为进度 +5~20（修炼积累）
  如果玩家有 RES_基础功法 且积累够了，修为进度达到阈值时：
    - 同时扣减所需灵石和丹药 → p_level_changes: { "CHAR_player": 1 }
    - 同时 RES_修为进度归零（即 resource_changes 中写负数抵消当前进度）
    - 阈值参考：玩家状态中写了"突破需灵石X、丹药Y"
- 玩家修为突破也意味着实力增长，可酌情在 hp_changes 中增加 max_hp 对应量
- NPC 突破（叙事中写明其在修炼/战斗中有突破）→ p_level_changes 中记录对应 NPC 的 ID
- K 级变化（晋升/降级）：叙事中明确写到升职/降职 → k_level_changes

【使用物品】
- 玩家吃药/服丹/使用物品 → 在 resource_changes 中消耗对应资源（负数）
  并在 hp_changes 中增加HP（如果使用的是疗伤丹）或 state_changes 中标注状态变化
- 例如：叙事写"服了一颗疗伤丹"→ resource_changes: CHAR_player.RES_疗伤丹 -1, hp_changes: CHAR_player +10

【炼丹与打造】
- 玩家进行炼丹/打造/制作 → 在 resource_changes 中消耗对应材料（自行推断合理的材料组合）
  并在 item_transfers 中新增产出物品（from 填 POOL_SYSTEM）
- 例如：叙事写"用灵草配了些草药"→ resource_changes: CHAR_player.RES_灵草 -3, item_transfers: 新增 RES_丹药 +1
- 例如：叙事写"用铁矿锻造了一把剑"→ resource_changes: CHAR_player.RES_铁矿 -5, item_transfers: 新增 RES_铁剑 +1

【玩家赠予NPC物品】
- 玩家把东西给NPC → 在 item_transfers 中记录 from:CHAR_player, to:NPC的ID
  并在 relation_changes 中记录好感 +5~+15
- 例如：叙事写"给了王伯两株灵草"→ item_transfers: from CHAR_player to CHAR_wangbo resource RES_灵草 quantity 2

【物品转移——from 端规则】
- 如果叙事明确写了某个 NPC 给玩家东西（如"王伯递给林玄几株灵草"），from 填那个 NPC 的 ID
- 如果来源不明确（如"宗门发放""系统奖励""告示上的酬劳"），from 填 "POOL_SYSTEM"
- from 端不需要校验库存——系统会自动处理

【位置追踪——最重要】
玩家角色 ID = CHAR_player。
每当叙事中描述玩家"走向"、"来到"、"进入"、"踏入"、"到达"、"返回"某个地点时，必须在 position_changes 中记录：
  { "CHAR_player": "对应的地点ID" }
例如：叙事写到"林玄踏入功勋堂" → 必须记录 { "CHAR_player": "LOC_功勋堂" }
例如：叙事写到"他来到灵田" → 必须记录 { "CHAR_player": "LOC_灵田" }

【关系变化】
玩家每次与 NPC 互动（交谈、求助、交易、合作等），关系必定发生变化：
- 友好互动（求助、合作、赠送、帮忙）：好感 +5 ~ +15
- 冲突互动（争吵、拒绝、敌视）：好感 -5 ~ -15
必须在 relation_changes 中记录：
  { "CHAR_player": { "NPC的ID": 好感变化量 } }

【交互记忆——每次互动都要记录】
- 玩家与 NPC 有对话/互动/交易时 → 必须记录 interaction_memories
- 玩家获得资源（无论来源）→ 必须记录
- 格式：{"npc_id":"相关NPC的ID","summary":"互动内容摘要（30字内）","importance":0.5}
- 例如：与小石头交谈 → {"npc_id":"CHAR_xiaoshitou","summary":"向小石头打听了宗门规矩和功勋堂的路线","importance":0.5}
- 与 NPC 互动但没有资源转移也要记录——这不是可选的，是必需的

${ctx.worldCatalog}

输出JSON格式（严格遵守，不要任何解释文字，不要markdown代码块）：
{
  "resource_changes": { "角色ID或地点ID": { "资源ID": 变化量 } },
  "relation_changes": { "角色A_ID": { "角色B_ID": 好感度变化量 } },
  "position_changes": { "角色ID": "新地点ID" },
  "hp_changes": { "角色ID": HP变化量 },
  "state_changes": { "角色ID": "active|dormant|alert" },
  "p_level_changes": { "角色ID": 1或-1 },
  "k_level_changes": { "角色ID": 1或-1 },
  "item_transfers": [{"from":"角色ID（不明确则POOL_SYSTEM）","to":"角色ID","resource":"资源ID","quantity":数量}],
  "interaction_memories": [{"npc_id":"NPC的ID","summary":"玩家与此人互动的内容摘要（30字内）","importance":0.5}],
  "narrative_summary": "叙事摘要（50字内）"
}`;

  const userPrompt = `【玩家实时状态——变更必须基于这些数据】
身份：${ctx.playerIdentity}
修为：${ctx.playerPLevel} | HP：${ctx.playerHP}
${ctx.playerCultivationInfo ? `修炼：${ctx.playerCultivationInfo}` : ''}
所在：${ctx.playerLocation}${ctx.playerLocationResources ? ` | 此地可采集：${ctx.playerLocationResources}` : ''}
背包：${ctx.playerInventorySummary || '空'}

【叙事正文】
${narrative.slice(0, 3000)}

请提取所有系统变更，输出JSON。如果叙事中没有明确写到的变更，对应字段输出空对象{}。`;

  try {
    const { text } = await callDeepSeek(
      systemPrompt,
      userPrompt,
      { type: 'narrative_parsing', gameTime: ctx.timeStr, flowNumber: getCurrentFlowNumber() },
      1200,
      0.3,
    );
    return parseChangeSet(text, ctx);
  } catch (e: any) {
    console.error('[变更提取AI] 调用失败:', e.message);
    return emptyChangeSet();
  }
}

function parseChangeSet(text: string, ctx: NarrativeContext): WorldChangeSet {
  try {
    // 去除 markdown 包裹
    let jsonStr = text.trim();
    if (jsonStr.startsWith('```')) {
      const nlIdx = jsonStr.indexOf('\n');
      if (nlIdx !== -1) jsonStr = jsonStr.slice(nlIdx + 1);
      else jsonStr = jsonStr.slice(3); // 只有 ```xxx 没有换行
      const closeIdx = jsonStr.lastIndexOf('```');
      if (closeIdx !== -1) jsonStr = jsonStr.slice(0, closeIdx);
      jsonStr = jsonStr.trim();
    }
    // 提取 JSON 对象
    const match = jsonStr.match(/\{[\s\S]*\}/);
    if (!match) return emptyChangeSet();
    const parsed = JSON.parse(match[0]);

    // 校验并规范化
    return {
      resource_changes: validateResourceChanges(parsed.resource_changes || {}, ctx),
      relation_changes: validateRelationChanges(parsed.relation_changes || {}),
      position_changes: parsed.position_changes || {},
      hp_changes: validateHpChanges(parsed.hp_changes || {}),
      state_changes: validateStateChanges(parsed.state_changes || {}),
      p_level_changes: validateLevelChanges(parsed.p_level_changes || {}),
      k_level_changes: validateLevelChanges(parsed.k_level_changes || {}),
      item_transfers: validateItemTransfers(parsed.item_transfers),
      interaction_memories: Array.isArray(parsed.interaction_memories) ? parsed.interaction_memories.filter((m: any) => m.npc_id && m.summary) : [],
      narrative_summary: String(parsed.narrative_summary || '').slice(0, 100),
    };
  } catch {
    return emptyChangeSet();
  }
}

// ── 校验函数 ──

function validateResourceChanges(
  changes: Record<string, Record<string, number>>,
  ctx: NarrativeContext,
): Record<string, Record<string, number>> {
  const result: Record<string, Record<string, number>> = {};
  // 从 worldCatalog 中提取有效资源ID
  const catalogIds = extractIdsFromCatalog(ctx.worldCatalog, '资源');
  for (const [targetId, resMap] of Object.entries(changes)) {
    if (typeof resMap !== 'object') continue;
    const cleanResMap: Record<string, number> = {};
    for (const [resId, qty] of Object.entries(resMap)) {
      const numQty = Number(qty);
      if (isNaN(numQty)) continue;
      // 限制单次变化范围 [-100, 100]
      const clampedQty = Math.max(-100, Math.min(100, Math.round(numQty)));
      if (clampedQty === 0) continue;
      // 资源ID白名单校验（如果目录中有列表）
      if (catalogIds.size > 0 && !catalogIds.has(resId)) continue;
      cleanResMap[resId] = clampedQty;
    }
    if (Object.keys(cleanResMap).length > 0) {
      result[targetId] = cleanResMap;
    }
  }
  return result;
}

function validateRelationChanges(
  changes: Record<string, Record<string, number>>,
): Record<string, Record<string, number>> {
  const result: Record<string, Record<string, number>> = {};
  for (const [charA, rels] of Object.entries(changes)) {
    if (typeof rels !== 'object') continue;
    const cleanRels: Record<string, number> = {};
    for (const [charB, delta] of Object.entries(rels)) {
      if (charA === charB) continue;
      const numDelta = Number(delta);
      if (isNaN(numDelta)) continue;
      // 限制单次变化 [-30, 30]
      const clampedDelta = Math.max(-30, Math.min(30, Math.round(numDelta)));
      if (clampedDelta === 0) continue;
      cleanRels[charB] = clampedDelta;
    }
    if (Object.keys(cleanRels).length > 0) {
      result[charA] = cleanRels;
    }
  }
  return result;
}

function validateHpChanges(changes: Record<string, number>): Record<string, number> {
  const result: Record<string, number> = {};
  for (const [charId, delta] of Object.entries(changes)) {
    const numDelta = Number(delta);
    if (isNaN(numDelta)) continue;
    const clampedDelta = Math.max(-50, Math.min(50, Math.round(numDelta)));
    if (clampedDelta === 0) continue;
    result[charId] = clampedDelta;
  }
  return result;
}

function validateStateChanges(changes: Record<string, string>): Record<string, string> {
  const validStates = new Set(['active', 'dormant', 'alert']);
  const result: Record<string, string> = {};
  for (const [charId, state] of Object.entries(changes)) {
    if (validStates.has(state)) {
      result[charId] = state;
    }
  }
  return result;
}

function validateLevelChanges(changes: Record<string, number>): Record<string, number> {
  const result: Record<string, number> = {};
  for (const [charId, delta] of Object.entries(changes)) {
    const numDelta = Number(delta);
    if (isNaN(numDelta)) continue;
    // 每次只能±1级
    if (numDelta !== 1 && numDelta !== -1) continue;
    result[charId] = numDelta;
  }
  return result;
}

function validateItemTransfers(transfers: any): { from: string; to: string; resource: string; quantity: number }[] {
  if (!Array.isArray(transfers)) return [];
  const result: { from: string; to: string; resource: string; quantity: number }[] = [];
  for (const t of transfers) {
    if (!t || typeof t !== 'object') continue;
    const from = String(t.from || '').trim();
    const to = String(t.to || '').trim();
    const resource = String(t.resource || '').trim();
    const quantity = Math.max(1, Math.min(50, Math.round(Number(t.quantity) || 0)));
    // 必须包含 from、to、resource 三个字段，且 quantity 合法
    if (!from || !to || !resource || quantity <= 0) continue;
    result.push({ from, to, resource, quantity });
  }
  return result;
}

function extractIdsFromCatalog(catalog: string, type: string): Set<string> {
  // 简单解析目录中的 ID 列表
  const ids = new Set<string>();
  const section = catalog.split(`【${type}】`)[1]?.split('【')[0] || '';
  const idMatches = section.matchAll(/[\w_]+/g);
  for (const m of idMatches) {
    if (m[0].length > 3) ids.add(m[0]);
  }
  return ids;
}

// ══════════════════════════════════════════════════════════
//  工具函数
// ══════════════════════════════════════════════════════════

function emptyChangeSet(): WorldChangeSet {
  return {
    resource_changes: {},
    relation_changes: {},
    position_changes: {},
    hp_changes: {},
    state_changes: {},
    p_level_changes: {},
    k_level_changes: {},
    item_transfers: [],
    interaction_memories: [],
    narrative_summary: '',
  };
}

function fallbackNarrative(ctx: NarrativeContext): string {
  if (ctx.mode === 'world_flow') {
    return `时光流转，${ctx.worldFlowDays || 5}天过去了。${ctx.worldName}的日常仍在继续——修士们来来往往，坊市的叫卖声此起彼伏，远处的山峦在云雾中若隐若现。

${ctx.playerName}依然身在【${ctx.playerLocation}】。${ctx.playerLocationDesc}

这几日里，${ctx.playerName}感受着天地间流转的灵气，思考着接下来的道路。修真之途漫长而艰辛，但每一步都值得。`;
  }

  return `${ctx.timeStr}，${ctx.timeFlavor}。


${ctx.playerName}身在【${ctx.playerLocation}】——${ctx.playerLocationDesc}

${ctx.playerName}是一名${ctx.playerIdentity}，在这片修真大陆上追寻着自己的道路。周围的一切看似平静，但机运与危险往往只有一线之隔。`;
}
