// 引擎层 —— 资源池（单端操作缓冲层）
// 系统级资源流动（任务奖励、叙事变更、世界流）不要求双端守恒。
// 池子作为中间缓冲：角色获得 → 从池扣；角色失去 → 上交池子。
// NPC 间直接交互（对话赠予/交易）仍走双端校验，不走池子。
//
// 持久化：独立 OPFS 文件 pool.json

import type { GameTime } from './types';
import { getRoot } from './db';

const POOL_FILE = 'pool.json';

export interface PoolState {
  resources: Record<string, number>;  // 资源ID → 数量（允许为负，表示透支）
  last_updated: GameTime;
}

let _pool: PoolState | null = null;

async function loadPool(): Promise<PoolState> {
  if (_pool) return _pool;
  try {
    const root = await getRoot();
    const fh = await root.getFileHandle(POOL_FILE, { create: true });
    const file = await fh.getFile();
    const text = await file.text();
    if (text.trim()) {
      _pool = JSON.parse(text);
    }
  } catch (e) {
    console.warn('[资源池] 加载失败，使用空池:', e);
  }
  if (!_pool) {
    _pool = { resources: {}, last_updated: { year: 0, season: '春', day: 1, timeOfDay: '卯时' } };
  }
  return _pool;
}

async function savePool(): Promise<void> {
  if (!_pool) return;
  try {
    const root = await getRoot();
    const fh = await root.getFileHandle(POOL_FILE, { create: true });
    const w = await fh.createWritable();
    await w.write(JSON.stringify(_pool));
    await w.close();
  } catch (e) {
    console.error('[资源池] 保存失败:', e);
  }
}

/** 从池中扣除资源，返回实际扣除量 */
export async function deductFromPool(resourceTypeId: string, amount: number): Promise<number> {
  const pool = await loadPool();
  amount = Math.max(0, Math.round(amount));
  const current = pool.resources[resourceTypeId] ?? 0;
  // 允许透支：池子余额可以为负
  pool.resources[resourceTypeId] = current - amount;
  await savePool();
  return amount;
}

/** 往池中存入资源，返回存入后的总量 */
export async function depositToPool(resourceTypeId: string, amount: number): Promise<number> {
  const pool = await loadPool();
  amount = Math.max(0, Math.round(amount));
  const current = pool.resources[resourceTypeId] ?? 0;
  pool.resources[resourceTypeId] = current + amount;
  await savePool();
  return pool.resources[resourceTypeId];
}

/** 查询池中某资源的当前余额 */
export async function getPoolBalance(resourceTypeId: string): Promise<number> {
  const pool = await loadPool();
  return pool.resources[resourceTypeId] ?? 0;
}

/** 获取全部池子状态（调试用） */
export async function getPoolState(): Promise<PoolState> {
  return loadPool();
}

/** 首次初始化时注入初始资源种子 */
export async function seedPool(seeds: Record<string, number>, time: GameTime): Promise<void> {
  const pool = await loadPool();
  for (const [resId, qty] of Object.entries(seeds)) {
    pool.resources[resId] = (pool.resources[resId] ?? 0) + qty;
  }
  pool.last_updated = time;
  await savePool();
}

/** 清空池子（调试/重置用） */
export async function clearPool(): Promise<void> {
  _pool = { resources: {}, last_updated: { year: 0, season: '春', day: 1, timeOfDay: '卯时' } };
  await savePool();
}

/** 手动设置池子中某资源的数量 */
export async function setPoolResource(resourceTypeId: string, amount: number): Promise<void> {
  const pool = await loadPool();
  pool.resources[resourceTypeId] = amount;
  await savePool();
}
