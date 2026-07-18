// 引擎层 —— AI 变更应用器
// 接收 AI 生成的 WorldChangeSet，验证后安全地应用到数据库
// 所有变更都有范围限制和白名单校验，防止 AI 乱写
//
// 资源池集成：
//   resource_changes 中角色获得资源 → 从池扣；角色失去 → 上交池子
//   item_transfers 中 NPC 库存不足时，差额从池子补足

import type { WorldChangeSet, GameTime, WorldCardConfig } from './types';
import { loadCharacter, loadAllCharacters, saveCharacter, saveLocation, loadLocation, loadFaction } from './db';
import { addResource, setRelation, moveEntity, setAgentState } from './crud';
import { deductFromPool, depositToPool } from './pool';

export async function applyWorldChanges(
  changeSet: WorldChangeSet,
  time: GameTime,
  config: WorldCardConfig,
): Promise<string[]> {
  const logs: string[] = [];
  const allChars = await loadAllCharacters();
  const validCharIds = new Set(allChars.map(c => c.character_id));
  const validLocIds = new Set(config.locations.map(l => l.location_id));
  const validResIds = new Set(config.resource_types.map(r => r.resource_type_id));

  // ── 1. 资源变化 ──
  for (const [targetId, resMap] of Object.entries(changeSet.resource_changes)) {
    // 判断目标是角色还是地点
    const isLocation = validLocIds.has(targetId) && !validCharIds.has(targetId);
    const isValid = validCharIds.has(targetId) || isLocation;
    if (!isValid) {
      logs.push(`[变更·跳过] 未知目标: ${targetId}`);
      continue;
    }

    for (const [resId, delta] of Object.entries(resMap)) {
      if (!validResIds.has(resId)) {
        logs.push(`[变更·跳过] 未知资源: ${resId}`);
        continue;
      }

      // 数量上限保护：防止 AI 幻觉注入异常值，单次变更不超过 100
      const numDelta = Math.round(Number(delta) || 0);
      const cappedDelta = Math.max(-100, Math.min(100, numDelta));
      if (cappedDelta !== delta) {
        logs.push(`[变更·上限] ${resId}: ${delta} → ${cappedDelta}`);
      }
      if (cappedDelta === 0) continue;

      const resName = config.resource_types.find(r => r.resource_type_id === resId)?.name || resId;
      const result = await addResource(targetId, resId, cappedDelta, time, `AI叙事变更`, isLocation);

      if (!result.ok) {
        logs.push(`[变更·失败] ${targetId}: ${resName} ${cappedDelta > 0 ? '+' : ''}${cappedDelta} — ${result.error}`);
      } else {
        // 同步内存：如果是角色，更新其 inventory
        if (!isLocation) {
          const ch = allChars.find(c => c.character_id === targetId);
          if (ch) {
            const existing = ch.inventory.find(r => r.resource_type_id === resId);
            if (existing) {
              existing.quantity += cappedDelta;
              existing.last_updated = time;
              if (existing.quantity <= 0) ch.inventory = ch.inventory.filter(r => r.resource_type_id !== resId);
            } else if (cappedDelta > 0) {
              ch.inventory.push({ resource_type_id: resId, quantity: cappedDelta, last_updated: time, location_id: targetId });
            }
          }
        }

        // 池子同步：获得 → 从池扣；失去 → 上交池子
        if (cappedDelta > 0) {
          await deductFromPool(resId, cappedDelta);
          logs.push(`[变更·资源] ${targetId}: ${resName} +${cappedDelta}`);
        } else if (cappedDelta < 0) {
          await depositToPool(resId, Math.abs(cappedDelta));
          logs.push(`[变更·资源] ${targetId}: ${resName} ${cappedDelta} → 池`);
        }
      }
    }
  }

  // ── 2. 关系变化 ──
  for (const [charAId, rels] of Object.entries(changeSet.relation_changes)) {
    if (!validCharIds.has(charAId)) continue;
    for (const [charBId, delta] of Object.entries(rels)) {
      if (!validCharIds.has(charBId) || charAId === charBId) continue;
      // 值域裁剪：单次好感变化不超过 ±30
      const numDelta = Math.round(Number(delta) || 0);
      const cappedDelta = Math.max(-30, Math.min(30, numDelta));
      if (cappedDelta === 0) continue;

      // setRelation 内部已修改缓存中的对象引用（loadCharacter 返回缓存引用），
      // 因此无需在此再次同步内存，避免双重应用好感度变化
      const result = await setRelation(charAId, charBId, cappedDelta, time, 'AI叙事变更');
      if (result.ok) {
        const charA = allChars.find(c => c.character_id === charAId);
        const charB = allChars.find(c => c.character_id === charBId);
        logs.push(`[变更·关系] ${charA?.name || charAId} ↔ ${charB?.name || charBId}: ${cappedDelta > 0 ? '+' : ''}${cappedDelta}好感`);
      }
    }
  }

  // ── 3. 位置变化 ──
  for (const [charId, newLocId] of Object.entries(changeSet.position_changes)) {
    if (!validCharIds.has(charId)) continue;
    if (!validLocIds.has(newLocId)) {
      logs.push(`[变更·跳过] 未知地点: ${newLocId}`);
      continue;
    }
    const ch = allChars.find(c => c.character_id === charId);
    if (!ch) continue;
    if (ch.position.location_id === newLocId) continue;

    const result = await moveEntity(charId, ch.position.location_id, newLocId, time, 'AI叙事变更');
    if (result.ok) {
      ch.position.previous_location_id = ch.position.location_id;
      ch.position.location_id = newLocId;
      const locName = config.locations.find(l => l.location_id === newLocId)?.name || newLocId;
      logs.push(`[变更·移动] ${ch.name} → ${locName}`);
    }
  }

  // ── 4. HP 变化 ──
  for (const [charId, delta] of Object.entries(changeSet.hp_changes)) {
    if (!validCharIds.has(charId)) continue;
    const ch = allChars.find(c => c.character_id === charId);
    if (!ch) continue;
    // 值域裁剪：单次 HP 变化不超过 ±50
    const numDelta = Math.round(Number(delta) || 0);
    const cappedDelta = Math.max(-50, Math.min(50, numDelta));
    if (cappedDelta === 0) continue;
    ch.stats.hp = Math.max(0, Math.min(ch.stats.max_hp, ch.stats.hp + cappedDelta));
    await saveCharacter(ch); // 持久化 HP 变更
    logs.push(`[变更·HP] ${ch.name}: ${cappedDelta > 0 ? '+' : ''}${cappedDelta} → ${ch.stats.hp}/${ch.stats.max_hp}`);
  }

  // ── 5. 状态变化 ──
  for (const [charId, newState] of Object.entries(changeSet.state_changes)) {
    if (!validCharIds.has(charId)) continue;
    const ch = allChars.find(c => c.character_id === charId);
    if (!ch || ch.is_player) continue;
    if (ch.agent_state === newState) continue;
    await setAgentState(charId, newState as any, 'AI叙事变更', time);
    ch.agent_state = newState as any;
    logs.push(`[变更·状态] ${ch.name}: → ${newState}`);
  }

  // ── 5b. P级变化（修为突破/退步）──
  for (const [charId, delta] of Object.entries(changeSet.p_level_changes)) {
    if (!validCharIds.has(charId)) continue;
    const ch = allChars.find(c => c.character_id === charId);
    if (!ch) continue;
    // 值域裁剪：每次只能 ±1
    const numDelta = Math.round(Number(delta) || 0);
    if (numDelta !== 1 && numDelta !== -1) continue;
    const newP = ch.stats.p_level + numDelta;
    if (newP < 0 || newP > 4) continue; // P0-P4 范围
    const pNames = config.mapping?.p_level_names || ['凡人','练气期','筑基期','金丹期','元婴期'];
    const oldName = pNames[ch.stats.p_level] || '?';
    const newName = pNames[newP] || '?';
    ch.stats.p_level = newP;
    // 突破时增加 max_hp 和战力
    if (numDelta > 0) {
      ch.stats.max_hp += 10;
      ch.stats.hp = ch.stats.max_hp;
      ch.stats.base_combat_power += 5;
    }
    await saveCharacter(ch);
    logs.push(`[变更·修为] ${ch.name}: ${oldName} → ${newName}`);
  }

  // ── 5c. K级变化（身份晋升/降级）──
  for (const [charId, delta] of Object.entries(changeSet.k_level_changes)) {
    if (!validCharIds.has(charId)) continue;
    const ch = allChars.find(c => c.character_id === charId);
    if (!ch) continue;
    // 值域裁剪：每次只能 ±1
    const numDelta = Math.round(Number(delta) || 0);
    if (numDelta !== 1 && numDelta !== -1) continue;
    const newK = ch.identity.k_level + numDelta;
    if (newK < 0 || newK > 6) continue; // K0-K6 范围
    const kNames = config.mapping?.k_level_names || ['杂役','外门弟子','内门弟子','真传弟子','执事','长老','掌门'];
    const oldName = kNames[ch.identity.k_level] || '?';
    const newName = kNames[newK] || '?';
    ch.identity.k_level = newK;
    if (ch.faction_binding) ch.faction_binding.k_level = newK;
    await saveCharacter(ch);
    logs.push(`[变更·身份] ${ch.name}: ${oldName} → ${newName}`);
  }

  // ── 6. 交互记忆：更新 NPC 对玩家的对话记忆 ──
  for (const mem of changeSet.interaction_memories) {
    if (!validCharIds.has(mem.npc_id)) continue;
    const ch = allChars.find(c => c.character_id === mem.npc_id);
    if (!ch || ch.is_player) continue;
    const importance = Math.min(1, Math.max(0, Number(mem.importance) || 0.5));
    if (!ch.player_conversation_memory) ch.player_conversation_memory = [];
    ch.player_conversation_memory.push({
      id: `pcm_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      timestamp: { ...time },
      summary: String(mem.summary).slice(0, 150),
      importance,
    });
    // 限制记忆上限
    if (ch.player_conversation_memory.length > 20) {
      ch.player_conversation_memory = ch.player_conversation_memory.slice(-20);
    }
    await saveCharacter(ch);
    logs.push(`[变更·记忆] ${ch.name}: ${String(mem.summary).slice(0, 30)}`);
  }

  // ── 7. 物品转移 ──
  for (const transfer of changeSet.item_transfers) {
    if (!validCharIds.has(transfer.to)) continue;
    if (!validResIds.has(transfer.resource)) continue;
    const qty = Math.min(50, Math.max(1, Math.round(transfer.quantity)));
    const toCh = allChars.find(c => c.character_id === transfer.to);
    const resName = config.resource_types.find(r => r.resource_type_id === transfer.resource)?.name || transfer.resource;

    // from 端：尝试从来源角色扣除，不足部分从池子补
    let fromDeducted = 0;
    let poolCovered = 0;

    if (transfer.from && validCharIds.has(transfer.from) && transfer.from !== 'POOL_SYSTEM') {
      const fromCh = allChars.find(c => c.character_id === transfer.from);
      if (fromCh) {
        const fromInv = fromCh.inventory.find(r => r.resource_type_id === transfer.resource);
        const available = fromInv?.quantity ?? 0;
        fromDeducted = Math.min(available, qty);

        if (fromDeducted > 0) {
          const fromResult = await addResource(transfer.from, transfer.resource, -fromDeducted, time, 'AI叙事转移');
          if (fromResult.ok && fromInv) {
            fromInv.quantity -= fromDeducted;
            if (fromInv.quantity <= 0) fromCh.inventory = fromCh.inventory.filter(r => r.resource_type_id !== transfer.resource);
          }
        }
      }
    }

    poolCovered = qty - fromDeducted;
    if (poolCovered > 0) {
      await deductFromPool(transfer.resource, poolCovered);
    }

    // to 端：给接收方加资源
    const toResult = await addResource(transfer.to, transfer.resource, qty, time, 'AI叙事转移');
    if (toResult.ok) {
      if (toCh) {
        const existing = toCh.inventory.find(r => r.resource_type_id === transfer.resource);
        if (existing) {
          existing.quantity += qty;
          existing.last_updated = time;
        } else {
          toCh.inventory.push({ resource_type_id: transfer.resource, quantity: qty, last_updated: time, location_id: transfer.to });
        }
      }

      const fromName = transfer.from === 'POOL_SYSTEM' ? '系统' : (allChars.find(c => c.character_id === transfer.from)?.name || transfer.from);
      const poolNote = poolCovered > 0 ? ` [池补${poolCovered}]` : '';
      logs.push(`[变更·转移] ${fromName} → ${toCh?.name || transfer.to}: ${resName}×${qty}${poolNote}`);

      // 自动生成交互记忆，防止后续重复索要
      if (transfer.from && validCharIds.has(transfer.from) && transfer.from !== 'POOL_SYSTEM') {
        const fromCh = allChars.find(c => c.character_id === transfer.from);
        if (fromCh && !fromCh.is_player) {
          if (!fromCh.player_conversation_memory) fromCh.player_conversation_memory = [];
          fromCh.player_conversation_memory.push({
            id: `pcm_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
            timestamp: { ...time },
            summary: `给了${toCh?.name || '玩家'} ${resName}×${qty}`,
            importance: 0.5,
          });
          if (fromCh.player_conversation_memory.length > 20) {
            fromCh.player_conversation_memory = fromCh.player_conversation_memory.slice(-20);
          }
          await saveCharacter(fromCh);
        }
      }
    } else {
      logs.push(`[变更·转移·失败] → ${toCh?.name || transfer.to}: ${resName}×${qty} — ${toResult.error}`);
    }
  }

  return logs;
}
