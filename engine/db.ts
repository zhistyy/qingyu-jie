import type { CharacterInstance, WorldState, MemoryCard, CrudLogEntry, WorldFlowRecord, EventSummary, ConversationTurn, APILogEntry, PathwayCache, LocationDef, FactionDef, SaveSlotMeta, SaveSnapshot } from './types';
import { OPFS_ROOT, SAVES_DIR, TOTAL_SAVE_SLOTS, API_LOG_MAX, API_LOG_TRIM } from './config';

// ═══════════════════════════════════════════════════════════
//  OPFS JSON 文件存储 —— 替代 IndexedDB
//  数据存于浏览器 Origin Private File System 中
//  目录结构: to-rpg/
//    worldState.json   characters.json   memoryCards.json
//    journals.json     worldstream.json   locations.json
//    events.json       apiLogs.json       pathwayCache.json
//    factions.json
// ═══════════════════════════════════════════════════════════

const STORES = ['worldState','characters','memoryCards','journals','worldstream','apiLogs','pathwayCache','locations','factions'] as const;

type StoreName = typeof STORES[number];

// ── 批量写入模式：开启后 save 系列函数仅更新内存缓存，不触发 OPFS 刷写 ──
let _batchMode = false;
export function beginBatch(): void { _batchMode = true; }
export async function endBatch(): Promise<void> {
  _batchMode = false;
  const dirty = _dirtyStores;
  _dirtyStores = new Set();
  for (const store of dirty) {
      try { await flushStore(store); } catch (e) { console.error(`[OPFS] endBatch flushStore ${store} 失败:`, e); }
    }
}
let _dirtyStores = new Set<StoreName>();

function markDirty(store: StoreName): void {
  if (_batchMode) { _dirtyStores.add(store); return; }
}

// 文件键名映射：store → idField
const KEY_FIELD: Record<StoreName, string> = {
  worldState: 'id',
  characters: 'character_id',
  memoryCards: 'id',
  journals: 'log_id',
  worldstream: 'flow_id',
  apiLogs: 'id',
  pathwayCache: 'id',
  locations: 'location_id',
  factions: 'faction_id',
};

// ── OPFS 写入队列（防止多页面并发写入导致 NotReadableError） ──
//  确保同一时刻只有一个 flushStore 在执行，其余调用排队等待
let _writeQueue: Promise<void> = Promise.resolve();

function enqueueWrite(fn: () => Promise<void>): Promise<void> {
  const task = _writeQueue.then(fn, fn); // fn 作为 fulfilled 和 rejected handler，确保失败也不阻断队列
  _writeQueue = task.catch(() => {});     // 吞掉错误，防止队列永久卡死
  return task;
}

// ── OPFS 文件操作工具 ──

let rootDir: FileSystemDirectoryHandle | null = null;

async function getRoot(): Promise<FileSystemDirectoryHandle> {
  if (rootDir) return rootDir;
  const opfsRoot = await navigator.storage.getDirectory();
  rootDir = await opfsRoot.getDirectoryHandle(OPFS_ROOT, { create: true });
  return rootDir;
}

export { getRoot };

type TableCache<T> = {
  loaded: boolean;
  /** 对于 journals（日志表），使用数组存储；其他表用 Map */
  data: Map<string, T> | T[];
};

const cache: Record<StoreName, TableCache<any>> = {
  worldState:   { loaded: false, data: new Map() },
  characters:   { loaded: false, data: new Map() },
  memoryCards:  { loaded: false, data: new Map() },
  journals:     { loaded: false, data: [] },
  worldstream:  { loaded: false, data: new Map() },
  apiLogs:      { loaded: false, data: new Map() },
  pathwayCache: { loaded: false, data: new Map() },
  locations:    { loaded: false, data: new Map() },
  factions:     { loaded: false, data: new Map() },
};

function fileName(store: StoreName): string {
  return `${store}.json`;
}

async function loadStore(store: StoreName): Promise<void> {
  const c = cache[store];
  if (c.loaded) return;

  try {
    const root = await getRoot();
    const fh = await root.getFileHandle(fileName(store), { create: true });
    const file = await fh.getFile();
    const text = await file.text();
    if (!text.trim()) {
      c.loaded = true;
      return;
    }
    const parsed = JSON.parse(text);

    if (store === 'journals') {
      // journals 是数组
      c.data = Array.isArray(parsed) ? parsed : [];
    } else {
      // 其他表是 key-value 对象
      const map = new Map<string, any>();
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        for (const [k, v] of Object.entries(parsed)) {
          map.set(k, v);
        }
      }
      c.data = map;
    }
  } catch (e) {
    console.error(`[OPFS] loadStore ${store} 失败:`, e);
  }
  c.loaded = true;
}

async function flushStore(store: StoreName): Promise<void> {
  return enqueueWrite(async () => {
    const c = cache[store];

    let json: string;
    if (store === 'journals') {
      json = JSON.stringify(c.data as any[]);
    } else {
      const obj: Record<string, any> = {};
      for (const [k, v] of (c.data as Map<string, any>)) {
        obj[k] = v;
      }
      json = JSON.stringify(obj);
    }

    const tmpName = fileName(store) + '.tmp';
    const maxRetries = 3;
    let lastError: any;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const root = await getRoot();
        const fh = await root.getFileHandle(fileName(store), { create: true });

        // 写入临时文件 → 校验通过后替换
        const tmpFh = await root.getFileHandle(tmpName, { create: true });
        const writable = await tmpFh.createWritable();
        await writable.write(json);
        await writable.close();

        // 校验临时 JSON 可解析
        const verifyFh = await root.getFileHandle(tmpName);
        const vfile = await verifyFh.getFile();
        const vtext = await vfile.text();
        JSON.parse(vtext);

        // 原子替换
        const mainWritable = await fh.createWritable();
        await mainWritable.write(json);
        await mainWritable.close();

        // 删除临时文件
        try { await root.removeEntry(tmpName); } catch { /* 不致命 */ }
        return; // 成功，退出
      } catch (e) {
        lastError = e;
        if (attempt < maxRetries - 1) {
          // 指数退避：100ms, 200ms, 400ms
          await new Promise(r => setTimeout(r, 100 * Math.pow(2, attempt)));
          // 重试前重置 root 句柄，确保下次获取新的
          rootDir = null;
        }
      }
    }

    console.error(`[OPFS] flushStore ${store} 失败（重试${maxRetries}次）:`, lastError);
    try {
      const root = await getRoot();
      await root.removeEntry(tmpName);
    } catch { /* 不致命 */ }
    throw lastError;
  });
}

// 重置缓存（测试/重置用）
function resetCache(): void {
  for (const store of STORES) {
    if (store === 'journals') {
      cache[store] = { loaded: false, data: [] };
    } else {
      cache[store] = { loaded: false, data: new Map() };
    }
  }
}

// ── 世界状态 ──

export async function loadWorldState(): Promise<WorldState | null> {
  await loadStore('worldState');
  const map = cache.worldState.data as Map<string, WorldState>;
  return map.get('current') || null;
}

export async function saveWorldState(state: WorldState): Promise<void> {
  await loadStore('worldState');
  const map = cache.worldState.data as Map<string, WorldState>;
  map.set('current', state);
  _batchMode ? markDirty('worldState') : await flushStore('worldState');
}

// ── 角色 ──

export async function loadAllCharacters(): Promise<CharacterInstance[]> {
  await loadStore('characters');
  const map = cache.characters.data as Map<string, CharacterInstance>;
  return Array.from(map.values());
}

export async function loadCharacter(id: string): Promise<CharacterInstance | undefined> {
  await loadStore('characters');
  const map = cache.characters.data as Map<string, CharacterInstance>;
  return map.get(id);
}

export async function saveCharacter(ch: CharacterInstance): Promise<void> {
  await loadStore('characters');
  const map = cache.characters.data as Map<string, CharacterInstance>;
  map.set(ch.character_id, ch);
  _batchMode ? markDirty('characters') : await flushStore('characters');
}

export async function saveAllCharacters(chars: CharacterInstance[]): Promise<void> {
  await loadStore('characters');
  const map = cache.characters.data as Map<string, CharacterInstance>;
  for (const ch of chars) {
    map.set(ch.character_id, ch);
  }
  _batchMode ? markDirty('characters') : await flushStore('characters');
}

// ── 记忆卡片 ──

export async function loadMemoryCards(characterId: string): Promise<MemoryCard[]> {
  await loadStore('memoryCards');
  const map = cache.memoryCards.data as Map<string, MemoryCard>;
  const all = Array.from(map.values());
  return all.filter(c => c.linked_characters?.includes(characterId));
}

export async function saveMemoryCard(card: MemoryCard): Promise<void> {
  await loadStore('memoryCards');
  const map = cache.memoryCards.data as Map<string, MemoryCard>;
  map.set(card.id, card);
  _batchMode ? markDirty('memoryCards') : await flushStore('memoryCards');
}

// ── 日志（journal 用数组） ──

export async function saveLog(entry: CrudLogEntry): Promise<void> {
  await loadStore('journals');
  const arr = cache.journals.data as CrudLogEntry[];
  // 若调用方未提供 log_id，则基于时间戳 + 序号生成
  if (!entry.log_id) {
    entry.log_id = `log_${Date.now()}_${arr.length}`;
  }
  arr.push(entry);
  _batchMode ? markDirty('journals') : await flushStore('journals');
}

export async function getAllLogs(): Promise<CrudLogEntry[]> {
  await loadStore('journals');
  return cache.journals.data as CrudLogEntry[];
}

// ── 世界流记录 ──

export async function saveWorldFlowRecord(record: WorldFlowRecord): Promise<void> {
  await loadStore('worldstream');
  const map = cache.worldstream.data as Map<string, WorldFlowRecord>;
  map.set(record.flow_id, record);
  _batchMode ? markDirty('worldstream') : await flushStore('worldstream');
}

export async function getAllWorldFlowRecords(): Promise<WorldFlowRecord[]> {
  await loadStore('worldstream');
  const map = cache.worldstream.data as Map<string, WorldFlowRecord>;
  return Array.from(map.values());
}

// ── API 日志 ──

export async function loadPathwayCache(id: string): Promise<PathwayCache | undefined> {
  await loadStore('pathwayCache');
  const map = cache.pathwayCache.data as Map<string, PathwayCache>;
  return map.get(id);
}

export async function savePathwayCache(entry: PathwayCache): Promise<void> {
  await loadStore('pathwayCache');
  const map = cache.pathwayCache.data as Map<string, PathwayCache>;
  map.set(entry.id, entry);
  _batchMode ? markDirty('pathwayCache') : await flushStore('pathwayCache');
}

export async function loadAllPathwayCaches(): Promise<PathwayCache[]> {
  await loadStore('pathwayCache');
  const map = cache.pathwayCache.data as Map<string, PathwayCache>;
  return Array.from(map.values());
}

// ── 地点 ──

export async function loadLocation(id: string): Promise<LocationDef | undefined> {
  await loadStore('locations');
  const map = cache.locations.data as Map<string, LocationDef>;
  return map.get(id);
}

export async function saveLocation(loc: LocationDef): Promise<void> {
  await loadStore('locations');
  const map = cache.locations.data as Map<string, LocationDef>;
  map.set(loc.location_id, loc);
  _batchMode ? markDirty('locations') : await flushStore('locations');
}

export async function loadAllLocations(): Promise<LocationDef[]> {
  await loadStore('locations');
  return Array.from((cache.locations.data as Map<string, LocationDef>).values());
}

// ── 势力 ──

export async function loadFaction(id: string): Promise<FactionDef | undefined> {
  await loadStore('factions');
  const map = cache.factions.data as Map<string, FactionDef>;
  return map.get(id);
}

export async function saveFaction(fac: FactionDef): Promise<void> {
  await loadStore('factions');
  const map = cache.factions.data as Map<string, FactionDef>;
  map.set(fac.faction_id, fac);
  _batchMode ? markDirty('factions') : await flushStore('factions');
}

export async function loadAllFactions(): Promise<FactionDef[]> {
  await loadStore('factions');
  return Array.from((cache.factions.data as Map<string, FactionDef>).values());
}

// ── 重置数据库 ──

export async function resetDB(): Promise<void> {
  const root = await getRoot();
  // 删除所有 store 文件
  for (const store of STORES) {
    try {
      await root.removeEntry(fileName(store));
    } catch {
      // 文件不存在，忽略
    }
  }
  // 删除资源池文件
  try {
    await root.removeEntry('pool.json');
  } catch { /* 文件不存在，忽略 */ }
  // 删除应用状态文件
  try {
    await root.removeEntry('app_state.json');
  } catch { /* 文件不存在，忽略 */ }
  // 删除存档目录（递归删除所有存档槽位）
  try {
    await root.removeEntry(SAVES_DIR, { recursive: true });
  } catch { /* 目录不存在，忽略 */ }
  resetCache();
}

// ── API 日志 ──

export async function saveAPILog(entry: APILogEntry): Promise<void> {
  await loadStore('apiLogs');
  const map = cache.apiLogs.data as Map<string, APILogEntry>;
  map.set(entry.id, entry);
  // 上限保护：超过上限时删除最旧的条目
  if (map.size > API_LOG_MAX) {
    const sorted = Array.from(map.entries()).sort((a, b) => a[1].timestamp - b[1].timestamp);
    for (const [id] of sorted.slice(0, API_LOG_TRIM)) map.delete(id);
  }
  _batchMode ? markDirty('apiLogs') : await flushStore('apiLogs');
}

export async function getAllAPILogs(): Promise<APILogEntry[]> {
  await loadStore('apiLogs');
  const map = cache.apiLogs.data as Map<string, APILogEntry>;
  const all = Array.from(map.values());
  return all.sort((a, b) => b.timestamp - a.timestamp);
}

export async function deleteAPILogs(ids: string[]): Promise<void> {
  await loadStore('apiLogs');
  const map = cache.apiLogs.data as Map<string, APILogEntry>;
  for (const id of ids) {
    map.delete(id);
  }
  await flushStore('apiLogs');
}

export async function deleteAllAPILogs(): Promise<void> {
  await loadStore('apiLogs');
  const map = cache.apiLogs.data as Map<string, APILogEntry>;
  map.clear();
  await flushStore('apiLogs');
}

// ── 删除保护 ──

export async function canDeleteCharacter(characterId: string): Promise<boolean> {
  const ch = await loadCharacter(characterId);
  if (!ch) return true;
  if (ch.is_player) return false;
  const all = await loadAllCharacters();
  const otherNpcs = all.filter(c => !c.is_player && c.character_id !== characterId);
  if (otherNpcs.length === 0) return false;
  if (ch.identity.character_type === '修行者') return false;
  return true;
}

export function canDeleteLocation(locationId: string, allLocations: { location_id: string }[]): boolean {
  if (allLocations.length <= 1) return false;
  return true;
}

// ── 初始化世界卡数据 ──

export async function initFromWorldCard(config: {
  worldState: WorldState;
  characters: CharacterInstance[];
  locations: LocationDef[];
  factions: FactionDef[];
}): Promise<void> {
  await resetDB();
  await saveWorldState(config.worldState);
  for (const ch of config.characters) await saveCharacter(ch);
  for (const loc of config.locations) await saveLocation(loc);
  for (const fac of config.factions) await saveFaction(fac);
}

// ═══════════════════════════════════════════════════════════
//  存档系统 —— 20 个槽位，OPFS 文件存储
//  文件: saves/meta.json  +  saves/slot_N.json
// ═══════════════════════════════════════════════════════════

async function getSavesDir(): Promise<FileSystemDirectoryHandle> {
  const root = await getRoot();
  return root.getDirectoryHandle(SAVES_DIR, { create: true });
}

/** 读取所有槽位的元信息 */
export async function listSaveSlots(): Promise<(SaveSlotMeta | null)[]> {
  const results: (SaveSlotMeta | null)[] = [];
  try {
    const dir = await getSavesDir();
    const fh = await dir.getFileHandle('meta.json', { create: true });
    const file = await fh.getFile();
    const text = await file.text();
    if (text.trim()) {
      const map: Record<number, SaveSlotMeta> = JSON.parse(text);
      for (let i = 1; i <= TOTAL_SAVE_SLOTS; i++) {
        results.push(map[i] || null);
      }
      return results;
    }
  } catch { /* fall through */ }
  for (let i = 1; i <= TOTAL_SAVE_SLOTS; i++) results.push(null);
  return results;
}

async function flushMeta(meta: Record<number, SaveSlotMeta | null>): Promise<void> {
  const dir = await getSavesDir();
  const fh = await dir.getFileHandle('meta.json', { create: true });
  const writable = await fh.createWritable();
  await writable.write(JSON.stringify(meta));
  await writable.close();
}

/** 保存到指定槽位（覆写），自动从各表快照数据 */
export async function saveGameToSlot(slotId: number, name: string): Promise<void> {
  if (slotId < 1 || slotId > TOTAL_SAVE_SLOTS) throw new Error('槽位编号 1-20');

  // 加载所有表数据做快照
  await loadStore('worldState');
  await loadStore('characters');
  await loadStore('locations');
  await loadStore('factions');
  await loadStore('memoryCards');
  await loadStore('worldstream');
  await loadStore('apiLogs');
  await loadStore('pathwayCache');
  await loadStore('journals');

  const worldState = cache.worldState.data as Map<string, any>;

  const snapshot: SaveSnapshot = {
    worldState: worldState.get('current') || {},
    characters: Array.from((cache.characters.data as Map<string, any>).values()),
    locations: Array.from((cache.locations.data as Map<string, any>).values()),
    factions: Array.from((cache.factions.data as Map<string, any>).values()),
    memoryCards: Array.from((cache.memoryCards.data as Map<string, any>).values()),
    worldstream: Array.from((cache.worldstream.data as Map<string, any>).values()),
    apiLogs: Array.from((cache.apiLogs.data as Map<string, any>).values()),
    pathwayCaches: Array.from((cache.pathwayCache.data as Map<string, any>).values()),
    journals: cache.journals.data as any[],
  };

  const ws = snapshot.worldState;
  const meta: SaveSlotMeta = {
    slot_id: slotId,
    name: name || `存档 ${slotId}`,
    saved_at: Date.now(),
    game_time: ws?.game_time ? `${ws.game_time.year}年 ${ws.game_time.season} ${ws.game_time.day}日 ${ws.game_time.timeOfDay}` : '未开始',
    flow_count: ws?.flow_count || 0,
  };

  // 写 meta
  const dir = await getSavesDir();
  let metaObj: Record<number, SaveSlotMeta | null> = {};
  try {
    const mfh = await dir.getFileHandle('meta.json', { create: true });
    const mfile = await mfh.getFile();
    const mtext = await mfile.text();
    if (mtext.trim()) metaObj = JSON.parse(mtext);
  } catch { /* use empty */ }
  metaObj[slotId] = meta;
  await flushMeta(metaObj);

  // 写快照
  const sfh = await dir.getFileHandle(`slot_${slotId}.json`, { create: true });
  const writable = await sfh.createWritable();
  await writable.write(JSON.stringify(snapshot));
  await writable.close();
}

/** 从指定槽位加载存档，恢复所有表数据 */
export async function loadGameFromSlot(slotId: number): Promise<SaveSlotMeta | null> {
  if (slotId < 1 || slotId > TOTAL_SAVE_SLOTS) return null;
  try {
    const dir = await getSavesDir();

    // 读 meta
    const mfh = await dir.getFileHandle('meta.json', { create: true });
    const mfile = await mfh.getFile();
    const mtext = await mfile.text();
    const metaObj: Record<number, SaveSlotMeta> = mtext.trim() ? JSON.parse(mtext) : {};
    const meta = metaObj[slotId];
    if (!meta) return null;

    // 读快照
    const sfh = await dir.getFileHandle(`slot_${slotId}.json`, { create: true });
    const sfile = await sfh.getFile();
    const stext = await sfile.text();
    if (!stext.trim()) return null;
    const snap: SaveSnapshot = JSON.parse(stext);

    // 校验快照数据完整性
    if (!snap.worldState || !Array.isArray(snap.characters)) {
      console.error('[OPFS] 存档快照数据不完整，拒绝加载');
      return null;
    }

    // 一次性构建新缓存（不直接修改旧缓存，防止 flush 失败时半污染）
    const newMaps = {
      worldState: new Map<string, any>([['current', snap.worldState]]),
      characters: new Map<string, any>(snap.characters.map((ch: any) => [ch.character_id, ch])),
      memoryCards: new Map<string, any>(snap.memoryCards.map((mc: any) => [mc.id, mc])),
      worldstream: new Map<string, any>(snap.worldstream.map((w: any) => [w.flow_id, w])),
      apiLogs: new Map<string, any>(snap.apiLogs.map((a: any) => [a.id, a])),
      pathwayCache: new Map<string, any>(snap.pathwayCaches.map((p: any) => [p.id, p])),
      locations: new Map<string, any>(snap.locations.map((l: any) => [l.location_id, l])),
      factions: new Map<string, any>(snap.factions.map((f: any) => [f.faction_id, f])),
      journals: snap.journals || [],
    };

    // 原子上传：先写正式文件（flushStore 内部有校验机制），再更新缓存
    // 如果 flushStore 失败，缓存不会被污染
    const storesToRestore: { store: StoreName; data: any }[] = [
      { store: 'worldState', data: newMaps.worldState },
      { store: 'characters', data: newMaps.characters },
      { store: 'memoryCards', data: newMaps.memoryCards },
      { store: 'worldstream', data: newMaps.worldstream },
      { store: 'apiLogs', data: newMaps.apiLogs },
      { store: 'pathwayCache', data: newMaps.pathwayCache },
      { store: 'locations', data: newMaps.locations },
      { store: 'factions', data: newMaps.factions },
    ];

    for (const { store, data } of storesToRestore) {
      (cache[store].data as any) = data;
      cache[store].loaded = true;
      await flushStore(store);
    }
    // journals 特殊处理（独立于九大 store 的数组格式）
    cache.journals.data = newMaps.journals;
    cache.journals.loaded = true;
    await flushStore('journals');

    return meta;
  } catch {
    return null;
  }
}

/** 删除指定槽位 */
export async function deleteSaveSlot(slotId: number): Promise<void> {
  try {
    const dir = await getSavesDir();
    try { await dir.removeEntry(`slot_${slotId}.json`); } catch { /* not exist */ }
    // 更新 meta
    const mfh = await dir.getFileHandle('meta.json', { create: true });
    const mfile = await mfh.getFile();
    const mtext = await mfile.text();
    const metaObj: Record<number, SaveSlotMeta | null> = mtext.trim() ? JSON.parse(mtext) : {};
    metaObj[slotId] = null;
    await flushMeta(metaObj);
  } catch { /* ignore */ }
}
