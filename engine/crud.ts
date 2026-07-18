import { loadCharacter, saveCharacter, loadAllCharacters, saveLog, loadLocation, saveLocation, loadFaction, saveFaction, beginBatch, endBatch } from './db';
import type { CharacterInstance, ResourceInstance, GameTime, CrudLogEntry, WorldState } from './types';
import { loadWorldState, saveWorldState } from './db';

let _logId = 0;
function logId() { return `log_${Date.now()}_${++_logId}`; }

// ── 操作1：资源增减（角色/地点/势力） ──
export async function addResource(
  targetId: string, resourceTypeId: string, amount: number,
  timestamp: GameTime, context: string,
  isLocation: boolean = false, isFaction: boolean = false
): Promise<{ ok: boolean; newQuantity?: number; error?: string }> {
  try {
    if (isLocation) {
      const loc = await loadLocation(targetId);
      if (!loc) return { ok: false, error: '地点不存在' };
      const existing = loc.resources.find(r => r.resource_type_id === resourceTypeId);
      if (amount < 0) {
        if (!existing || existing.quantity < Math.abs(amount)) {
          return { ok: false, error: `地点资源不足：需要 ${Math.abs(amount)}，当前 ${existing?.quantity ?? 0}` };
        }
      }
      if (existing) {
        existing.quantity += amount;
        existing.last_updated = timestamp;
        if (existing.quantity <= 0) loc.resources = loc.resources.filter(r => r.resource_type_id !== resourceTypeId);
      } else if (amount > 0) {
        loc.resources.push({ resource_type_id: resourceTypeId, quantity: amount, last_updated: timestamp, location_id: targetId });
      } else {
        return { ok: false, error: '不能减少不存在的地点资源' };
      }
      await saveLocation(loc);
      await saveLog({ log_id: logId(), timestamp, operation: 'addResource_loc', target_id: targetId, before: null, after: { resourceTypeId, amount }, context });
      return { ok: true, newQuantity: existing?.quantity ?? amount };
    }

    if (isFaction) {
      const fac = await loadFaction(targetId);
      if (!fac) return { ok: false, error: '势力不存在' };
      const existing = fac.treasury.find(r => r.resource_type_id === resourceTypeId);
      if (amount < 0) {
        if (!existing || existing.quantity < Math.abs(amount)) {
          return { ok: false, error: `势力金库资源不足：需要 ${Math.abs(amount)}，当前 ${existing?.quantity ?? 0}` };
        }
      }
      if (existing) {
        existing.quantity += amount;
        existing.last_updated = timestamp;
        if (existing.quantity <= 0) fac.treasury = fac.treasury.filter(r => r.resource_type_id !== resourceTypeId);
      } else if (amount > 0) {
        fac.treasury.push({ resource_type_id: resourceTypeId, quantity: amount, last_updated: timestamp, location_id: targetId });
      } else {
        return { ok: false, error: '不能减少不存在的势力资源' };
      }
      await saveFaction(fac);
      await saveLog({ log_id: logId(), timestamp, operation: 'addResource_fac', target_id: targetId, before: null, after: { resourceTypeId, amount }, context });
      return { ok: true, newQuantity: existing?.quantity ?? amount };
    }

    const ch = await loadCharacter(targetId);
    if (!ch) return { ok: false, error: '目标不存在' };

    const existing = ch.inventory.find(r => r.resource_type_id === resourceTypeId);
    if (amount < 0) {
      const current = existing?.quantity ?? 0;
      if (current < Math.abs(amount)) return { ok: false, error: `资源不足：需要 ${Math.abs(amount)}，当前 ${current}` };
    }

    let newQty: number;
    if (existing) {
      existing.quantity += amount;
      existing.last_updated = timestamp;
      newQty = existing.quantity;
      if (existing.quantity <= 0) ch.inventory = ch.inventory.filter(r => r.resource_type_id !== resourceTypeId);
    } else if (amount > 0) {
      ch.inventory.push({ resource_type_id: resourceTypeId, quantity: amount, last_updated: timestamp, location_id: targetId });
      newQty = amount;
    } else {
      return { ok: false, error: '不能减少不存在的资源' };
    }

    await saveCharacter(ch);
    await saveLog({ log_id: logId(), timestamp, operation: 'addResource', target_id: targetId, before: null, after: { resourceTypeId, newQty }, context });
    return { ok: true, newQuantity: newQty };
  } catch (e) {
    console.error('[crud] addResource 失败:', e);
    return { ok: false, error: String(e) };
  }
}

// ── 操作2：关系变更 ──
export async function setRelation(
  charAId: string, charBId: string, delta: number,
  timestamp: GameTime, context: string
): Promise<{ ok: boolean; newAffinity?: number; error?: string }> {
  if (charAId === charBId) return { ok: false, error: '不允许自引用' };
  try {
    const [a, b] = await Promise.all([loadCharacter(charAId), loadCharacter(charBId)]);
    if (!a || !b) return { ok: false, error: '角色不存在' };

    let rel = a.relationships.find(r => r.target_id === charBId);
    if (!rel) { rel = { target_id: charBId, affinity: 0, hatred: 0 }; a.relationships.push(rel); }
    let relB = b.relationships.find(r => r.target_id === charAId);
    if (!relB) { relB = { target_id: charAId, affinity: 0, hatred: 0 }; b.relationships.push(relB); }

    const oldAffinity = rel.affinity;
    rel.affinity = Math.max(-100, Math.min(100, rel.affinity + delta));
    const bDelta = Math.round(delta * 0.7);
    relB.affinity = Math.max(-100, Math.min(100, relB.affinity + bDelta));

    // 仇恨值累积：当好感度降低时，仇恨值增加
    if (delta < 0) {
      const hatredGain = Math.abs(delta);
      rel.hatred = Math.min(100, (rel.hatred || 0) + hatredGain);
      if (rel.hatred >= 60) {
        relB.hatred = Math.min(100, (relB.hatred || 0) + Math.round(hatredGain * 0.5));
      }
    }

    await Promise.all([saveCharacter(a), saveCharacter(b)]);
    await saveLog({ log_id: logId(), timestamp, operation: 'setRelation', target_id: `${charAId}->${charBId}`, before: null, after: { a_affinity: rel.affinity, b_affinity: relB.affinity }, context });
    return { ok: true, newAffinity: rel.affinity };
  } catch (e) {
    console.error('[crud] setRelation 失败:', e);
    return { ok: false, error: String(e) };
  }
}

// ── 操作3：实体移动 ──
export async function moveEntity(
  entityId: string, fromLoc: string, toLoc: string,
  timestamp: GameTime, context: string,
  accessRule?: { min_k_level?: number; min_p_level?: number }
): Promise<{ ok: boolean; error?: string }> {
  try {
    beginBatch(); // 批量模式：确保多次写入原子性
    const ch = await loadCharacter(entityId);
    if (!ch) { await endBatch(); return { ok: false, error: '实体不存在' }; }
    if (ch.position.location_id !== fromLoc) { await endBatch(); return { ok: false, error: '实体不在来源地点' }; }

    if (accessRule) {
      if (accessRule.min_k_level !== undefined && ch.identity.k_level < accessRule.min_k_level) {
        await endBatch();
        return { ok: false, error: `无权进入：需要K${accessRule.min_k_level}，当前K${ch.identity.k_level}` };
      }
      if (accessRule.min_p_level !== undefined && ch.stats.p_level < accessRule.min_p_level) {
        await endBatch();
        return { ok: false, error: `修为不足：需要P${accessRule.min_p_level}，当前P${ch.stats.p_level}` };
      }
    }

    ch.position.previous_location_id = ch.position.location_id;
    ch.position.location_id = toLoc;

    // 同步更新地点 present_characters
    const [fromLocDef, toLocDef] = await Promise.all([
      loadLocation(fromLoc), loadLocation(toLoc)
    ]);
    if (fromLocDef) {
      fromLocDef.present_characters = (fromLocDef.present_characters || []).filter(id => id !== entityId);
      await saveLocation(fromLocDef);
    }
    if (toLocDef) {
      if (!toLocDef.present_characters) toLocDef.present_characters = [];
      if (!toLocDef.present_characters.includes(entityId)) {
        toLocDef.present_characters.push(entityId);
      }
      await saveLocation(toLocDef);
    }

    await saveCharacter(ch);
    await saveLog({ log_id: logId(), timestamp, operation: 'moveEntity', target_id: entityId, before: fromLoc, after: toLoc, context });
    await endBatch(); // 批量写入所有变更
    return { ok: true };
  } catch (e) {
    await endBatch(); // 异常时也确保清理 batch 模式
    console.error('[crud] moveEntity 失败:', e);
    return { ok: false, error: String(e) };
  }
}

// ── 操作4：状态切换 ──
export async function setAgentState(
  charId: string, newState: CharacterInstance['agent_state'], reason: string,
  timestamp: GameTime
): Promise<{ ok: boolean; error?: string }> {
  try {
    const ch = await loadCharacter(charId);
    if (!ch) return { ok: false, error: '角色不存在' };

    const validTransitions: Record<string, string[]> = {
      active: ['pending'],
      pending: ['dormant'],
      dormant: ['alert'],
      alert: ['active'],
    };

    if (!validTransitions[ch.agent_state]?.includes(newState)) {
      return { ok: false, error: `非法状态转换: ${ch.agent_state} -> ${newState}` };
    }

    const oldState = ch.agent_state;
    ch.agent_state = newState;
    if (newState === 'alert') ch.agent_alert_reason = reason;
    else ch.agent_alert_reason = undefined;

    await saveCharacter(ch);
    await saveLog({ log_id: logId(), timestamp, operation: 'setState', target_id: charId, before: oldState, after: newState, context: reason });
    return { ok: true };
  } catch (e) {
    console.error('[crud] setAgentState 失败:', e);
    return { ok: false, error: String(e) };
  }
}
