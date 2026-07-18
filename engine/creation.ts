// 引擎层 —— 创造系统（纯逻辑，世界观无关）
// AI 认证部分已移至 transform/creationCertify.ts

import type { GameTime, WorldCardConfig, ResourceTypeDef, ResourceCategory } from './types';
import { loadCharacter } from './db';
import { addResource } from './crud';

export interface CreationResult {
  ok: boolean;
  error?: string;
  outputs?: { resource_type_id: string; quantity: number }[];
  pathway_key?: string;
  certified?: boolean;
  narrative?: string;
  token_cost?: number;
}

export function inferCategoryFromId(resourceTypeId: string): ResourceCategory {
  const id = resourceTypeId.toLowerCase();
  if (id.includes('修为') || id.includes('境界') || id.includes('层')) return 'cultivation';
  if (id.includes('技能') || id.includes('剑法') || id.includes('身法') || id.includes('功法') || id.includes('术')) return 'skill';
  if (id.includes('丹') || id.includes('药') || id.includes('酒') || id.includes('粮') || id.includes('符')) return 'consumable';
  if (id.includes('剑') || id.includes('甲') || id.includes('衣') || id.includes('刀') || id.includes('袍')) return 'equipment';
  if (id.includes('灵石') || id.includes('金币') || id.includes('银')) return 'currency';
  return 'material';
}

export function inferNameFromId(resourceTypeId: string): string {
  const parts = resourceTypeId.replace('RES_', '').split(':');
  if (parts.length > 1) return parts[parts.length - 1];
  return parts[0] || resourceTypeId;
}

export function buildCreationPathwayKey(
  worldName: string, operationType: string,
  inputs: { resource_type_id: string; quantity: number }[],
  outputs: { resource_type_id: string; quantity: number }[],
): string {
  const sortedInputs = [...inputs].sort((a, b) => a.resource_type_id.localeCompare(b.resource_type_id));
  const sortedOutputs = [...outputs].sort((a, b) => a.resource_type_id.localeCompare(b.resource_type_id));
  return `${worldName}::${operationType}::${JSON.stringify(sortedInputs)}::${JSON.stringify(sortedOutputs)}`;
}

export async function localCreate(
  characterId: string,
  inputs: { resource_type_id: string; quantity: number }[],
  outputs: { resource_type_id: string; quantity: number }[],
  time: GameTime,
  config: WorldCardConfig,
): Promise<CreationResult> {
  const ch = await loadCharacter(characterId);
  if (!ch) return { ok: false, error: '角色不存在' };

  for (const output of outputs) {
    if (!config.resource_types.find(rt => rt.resource_type_id === output.resource_type_id)) {
      return { ok: false, error: `产出资源「${output.resource_type_id}」在世界中不存在。` };
    }
  }

  for (const input of inputs) {
    const res = ch.inventory.find(r => r.resource_type_id === input.resource_type_id);
    if (!res || res.quantity < input.quantity) {
      return { ok: false, error: `资源不足: ${input.resource_type_id} 需要 ${input.quantity}，当前 ${res?.quantity ?? 0}` };
    }
  }

  for (const input of inputs) {
    await addResource(characterId, input.resource_type_id, -input.quantity, time, '创造消耗');
  }
  for (const output of outputs) {
    await addResource(characterId, output.resource_type_id, output.quantity, time, '创造产出');
  }

  return { ok: true, outputs };
}
