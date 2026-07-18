import type { CombatContext, CombatResult, CharacterInstance, WorldCardConfig, GameTime, ResourceInstance } from './types';
import { loadCharacter, saveCharacter, loadAllCharacters } from './db';
import { addResource, setRelation, moveEntity } from './crud';

// ── 战力计算 ──
export function calcCombatPower(ch: CharacterInstance, location: { environment_modifier: number } | null, config: WorldCardConfig): number {
  let power = config.combat_config.p_level_base_power[ch.stats.p_level] || 5;
  for (const item of ch.inventory) {
    power += (config.combat_config.equipment_bonuses[item.resource_type_id] || 0);
    power += (config.combat_config.skill_bonuses[item.resource_type_id] || 0);
  }
  if (location) power += location.environment_modifier;
  return power;
}

// ── 段位压制：跨段位时低段位方受到压制 ──
export function getTierAdvantage(attackerPLvl: number, defenderPLvl: number): { atkMultiplier: number; message: string } {
  const gap = attackerPLvl - defenderPLvl;
  if (gap >= 2) return { atkMultiplier: 1.0, message: `${gap}阶压制——碾压之势` };
  if (gap === 1) return { atkMultiplier: 1.0, message: '段位优势' };
  if (gap === 0) return { atkMultiplier: 1.0, message: '' };
  if (gap === -1) return { atkMultiplier: 0.5, message: '越级挑战——战力折半' };
  if (gap === -2) return { atkMultiplier: 0.2, message: '二阶之差——蚍蜉撼树' };
  return { atkMultiplier: 0, message: '段位差距过大——攻击无效' };
}

// ── 战力差→战斗结果（匹配指数级战力标度）──
function powerDiffToResult(diff: number): { result: CombatResult; attackerWins: boolean } {
  if (diff > 300) return { result: '碾压胜', attackerWins: true };
  if (diff > 100) return { result: '完胜', attackerWins: true };
  if (diff > 30) return { result: '险胜', attackerWins: true };
  if (diff >= -30) {
    // 近均衡区间：随机决定胜负，但结果字符串与胜负一致
    const attackerWins = Math.random() > 0.5;
    return { result: attackerWins ? '险胜' : '失败可撤退', attackerWins };
  }
  if (diff >= -80) return { result: '失败可撤退', attackerWins: false };
  if (diff >= -200) return { result: '大失败', attackerWins: false };
  return { result: '碾压败', attackerWins: false };
}

// ── NPC 间战斗 ──
export async function executeCombat(
  attackerId: string, defenderId: string, locationId: string,
  config: WorldCardConfig, time: GameTime, consecutivePenalty: number = 0
): Promise<CombatContext> {
  const [attacker, defender] = await Promise.all([loadCharacter(attackerId), loadCharacter(defenderId)]);
  if (!attacker || !defender) throw new Error('战斗角色不存在');

  const location = config.locations.find(l => l.location_id === locationId) || null;

  let atkPower = calcCombatPower(attacker, location, config);
  let defPower = calcCombatPower(defender, location, config);
  atkPower -= consecutivePenalty > 0 && config.combat_config.optional_rules.consecutive_penalty ? consecutivePenalty : 0;

  // 段位压制
  const tierAdv = getTierAdvantage(attacker.stats.p_level, defender.stats.p_level);
  atkPower = Math.floor(atkPower * tierAdv.atkMultiplier);

  // 队友助战
  if (config.combat_config.optional_rules.ally_assist) {
    const allChars = await loadAllCharacters();
    for (const ally of allChars) {
      if (ally.character_id === attackerId || ally.character_id === defenderId) continue;
      if (ally.position.location_id !== locationId) continue;
      const relAtk = attacker.relationships.find(r => r.target_id === ally.character_id);
      if (relAtk && relAtk.affinity > 30) atkPower += Math.floor(calcCombatPower(ally, location, config) / 2);
      const relDef = defender.relationships.find(r => r.target_id === ally.character_id);
      if (relDef && relDef.affinity > 30) defPower += Math.floor(calcCombatPower(ally, location, config) / 2);
    }
  }

  const powerDiff = atkPower - defPower;
  const { result, attackerWins } = powerDiffToResult(powerDiff);

  const winner = attackerWins ? attacker : defender;
  const loser = attackerWins ? defender : attacker;
  const winnerPower = attackerWins ? atkPower : defPower;

  const absDiff = Math.abs(powerDiff);
  let damagePct = absDiff > 300 ? 0.6 : absDiff > 100 ? 0.35 : absDiff > 30 ? 0.2 : 0.1;
  let damage = Math.max(1, Math.ceil(loser.stats.max_hp * damagePct));

  let loot: ResourceInstance[] = [];
  if (attackerWins && absDiff > 30) {
    loot = loser.inventory.slice(0, Math.ceil(loser.inventory.length / 2));
  }

  let narrative = '';
  const tierMsg = tierAdv.message ? `（${tierAdv.message}）` : '';
  switch (result) {
    case '碾压胜': narrative = `${winner.name}轻松碾压了${loser.name}。${tierMsg}`; break;
    case '完胜': narrative = `${winner.name}干净利落地击败了${loser.name}。${tierMsg}`; break;
    case '险胜': narrative = `${winner.name}险胜${loser.name}。${tierMsg}`; break;
    case '失败可撤退': narrative = `${loser.name}处于劣势，选择撤退。${tierMsg}`; break;
    case '大失败': narrative = `${loser.name}遭受重创！${tierMsg}`; break;
    case '碾压败': narrative = `${loser.name}遭到碾压，惨败于${winner.name}之手。${tierMsg}`; break;
  }

  loser.stats.hp = Math.max(0, loser.stats.hp - damage);

  if (loser.stats.hp <= 0 && config.combat_config.optional_rules.fatal_wound) {
    if (absDiff > 100) {
      narrative += ` ${loser.name}受到致命伤，当场死亡。`;
      loser.stats.hp = -1;
      loser.agent_state = 'dormant';
    }
  }

  // 撤退：失败方可撤退时，有概率成功撤退到随机地点
  let loserFled = false;
  if (result === '失败可撤退' && config.combat_config.optional_rules.escape_roll) {
    loserFled = Math.random() < 0.6;
    if (loserFled) {
      const otherLocs = config.locations.filter(l => l.location_id !== locationId);
      if (otherLocs.length > 0) {
        const dest = otherLocs[Math.floor(Math.random() * otherLocs.length)];
        await moveEntity(loser.character_id, loser.position.location_id, dest.location_id, time, '战斗撤退');
        narrative += ` ${loser.name}撤退到了${dest.name}。`;
      }
    }
  }

  for (const item of loot) {
    await addResource(winner.character_id, item.resource_type_id, item.quantity, time);
    await addResource(loser.character_id, item.resource_type_id, -item.quantity, time);
  }

  const powerDisplay = `[战力 A:${atkPower}(${attacker.stats.base_combat_power}+${atkPower - attacker.stats.base_combat_power}) D:${defPower}(${defender.stats.base_combat_power}+${defPower - defender.stats.base_combat_power})]`;

  await Promise.all([saveCharacter(winner), saveCharacter(loser)]);

  return {
    attacker: { id: attackerId, name: attacker.name, power: atkPower },
    defender: { id: defenderId, name: defender.name, power: defPower },
    result, damage, loot, narrative: `${powerDisplay}\n${narrative}`,
    consequence: attackerWins ? 'attackerWon' : result === '失败可撤退' && loserFled ? 'defenderFled' : 'defenderWon',
  };
}
