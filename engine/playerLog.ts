// 引擎层 —— 玩家操作日志
// 在两次世界流之间记录玩家的所有操作，供世界流开始时 AI 总结
// 持久化到 OPFS，页面刷新不丢失

import type { PlayerActionRecord, GameTime } from './types';
import { getRoot } from './db';

const MAX_RECORDS = 100;
const FILENAME = 'playerLogs.json';

let _records: PlayerActionRecord[] = [];
let _idCounter = 0;
let _loaded = false;

async function load(): Promise<void> {
  if (_loaded) return;
  try {
    const root = await getRoot();
    const fh = await root.getFileHandle(FILENAME, { create: true });
    const file = await fh.getFile();
    const text = await file.text();
    if (text.trim()) {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) _records = parsed;
      if (_records.length > 0) {
        _idCounter = Math.max(..._records.map(r => parseInt(r.id.split('_').pop() || '0'))) || 0;
      }
    }
  } catch (e) { console.error('[playerLog] load 失败:', e); }
  _loaded = true;
}

async function save(): Promise<void> {
  try {
    const root = await getRoot();
    const fh = await root.getFileHandle(FILENAME, { create: true });
    const writable = await fh.createWritable();
    await writable.write(JSON.stringify(_records));
    await writable.close();
  } catch (e) { console.error('[playerLog] save 失败:', e); }
}

function nextId(): string {
  return `pa_${Date.now()}_${++_idCounter}`;
}

// ── 初始化：页面加载时恢复记录 ──
export async function initPlayerLog(): Promise<void> {
  await load();
}

// ── 记录一次玩家操作 ──
export async function logPlayerAction(
  type: PlayerActionRecord['type'],
  targetName: string,
  summary: string,
  detail: string,
  timestamp: GameTime,
): Promise<void> {
  // 确保已加载
  if (!_loaded) { await load(); }
  _doLog(type, targetName, summary, detail, timestamp);
  await save();
}

function _doLog(
  type: PlayerActionRecord['type'],
  targetName: string,
  summary: string,
  detail: string,
  timestamp: GameTime,
): void {
  _records.push({
    id: nextId(),
    timestamp,
    type,
    targetName,
    summary: summary.slice(0, 60),
    detail: detail.slice(0, 200),
    processed: false,
  });

  if (_records.length > MAX_RECORDS) {
    _records = _records.slice(-MAX_RECORDS);
  }
}

// ── 获取所有未处理的操作记录 ──
export function getUnprocessedActions(): PlayerActionRecord[] {
  if (!_loaded) return [];
  return _records.filter(r => !r.processed);
}

// ── 获取所有记录（含已处理的） ──
export function getAllActions(): PlayerActionRecord[] {
  if (!_loaded) return [];
  return [..._records];
}

// ── 标记所有记录为已处理 ──
export async function markAllProcessed(flowNumber: number): Promise<void> {
  for (const r of _records) {
    r.processed = true;
    r.flowNumber = flowNumber;
  }
  await save();
}

// ── 清空所有记录（世界流处理完成后调用） ──
export async function clearAllActions(): Promise<void> {
  _records = [];
  _idCounter = 0;
  await save();
}

// ── 获取记录数量 ──
export function getActionCount(): number {
  return _records.length;
}
