// 命石系统 — 跨世界 meta-currency
// 存储于 OPFS destinyStones.json，不随世界流重置

import type { CharacterInstance, WorldState } from './types';
import { getRoot } from './db';
import { RES_SPIRIT_STONE, RES_HEALING_PILL, RES_BASIC_SWORD, RES_IRON_SWORD } from './config';

// ── OPFS 存储（带内存缓存） ──
interface DestinyStore {
  stones: number;
  total_earned: number;
  history: { amount: number; reason: string; time: number }[];
}

let _cache: DestinyStore | null = null;

async function loadDestiny(): Promise<DestinyStore> {
  if (_cache) return _cache;
  try {
    const root = await getRoot();
    const fh = await root.getFileHandle('destinyStones.json', { create: true });
    const file = await fh.getFile();
    const text = await file.text();
    _cache = JSON.parse(text);
    return _cache;
  } catch (e) {
    console.warn('[destiny] loadDestiny 加载失败，使用默认存储:', e);
    _cache = { stones: 0, total_earned: 0, history: [] };
    return _cache;
  }
}

async function saveDestiny(ds: DestinyStore): Promise<void> {
  _cache = ds;
  const root = await getRoot();
  const fh = await root.getFileHandle('destinyStones.json', { create: true });
  const writable = await fh.createWritable();
  await writable.write(JSON.stringify(ds));
  await writable.close();
}

export async function getDestinyStones(): Promise<number> {
  const ds = await loadDestiny();
  return ds.stones;
}

export async function getDestinyHistory(): Promise<DestinyStore['history']> {
  const ds = await loadDestiny();
  return ds.history;
}

// ── 结算：世界结束时计算命石 ──
export async function settleDestiny(
  player: CharacterInstance,
  worldState: WorldState
): Promise<{ earned: number; breakdown: string[] }> {
  let total = 1; // 基础完成奖励
  const breakdown: string[] = ['完成世界 +1'];

  // P 层级奖励
  const pBonus = player.stats.p_level * 5;
  if (pBonus > 0) { total += pBonus; breakdown.push(`修为 ${player.stats.p_level}级 +${pBonus}`); }

  // K 层级奖励
  const kBonus = player.identity.k_level * 3;
  if (kBonus > 0) { total += kBonus; breakdown.push(`身份 ${player.identity.k_level}级 +${kBonus}`); }

  // 世界流奖励
  const cultBonus = Math.floor(player.stats.cultivation_progress * 10);
  if (cultBonus > 0) { total += cultBonus; breakdown.push(`修炼进度 +${cultBonus}`); }

  // 好感度奖励（每 100 好感 +1）
  const affBonus = Math.floor(player.relationships.reduce((sum, r) => sum + Math.max(0, r.affinity), 0) / 100);
  if (affBonus > 0) { total += affBonus; breakdown.push(`人脉 +${affBonus}`); }

  // 世界流奖励
  const flowBonus = Math.floor(worldState.flow_count / 10);
  if (flowBonus > 0) { total += flowBonus; breakdown.push(`世界流 ${worldState.flow_count}次 +${flowBonus}`); }

  // 存储
  const ds = await loadDestiny();
  ds.stones += total;
  ds.total_earned += total;
  ds.history.push({ amount: total, reason: `世界结算: ${player.name} P${player.stats.p_level} K${player.identity.k_level}`, time: Date.now() });
  await saveDestiny(ds);

  return { earned: total, breakdown };
}

// ── 消耗命石（购买增强时调用） ──
export async function spendDestiny(amount: number, reason: string): Promise<boolean> {
  const ds = await loadDestiny();
  if (ds.stones < amount) return false;
  ds.stones -= amount;
  ds.history.push({ amount: -amount, reason, time: Date.now() });
  await saveDestiny(ds);
  return true;
}

// ── 命石商店商品定义 ──
export interface DestinyShopItem {
  id: string;
  name: string;
  description: string;
  cost: number;
  apply: (chars: import('./types').CharacterInstance[]) => void; // 修改角色初始状态
  repeatable?: boolean;
}

export const DESTINY_SHOP: DestinyShopItem[] = [
  {
    id: 'hp_10', name: '生命强化', description: '初始 HP +10', cost: 2,
    apply: (chars) => { const p = chars.find(c => c.is_player); if (p) { p.stats.hp += 10; p.stats.max_hp += 10; } },
  },
  {
    id: 'pow_5', name: '战力强化', description: '初始战力 +5', cost: 3,
    apply: (chars) => { const p = chars.find(c => c.is_player); if (p) p.stats.base_combat_power += 5; },
  },
  {
    id: 'start_p1', name: '天生灵根', description: '初始修为 P1（练气）', cost: 8,
    apply: (chars) => { const p = chars.find(c => c.is_player); if (p) p.stats.p_level = 1; },
  },
  {
    id: 'spirit_50', name: '灵石积蓄', description: '初始灵石 ×50', cost: 3,
    apply: (chars) => {
      const p = chars.find(c => c.is_player);
      if (p) {
        const s = p.inventory.find(i => i.resource_type_id === RES_SPIRIT_STONE);
        if (s) s.quantity += 50; else p.inventory.push({ resource_type_id: RES_SPIRIT_STONE, quantity: 50, last_updated: { year: 0, season: '春', day: 1, timeOfDay: '卯时' }, location_id: p.character_id });
      }
    },
  },
  {
    id: 'sword', name: '铁剑', description: '初始携带铁剑', cost: 2,
    apply: (chars) => {
      const p = chars.find(c => c.is_player);
      if (p) p.inventory.push({ resource_type_id: RES_IRON_SWORD, quantity: 1, last_updated: { year: 0, season: '春', day: 1, timeOfDay: '卯时' }, location_id: p.character_id });
    },
  },
  {
    id: 'potion', name: '疗伤丹', description: '初始携带疗伤丹 ×3', cost: 1,
    apply: (chars) => {
      const p = chars.find(c => c.is_player);
      if (p) p.inventory.push({ resource_type_id: RES_HEALING_PILL, quantity: 3, last_updated: { year: 0, season: '春', day: 1, timeOfDay: '卯时' }, location_id: p.character_id });
    },
  },
  {
    id: 'skill_sword', name: '基础剑法', description: '初始掌握基础剑法', cost: 5,
    apply: (chars) => {
      const p = chars.find(c => c.is_player);
      if (p) p.inventory.push({ resource_type_id: RES_BASIC_SWORD, quantity: 1, last_updated: { year: 0, season: '春', day: 1, timeOfDay: '卯时' }, location_id: p.character_id });
    },
  },
];
