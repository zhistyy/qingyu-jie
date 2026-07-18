import type { CharacterInstance, WorldState, WorldCardConfig, GameTime } from './types';
import { RES_SPIRIT_STONE, RES_HERB } from './config';
import { loadCharacter, saveCharacter, loadAllCharacters, saveLocation } from './db';
import { addResource, setRelation } from './crud';

// ── 采集资源 ──
export async function collectResource(
  characterId: string, locationId: string,
  resourceTypeId: string, amount: number,
  time: GameTime, config: WorldCardConfig
): Promise<{ ok: boolean; collected: number; error?: string }> {
  const ch = await loadCharacter(characterId);
  if (!ch) return { ok: false, collected: 0, error: '角色不存在' };

  const loc = config.locations.find(l => l.location_id === locationId);
  if (!loc) return { ok: false, collected: 0, error: '地点不存在' };
  if (ch.position.location_id !== locationId) return { ok: false, collected: 0, error: '你不在该地点' };

  const locRes = loc.resources.find(r => r.resource_type_id === resourceTypeId);
  if (!locRes || locRes.quantity <= 0) return { ok: false, collected: 0, error: '该资源在此地已耗尽' };

  const actualCollected = Math.min(amount, locRes.quantity);
  // 通过 CRUD 扣除地点资源（持久化到 OPFS）
  await addResource(locationId, resourceTypeId, -actualCollected, time, `采集:${characterId}`, true);
  // 同步更新内存 config
  locRes.quantity -= actualCollected;

  await addResource(characterId, resourceTypeId, actualCollected, time, `采集自${locationId}`);

  // 更新地点描述
  if (locRes.quantity <= 0) {
    const suffix = '这里的资源已被采尽。';
    if (!loc.description.includes(suffix)) {
      loc.description += suffix;
    }
  }

  return { ok: true, collected: actualCollected };
}

// ── 招募角色 ──
export async function recruitCharacter(
  recruiterId: string, targetId: string,
  time: GameTime, config: WorldCardConfig
): Promise<{ ok: boolean; narrative: string }> {
  const [recruiter, target] = await Promise.all([loadCharacter(recruiterId), loadCharacter(targetId)]);
  if (!recruiter || !target) return { ok: false, narrative: '角色不存在' };
  if (target.position.location_id !== recruiter.position.location_id) return { ok: false, narrative: '目标不在此地' };
  if (target.identity.k_level > recruiter.identity.k_level) return { ok: false, narrative: '不能招募身份层级高于你的角色' };

  const rel = recruiter.relationships.find(r => r.target_id === targetId);
  const affinity = rel?.affinity ?? 0;
  const powerBonus = (recruiter.stats.p_level - target.stats.p_level) * 0.1;
  const recruitChance = Math.min(0.9, Math.max(0.05, (affinity + 100) / 200 + powerBonus));

  if (Math.random() < recruitChance) {
    target.faction_binding.faction_id = recruiter.faction_binding.faction_id;
    target.drives.push({ type: 'loyalty', description: `效忠于${recruiter.name}`, priority: 0.8, progress: 0 });
    await saveCharacter(target);
    await setRelation(recruiterId, targetId, 15, time, '招募');
    return { ok: true, narrative: `${target.name}同意加入你的队伍！好感度 +15` };
  }

  return { ok: false, narrative: `${target.name}拒绝了你的招募。需要更高的好感度或更强的实力。` };
}

// ── 敌人清除 ──
export async function clearEnemy(
  characterId: string, enemyType: string, locationId: string,
  time: GameTime, config: WorldCardConfig
): Promise<{ ok: boolean; narrative: string; loot?: { resource_type_id: string; quantity: number }[] }> {
  const ch = await loadCharacter(characterId);
  if (!ch) return { ok: false, narrative: '角色不存在' };

  const loc = config.locations.find(l => l.location_id === locationId);
  if (!loc) return { ok: false, narrative: '地点不存在' };

  // 检查当前地点是否有该类型敌人
  if (!loc.present_enemies.some(m => m.includes(enemyType) || enemyType.includes(m))) {
    return { ok: false, narrative: `此地没有"${enemyType}"类型的敌人。` };
  }

  // 创建临时敌人角色用于战斗判定
  const enemyPower = loc.danger_level === '高' ? 40 : loc.danger_level === '中' ? 25 : 10;
  const enemyHp = loc.danger_level === '高' ? 60 : loc.danger_level === '中' ? 40 : 20;

  // 简化战斗判定
  const playerPower = config.combat_config.p_level_base_power[ch.stats.p_level] || 5;
  const powerDiff = playerPower - enemyPower;

  if (powerDiff > 30) {
    // 碾压
    loc.present_enemies = loc.present_enemies.filter(m => !m.includes(enemyType));
    await addResource(characterId, RES_SPIRIT_STONE, 5, time, '敌人掉落');
    return { ok: true, narrative: `你轻松消灭了${enemyType}。获得灵石×5` };
  }

  if (powerDiff < -20) {
    const dmg = Math.ceil(ch.stats.max_hp * 0.4);
    ch.stats.hp = Math.max(0, ch.stats.hp - dmg);
    await saveCharacter(ch);
    return { ok: false, narrative: `${enemyType}太强了！你受了${dmg}点伤害，被迫撤退。` };
  }

  // 势均力敌
  const d20 = Math.floor(Math.random() * 20) + 1;
  if (d20 > 8) {
    loc.present_enemies = loc.present_enemies.filter(m => !m.includes(enemyType));
    const loot = d20 > 15 ? 10 : 5;
    await addResource(characterId, RES_SPIRIT_STONE, loot, time, '敌人掉落');
    if (d20 > 15) await addResource(characterId, RES_HERB, 2, time, '敌人掉落');
    return { ok: true, narrative: `经过一番苦战，你击败了${enemyType}！获得灵石×${loot}${d20 > 15 ? '、灵草×2' : ''}` };
  }

  const dmg = Math.ceil(ch.stats.max_hp * 0.25);
  ch.stats.hp = Math.max(0, ch.stats.hp - dmg);
  await saveCharacter(ch);
  return { ok: false, narrative: `战斗不利，你受到${dmg}点伤害。${enemyType}仍然盘踞在此。` };
}

// ── 世界线更正：实际执行补充操作 ──
export async function worldLineCorrection(
  worldState: WorldState, config: WorldCardConfig, time: GameTime
): Promise<string[]> {
  try {
    const corrections: string[] = [];
    const chars = await loadAllCharacters();
    const aliveChars = chars.filter(c => c.stats.hp > 0);
    const aliveCount = aliveChars.length;

    // ── 1. 角色数量基线 ──
    const minAlive = worldState.baseline.min_alive_characters;
    if (aliveCount < minAlive) {
      corrections.push(`[基线] 活角色数 ${aliveCount} 低于基线 ${minAlive}`);

      // 从 config.characters 中找未被激活的 dormant 角色尝试激活
      const dormantCandidates = config.characters.filter(c =>
        !c.is_player &&
        c.agent_state === 'dormant' &&
        c.stats.hp <= 0
      );

      const needCount = minAlive - aliveCount;
      const toActivate = dormantCandidates.slice(0, needCount);

      for (const candidate of toActivate) {
        // 复活并移动到随机地点
        candidate.stats.hp = candidate.stats.max_hp;
        candidate.agent_state = 'active';
        candidate.agent_alert_reason = undefined;

        // 放置到有闲置空间的非空地点
        const safeLoc = config.locations.find(l =>
          l.danger_level === '低' &&
          l.present_characters.filter(cid => {
            const ch = config.characters.find(c => c.character_id === cid);
            return ch && ch.stats.hp > 0;
          }).length < 5
        ) || config.locations[0];

        if (safeLoc) {
          candidate.position.location_id = safeLoc.location_id;
          safeLoc.present_characters.push(candidate.character_id);
        }

        await saveCharacter(candidate);
        corrections.push(`[基线·激活] ${candidate.name} 被世界意志唤醒，出现在 ${safeLoc?.name || '未知地点'}`);
      }

      if (toActivate.length === 0) {
        corrections.push(`[基线] 无可用 dormant 角色，需要外部添加新角色（当前仅记录日志）`);
      }
    }

    // ── 2. 资源基线 ──
    for (const [resType, minAmount] of Object.entries(worldState.baseline.min_resource_amounts)) {
      // 统计所有角色身上 + 所有地点资源的总量
      let totalInChars = 0;
      for (const ch of aliveChars) {
        const r = ch.inventory.find(i => i.resource_type_id === resType);
        totalInChars += r?.quantity ?? 0;
      }

      let totalInLocs = 0;
      for (const loc of config.locations) {
        const r = loc.resources.find(r => r.resource_type_id === resType);
        totalInLocs += r?.quantity ?? 0;
      }

      const total = totalInChars + totalInLocs;
      if (total < minAmount) {
        const deficit = minAmount - total;
        corrections.push(`[基线] ${resType} 总量 ${total} 低于基线 ${minAmount}，缺口 ${deficit}`);

        // 在各地点补充资源
        const safeLocs = config.locations.filter(l => l.danger_level === '低' || l.danger_level === '中');
        if (safeLocs.length > 0) {
          const perLoc = Math.ceil(deficit / safeLocs.length);
          for (const loc of safeLocs) {
            const existing = loc.resources.find(r => r.resource_type_id === resType);
            if (existing) {
              existing.quantity += perLoc;
              existing.last_updated = time;
            } else {
              loc.resources.push({
                resource_type_id: resType,
                quantity: perLoc,
                last_updated: time,
                location_id: loc.location_id,
              });
            }
            await saveLocation(loc);  // 持久化位置资源变更
          }
          corrections.push(`[基线·补充] ${resType} ×${deficit} 已分配到 ${safeLocs.length} 个安全/中等危险地点`);
        }
      }
    }

    // ── 3. 敌人密度基线 ──
    for (const [locId, minEnemies] of Object.entries(worldState.baseline.min_enemy_density)) {
      const loc = config.locations.find(l => l.location_id === locId);
      if (!loc) continue;

      const currentCount = loc.present_enemies.length;
      if (currentCount < minEnemies) {
        const deficit = minEnemies - currentCount;
        corrections.push(`[基线] ${loc.name} 敌人密度 ${currentCount} 低于基线 ${minEnemies}，缺口 ${deficit}`);

        // 使用地点已有的敌人类型进行补充，没有就用第一只
        const defaultEnemy = loc.present_enemies.length > 0
          ? loc.present_enemies[0]
          : (loc.danger_level === '高' ? 'ENM_妖兽' : loc.danger_level === '中' ? 'ENM_妖兽' : 'ENM_灵兔');

        for (let i = 0; i < deficit; i++) {
          loc.present_enemies.push(defaultEnemy);
        }

        corrections.push(`[基线·刷新] ${loc.name} 新增 ${deficit} 只${defaultEnemy}`);
      }
    }

    return corrections;
  } catch (e: any) {
    console.error('[世界线更正] 失败:', e);
    return [`[世界线更正] 异常：${e.message}`];
  }
}
