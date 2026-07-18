import { addResource } from './crud';
import type { GameTime, Recipe, ResourceTypeDef, WorldCardConfig, CharacterInstance, Rarity } from './types';
import { loadCharacter } from './db';

// 稀有度对应的最小K层级（通用映射）
const RARITY_TO_MIN_K: Record<Rarity, number> = { 'r1': 1, 'r2': 2, 'r3': 3, 'r4': 4, 'r5': 5, 'r6': 6 };

// K层级管辖：NPC的K层级能否自由编撰产生该稀有度的资源
export function canNpcFreelyGiveResource(npcKLevel: number, rarity: Rarity): boolean {
  return npcKLevel >= RARITY_TO_MIN_K[rarity];
}

// 稀有度对应的最小K层级
export function getMinKForRarity(rarity: Rarity): number {
  return RARITY_TO_MIN_K[rarity];
}

// 产出
export async function produce(targetId: string, resourceType: string, amount: number, time: GameTime): Promise<void> {
  await addResource(targetId, resourceType, amount, time, '产出');
}

// 消耗
export async function consume(targetId: string, resourceType: string, amount: number, time: GameTime): Promise<{ok:boolean;error?:string}> {
  const result = await addResource(targetId, resourceType, -amount, time, '消耗');
  return { ok: result.ok, error: result.error };
}

// 加工 — 纯本地，多消耗+单产出
export async function process(
  characterId: string, recipe: Recipe, time: GameTime
): Promise<{ok:boolean;error?:string;outputs?:{resource_type_id:string;quantity:number}[]}> {
  const ch = await loadCharacter(characterId);
  if (!ch) return { ok: false, error: '角色不存在' };

  for (const skillId of recipe.prerequisite_skills) {
    const hasSkill = ch.inventory.some(r => r.resource_type_id === skillId && r.quantity > 0);
    if (!hasSkill) return { ok: false, error: `缺少前置技能: ${skillId}` };
  }

  for (const input of recipe.inputs) {
    const res = ch.inventory.find(r => r.resource_type_id === input.resource_type_id);
    if (!res || res.quantity < input.quantity) return { ok: false, error: `资源不足: ${input.resource_type_id} 需要 ${input.quantity}` };
  }

  for (const input of recipe.inputs) {
    const r = await consume(characterId, input.resource_type_id, input.quantity, time);
    if (!r.ok) return { ok: false, error: `消耗失败: ${r.error}` };
  }

  for (const output of recipe.outputs) {
    await produce(characterId, output.resource_type_id, output.quantity, time);
  }

  return { ok: true, outputs: recipe.outputs };
}

// 兑换
export async function exchange(
  characterId: string, fromResource: string, toResource: string,
  fromAmount: number, rate: number, time: GameTime
): Promise<{ok:boolean;error?:string}> {
  const consumeResult = await consume(characterId, fromResource, fromAmount, time);
  if (!consumeResult.ok) return consumeResult;
  const toAmount = Math.floor(fromAmount * rate);
  await produce(characterId, toResource, toAmount, time);
  return { ok: true };
}
