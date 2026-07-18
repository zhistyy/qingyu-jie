// 青云界 · 跨页面状态管理（OPFS）
// 每个页面在跳转前调用 saveAppState，加载时调用 loadAppState

import { OPFS_ROOT } from '../engine/config.js';
import { xianxiaConfig } from '../data/xianxia.js';
import { timeToString } from '../engine/time.js';

const STATE_FILE = 'app_state.json';

let rootDir = null;
async function getRoot() {
  if (rootDir) return rootDir;
  const opfsRoot = await navigator.storage.getDirectory();
  rootDir = await opfsRoot.getDirectoryHandle(OPFS_ROOT, { create: true });
  return rootDir;
}

/** 保存当前应用状态到 OPFS（页面跳转前调用） */
export async function saveAppState(state) {
  const root = await getRoot();
  const fh = await root.getFileHandle(STATE_FILE, { create: true });
  const w = await fh.createWritable();
  await w.write(JSON.stringify(state));
  await w.close();
}

/** 从 OPFS 加载应用状态（页面加载时调用） */
export async function loadAppState() {
  try {
    const root = await getRoot();
    const fh = await root.getFileHandle(STATE_FILE, { create: true });
    const file = await fh.getFile();
    const text = await file.text();
    return text.trim() ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

/** 清除应用状态 */
export async function clearAppState() {
  try {
    const root = await getRoot();
    await root.removeEntry(STATE_FILE);
  } catch { /* not exist */ }
}

// ── 从映射配置同步的常量 ──
function _buildRarityMaps() {
  const colors = {}, names = {};
  for (const [k, v] of Object.entries(xianxiaConfig.mapping.rarity_names)) {
    colors[k] = v.color;
    names[k] = v.name;
  }
  return { colors, names };
}
const _rm = _buildRarityMaps();
export const RARITY_COLORS = _rm.colors;
export const RARITY_NAMES = _rm.names;

// ── 工具 ──
export const $ = (id) => document.getElementById(id);

/** 格式化时间戳为可读字符串 */
export function formatTime(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
}

/** 将精确数量转为模糊量词（用于 NPC 展示） */
export function fuzzyQuantity(qty) {
  if (!qty || qty <= 0) return '';
  if (qty <= 3) return '少许';
  if (qty <= 10) return '一些';
  if (qty <= 30) return '不少';
  return '大量';
}

export { timeToString };
