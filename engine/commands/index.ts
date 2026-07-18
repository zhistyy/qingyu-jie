// 指令路由层（极简版）—— 仅保留纯信息查询指令
// 所有变革性操作（移动/修炼/采集/战斗/交易/制造等）已移交 AI 叙事管线
import type { CharacterInstance, WorldState, WorldCardConfig } from '../types';
import { formatKLevel, formatPLevel, getLocName } from '../config';
import { loadAllCharacters, loadCharacter, saveCharacter } from '../db';
import { logPlayerAction } from '../playerLog';

export async function handleCommand(
  rawInput: string, player: CharacterInstance, worldState: WorldState, config: WorldCardConfig,
): Promise<{ response: string; systemLog: string[] }> {
  const cmd = rawInput.slice(1).split(/\s+/)[0];
  const time = worldState.game_time;
  const logs: string[] = [];

  switch (cmd) {
    case '状态': return { response: renderStatus(player, config), systemLog: logs };
    case '背包': return { response: renderInventory(player, config), systemLog: logs };
    case '地图': return { response: renderMap(player, config), systemLog: logs };
    case '存档': {
      logPlayerAction('command', '存档', '保存游戏', '手动存档', time);
      // 存档由 game.js 的 saveGameToSlot 处理，这里只提示
      return { response: '输入 /存档 后请在面板中操作保存。', systemLog: logs };
    }
    default:
      return { response: `未知指令: /${cmd}。可用：/状态 /背包 /地图 /存档`, systemLog: logs };
  }
}

// ── /状态 ──
function renderStatus(player: CharacterInstance, config: WorldCardConfig): string {
  const s = player.stats;
  const kName = formatKLevel(player.identity.k_level, config.mapping.k_level_names);
  const pName = formatPLevel(s.p_level, config.mapping.p_level_names);
  const locName = getLocName(player.position.location_id, config.locations);
  const factionName = config.factions.find(f => f.faction_id === player.identity.faction_id)?.name || '无';
  const drivesText = player.drives.map(d => `「${d.description}」${Math.round(d.progress * 100)}%`).join(' | ') || '无';
  const relCount = player.relationships.length;

  return `╔══════════════════════╗
║  ${player.name}
╚══════════════════════╝
身份：${player.identity.title}（${kName}）
修为：${pName}
HP：${s.hp}/${s.max_hp}  |  战力：${s.base_combat_power}
修炼进度：${s.cultivation_progress}
位置：${locName}
势力：${factionName}（忠诚 ${player.faction_binding?.loyalty ?? 50}）
目的：${drivesText}
关系：${relCount} 个关联角色
记忆：${player.long_term_memory.total_count}/${player.long_term_memory.capacity} 张`;
}

// ── /背包 ──
function renderInventory(player: CharacterInstance, config: WorldCardConfig): string {
  if (player.inventory.length === 0) return '背包空空如也。';
  return player.inventory.map(r => {
    const def = config.resource_types.find(rt => rt.resource_type_id === r.resource_type_id);
    const rareName = config.mapping.rarity_names[def?.rarity || 'r1']?.name || '';
    return `${def?.name || r.resource_type_id}${rareName ? ` [${rareName}]` : ''} ×${r.quantity}`;
  }).join('\n');
}

// ── /地图 ──
async function renderMap(player: CharacterInstance, config: WorldCardConfig): Promise<string> {
  const allChars = await loadAllCharacters();
  const lines: string[] = [];
  for (const loc of config.locations) {
    const chars = allChars.filter(c => !c.is_player && c.position.location_id === loc.location_id);
    const marker = loc.location_id === player.position.location_id ? ' ◀ 你在这里' : '';
    const dangerIcon = loc.danger_level === '高' ? '⚠' : loc.danger_level === '中' ? '△' : '○';
    const charSummary = chars.length > 0 ? ` [${chars.map(c => c.name).join('、')}]` : '';
    lines.push(`${dangerIcon} ${loc.name}${marker}${charSummary}`);
  }
  return lines.join('\n');
}
