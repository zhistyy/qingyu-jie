// 转化层 —— 创造资源 AI 认证 + 主入口
// 从 engine/creation.ts 提取 AI 认证相关代码

import type {
  GameTime, WorldCardConfig,
  Rarity, PathwayCache,
  ResourceTypeDef, ResourceCategory,
} from '../engine/types';
import { loadPathwayCache, savePathwayCache } from '../engine/db';
import { addResource } from '../engine/crud';
import { timeToString } from '../engine/time';
import { buildCreationPathwayKey } from '../engine/creation';
import { inferCategoryFromId, inferNameFromId } from '../engine/creation';
import type { CreationResult } from '../engine/creation';
import { callDeepSeek } from '../engine/agent';

// ══════════════════════════════════════════
//  类型定义
// ══════════════════════════════════════════

interface AiCertResponse {
  reasonable: boolean;
  reason: string;
  suggestedRarity?: Rarity;
  suggestedCategory?: ResourceCategory;
  suggestedName?: string;
}

const RARITY_VALUES: Rarity[] = ['r1', 'r2', 'r3', 'r4', 'r5', 'r6'];
const CATEGORY_VALUES: ResourceCategory[] = ['material', 'currency', 'consumable', 'skill', 'cultivation', 'equipment'];

// ══════════════════════════════════════════
//  辅助函数（使用 engine/creation.ts 中的共享实现）
// ══════════════════════════════════════════

// ── 资源校验 ──

interface ValidationResult {
  valid: boolean;
  error?: string;
  newResources: ResourceTypeDef[];
}

function validateAndRegisterResources(
  inputs: { resource_type_id: string; quantity: number }[],
  outputs: { resource_type_id: string; quantity: number }[],
  config: WorldCardConfig,
  operationType: string,
): ValidationResult {
  const newResources: ResourceTypeDef[] = [];

  for (const input of inputs) {
    const exists = config.resource_types.find(rt => rt.resource_type_id === input.resource_type_id);
    if (!exists) {
      return {
        valid: false,
        error: `输入资源「${input.resource_type_id}」在世界中不存在。请检查资源ID是否正确。`,
        newResources: [],
      };
    }
  }

  for (const output of outputs) {
    const exists = config.resource_types.find(rt => rt.resource_type_id === output.resource_type_id);
    if (!exists) {
      const def: ResourceTypeDef = {
        resource_type_id: output.resource_type_id,
        name: inferNameFromId(output.resource_type_id),
        category: inferCategoryFromId(output.resource_type_id),
        rarity: 'r1',
        base_value: 1,
        stackable: true,
        description: `${operationType}操作的产物`,
      };
      config.resource_types.push(def);
      newResources.push(def);
    }
  }

  return { valid: true, newResources };
}

// ══════════════════════════════════════════
//  AI 响应解析
// ══════════════════════════════════════════

function parseAiResponse(text: string): { ok: boolean; result?: AiCertResponse; error?: string } {
  let cleaned = text.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
  
  const firstBrace = cleaned.indexOf('{');
  const lastBrace = cleaned.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    cleaned = cleaned.slice(firstBrace, lastBrace + 1);
  }

  let parsed: any;
  try {
    parsed = JSON.parse(cleaned);
  } catch (e) {
    console.warn('[creationCertify] parseAiResponse 解析失败:', e);
    return { ok: false, error: `AI返回无法解析为JSON: ${text.slice(0, 100)}` };
  }

  if (typeof parsed.reasonable !== 'boolean') {
    return { ok: false, error: 'AI返回缺失 required 字段: reasonable' };
  }
  if (typeof parsed.reason !== 'string' || parsed.reason.length === 0) {
    return { ok: false, error: 'AI返回缺失 required 字段: reason' };
  }

  const result: AiCertResponse = {
    reasonable: parsed.reasonable,
    reason: parsed.reason.slice(0, 100),
  };

  if (parsed.suggestedRarity && RARITY_VALUES.includes(parsed.suggestedRarity)) {
    result.suggestedRarity = parsed.suggestedRarity as Rarity;
  }
  if (parsed.suggestedCategory && CATEGORY_VALUES.includes(parsed.suggestedCategory)) {
    result.suggestedCategory = parsed.suggestedCategory as ResourceCategory;
  }
  if (parsed.suggestedName && typeof parsed.suggestedName === 'string' && parsed.suggestedName.length > 0) {
    result.suggestedName = parsed.suggestedName.slice(0, 30);
  }

  return { ok: true, result };
}

// ══════════════════════════════════════════
//  AI 认证创造通路
// ══════════════════════════════════════════

export async function aiCertifyCreate(
  characterId: string,
  operationType: string,
  inputs: { resource_type_id: string; quantity: number }[],
  outputs: { resource_type_id: string; quantity: number }[],
  newResources: ResourceTypeDef[],
  worldName: string,
  config: WorldCardConfig,
  time: GameTime,
): Promise<{ certified: boolean; pathwayKey: string; narrative: string; tokenCost: number }> {
  const pathwayKey = buildCreationPathwayKey(worldName, operationType, inputs, outputs);
  const gameTimeStr = timeToString(time);

  const inputDesc = inputs.map(i => {
    const def = config.resource_types.find(rt => rt.resource_type_id === i.resource_type_id);
    return `${def?.name ?? i.resource_type_id}(${def?.rarity ?? '?'}) ×${i.quantity}`;
  }).join('、');
  const outputDesc = outputs.map(o => {
    const def = config.resource_types.find(rt => rt.resource_type_id === o.resource_type_id);
    return `${def?.name ?? o.resource_type_id}(${def?.rarity ?? '?'}) ×${o.quantity}`;
  }).join('、');

  let newResHint = '';
  if (newResources.length > 0) {
    newResHint = `\n注意：以下产出资源在世界配置中不存在，请判断它们是否合理并建议稀有度：\n`;
    newResHint += newResources.map(nr => `  - ${nr.resource_type_id}（当前默认稀有度: ${nr.rarity}，类型：${nr.category}）`).join('\n');
    newResHint += `\n如果合理，请在JSON中添加 suggestedRarity（白/绿/蓝/紫/红）和 suggestedCategory（material/currency/consumable/skill/cultivation/equipment）字段。`;
  }

  const systemPrompt = `你是修仙/奇幻世界的规则裁判。判断资源转换是否合理。必须回复合法JSON：{"reasonable":true/false,"reason":"理由30字内"${newResources.length > 0 ? ',"suggestedRarity":"白/绿/蓝/紫/红","suggestedCategory":"类型","suggestedName":"名称"' : ''}}。不要输出其他内容。`;

  const userPrompt = `世界：${config.world_name}（${config.world_description.slice(0, 200)}）
操作类型：${operationType}
投入：${inputDesc || '无'}
产出：${outputDesc || '无'}
世界规则：${config.prompt_config.world_rules_summary.slice(0, 200)}${newResHint}

这个转换在当前世界规则下是否合理？`;

  try {
    const { text } = await callDeepSeek(
      systemPrompt,
      userPrompt,
      {
        type: 'creation_certify',
        gameTime: gameTimeStr,
        flowNumber: undefined,
      },
      200,
      0.3,
    );

    const parseResult = parseAiResponse(text);
    if (!parseResult.ok) {
      return { certified: false, pathwayKey, narrative: `解析失败: ${parseResult.error}`, tokenCost: 0 };
    }

    const aiResult = parseResult.result!;

    if (!aiResult.reasonable) {
      return { certified: true, pathwayKey, narrative: `AI判定不合理：${aiResult.reason}`, tokenCost: 0 };
    }

    for (const nr of newResources) {
      if (aiResult.suggestedRarity) nr.rarity = aiResult.suggestedRarity;
      if (aiResult.suggestedCategory) nr.category = aiResult.suggestedCategory;
      if (aiResult.suggestedName) nr.name = aiResult.suggestedName;
    }

    const pathwayEntry: PathwayCache = {
      id: pathwayKey,
      world_name: worldName,
      operation_type: operationType,
      inputs: Object.fromEntries(inputs.map(i => [i.resource_type_id, i.quantity])),
      outputs: Object.fromEntries(outputs.map(o => [o.resource_type_id, o.quantity])),
      certified_at: new Date().toISOString(),
      token_cost: 0,
      ai_judgement: aiResult.reason,
    };
    await savePathwayCache(pathwayEntry);

    return { certified: true, pathwayKey, narrative: aiResult.reason, tokenCost: 0 };
  } catch (e: any) {
    return { certified: false, pathwayKey, narrative: `网络异常，降级为允许`, tokenCost: 0 };
  }
}
