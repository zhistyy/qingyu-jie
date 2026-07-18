// 引擎层 —— 共享配置
// API Key 由用户在设置页面填写，存入 localStorage
// 集中管理所有共享常量

// ── AI 配置 ──
export const API_URL = 'https://api.deepseek.com/chat/completions';
export const MODEL_NAME = 'deepseek-chat';
export const DEFAULT_MAX_TOKENS = 500;
export const DEFAULT_TEMPERATURE = 0.7;
export const API_TIMEOUT_MS = 60_000; // 60秒，避免长时间卡住

// ── localStorage 键 ──
const STORAGE_KEY = 'qyj_api_key';

export function getAPIKey(): string {
  return localStorage.getItem(STORAGE_KEY) || '';
}

export function setAPIKey(key: string): void {
  localStorage.setItem(STORAGE_KEY, key.trim());
}

export function hasAPIKey(): boolean {
  return !!localStorage.getItem(STORAGE_KEY);
}

// ── OPFS 目录名 ──
export const OPFS_ROOT = 'to-rpg';

// ── 存档 ──
export const SAVES_DIR = 'saves';
export const TOTAL_SAVE_SLOTS = 20;

// ── 资源 ID 常量 ──
export const RES_SPIRIT_STONE = 'RES_灵石';
export const RES_PILL = 'RES_丹药';
export const RES_HEALING_PILL = 'RES_疗伤丹';
export const RES_HERB = 'RES_灵草';
export const RES_CULTIVATION_PROGRESS = 'RES_修为进度';
export const RES_WINE = 'RES_酒';
export const RES_RATION = 'RES_干粮';
export const RES_RADISH = 'RES_萝卜';
export const RES_CABBAGE = 'RES_白菜';
export const RES_TALISMAN = 'RES_符箓';
export const RES_BASIC_SWORD = 'RES_基础剑法';
export const RES_ADVANCED_SWORD = 'RES_高阶剑法';
export const RES_BODY_TECHNIQUE = 'RES_身法';
export const RES_ALCHEMY_SKILL = 'RES_炼丹技能';
export const RES_TALISMAN_SKILL = 'RES_制符技能';
export const RES_REFINING_SKILL = 'RES_炼器技能';
export const RES_BASIC_MANUAL = 'RES_基础功法';
export const RES_RESTORE_PILL = 'RES_回气丹';
export const RES_IRON_SWORD = 'RES_铁剑';
export const RES_SPIRIT_CRYSTAL = 'RES_灵晶';
export const RES_ANCIENT_FRAGMENT = 'RES_古宝碎片';

// ── 玩家 ID ──
export const PLAYER_CHAR_ID = 'CHAR_player';

// ── 世界流触发阈值：每N次玩家交互后自动触发一次世界流 ──
export const WORLD_FLOW_TRIGGER_COUNT = 5;

// ── 阈值 ──
export const API_LOG_MAX = 2000;
export const API_LOG_TRIM = 500;
export const PLAYER_CONV_MEMORY_MAX = 20;
export const SINGLE_GIVE_MAX = 50;
export const SINGLE_TRADE_MAX = 50;
export const PLAYER_LOG_MAX = 100;

// ── 通用 ID 生成 ──
export function genId(prefix: string = ''): string {
  return `${prefix}${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

// ── K/P 等级格式化辅助 ──
export function formatKLevel(level: number, names: string[]): string {
  return names[level] ?? `K${level}`;
}

export function formatPLevel(level: number, names: string[]): string {
  return names[level] ?? `P${level}`;
}

// ── 地点名称解析辅助 ──
export function getLocName(
  locationId: string,
  locations: { location_id: string; name: string }[],
): string {
  return locations.find(l => l.location_id === locationId)?.name || locationId;
}

// ── 季节索引 ──
const SEASON_ORDER = ['春', '夏', '秋', '冬'] as const;
export function seasonIndex(season: string): number {
  return SEASON_ORDER.indexOf(season as typeof SEASON_ORDER[number]);
}

export function sortByGameTime(
  a: { year: number; season: string; day: number },
  b: { year: number; season: string; day: number },
): number {
  const ka = a.year * 10000 + (seasonIndex(a.season) + 1) * 100 + a.day;
  const kb = b.year * 10000 + (seasonIndex(b.season) + 1) * 100 + b.day;
  return ka - kb;
}
