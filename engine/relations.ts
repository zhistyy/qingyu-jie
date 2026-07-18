// 引擎层 —— 关系/外交系统（纯逻辑，世界观无关）
// 外交编排 AI 已移至 transform/diplomacyAI.ts

import type { CharacterInstance, FactionDef, EventSummary, FactionRelationState, GameTime, WorldCardConfig } from './types';
import { saveCharacter } from './db';
import { formatPLevel } from './config';

export function getRelationState(affinity: number, hatred: number = 0): string {
  if (hatred >= 60) return '仇敌';
  if (affinity <= -50) return '死敌'; if (affinity < 0) return '敌对';
  if (affinity >= 50) return '至交'; if (affinity > 0) return '友好';
  return '中立';
}

export function isEnemy(rel: { affinity: number; hatred?: number } | undefined): boolean {
  if (!rel) return false;
  return (rel.hatred || 0) >= 60 || rel.affinity <= -50;
}

const RELATION_TRANSITIONS: Record<FactionRelationState, FactionRelationState[]> = {
  '隶属': ['同盟','友好','中立'],
  '同盟': ['友好','中立','冷淡'],
  '友好': ['中立','冷淡','敌对'],
  '中立': ['友好','冷淡','敌对'],
  '冷淡': ['中立','敌对','战争'],
  '敌对': ['冷淡','战争'],
  '战争': ['敌对','冷淡','中立'],
};

// ── 势力关系检查 ──
export function checkFactionRelationSwitch(
  factions: FactionDef[], events: EventSummary[]
): { factionAId: string; factionBId: string; oldState: FactionRelationState; newState: FactionRelationState }[] {
  const changes: { factionAId: string; factionBId: string; oldState: FactionRelationState; newState: FactionRelationState }[] = [];
  for (let i = 0; i < factions.length; i++) {
    for (let j = i + 1; j < factions.length; j++) {
      const a = factions[i], b = factions[j];
      const current = a.diplomatic_states[b.faction_id] || '中立';
      const possibleTransitions = RELATION_TRANSITIONS[current] || [];
      if (Math.random() < 0.08 && possibleTransitions.length > 0) {
        const newState = possibleTransitions[Math.floor(Math.random() * possibleTransitions.length)];
        a.diplomatic_states[b.faction_id] = newState;
        b.diplomatic_states[a.faction_id] = newState;
        changes.push({ factionAId: a.faction_id, factionBId: b.faction_id, oldState: current, newState });
      }
    }
  }
  return changes;
}

// ── 信息广播 ──
export function broadcastEvent(
  event: EventSummary, allCharacters: CharacterInstance[]
): { charId: string; event: EventSummary }[] {
  const results: { charId: string; event: EventSummary }[] = [];
  for (const ch of allCharacters) {
    let shouldReceive = false;
    switch (event.visibility) {
      case 'public': shouldReceive = true; break;
      case 'semi_public': shouldReceive = (event.location_id === ch.position.location_id) || (Math.random() < 0.3); break;
      case 'private': shouldReceive = event.involved_characters.includes(ch.character_id); break;
      case 'secret': shouldReceive = event.involved_characters.includes(ch.character_id); break;
      case 'player_only': shouldReceive = ch.is_player; break;
    }
    if (shouldReceive) results.push({ charId: ch.character_id, event });
  }
  return results;
}

// ── 认知同步（Step 6） ──
export async function syncCognition(charactersAtLocation: CharacterInstance[], time: GameTime, config?: WorldCardConfig): Promise<void> {
  for (const a of charactersAtLocation) {
    for (const b of charactersAtLocation) {
      if (a.character_id === b.character_id) continue;

      const existing = a.last_known_positions.find(p => p.character_id === b.character_id);
      const pos = {
        character_id: b.character_id,
        location_id: b.position.location_id,
        timestamp: { ...time },
      };
      if (existing) Object.assign(existing, pos);
      else a.last_known_positions.push(pos);

      const known = a.permanent_memory.knows_others.find(k => k.character_id === b.character_id);
      if (known) {
        const rel = a.relationships.find(r => r.target_id === b.character_id);
        const relDesc = rel ? getRelationState(rel.affinity) : '中立';
        known.description = `${b.identity.title}，${config?.mapping?.p_level_names ? formatPLevel(b.stats.p_level, config.mapping.p_level_names) : 'P'+b.stats.p_level}，${b.permanent_memory.core_identity.slice(0, 12)}。关系：${relDesc}`;
      }
    }
    await saveCharacter(a);
  }
}
