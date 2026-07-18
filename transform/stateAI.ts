// 转化层 —— 状态编排 AI（世界流 Step 5b 调用）
// 接收外交编排结果 + 个人行动方案，综合决定角色状态变化
// 是本轮世界流中最后一步 AI 调用，将前序所有 AI 输出汇总为具体状态变化
import type { CharacterInstance, WorldState, WorldCardConfig } from '../engine/types';
import { saveCharacter, loadCharacter } from '../engine/db';
import { addResource, setRelation, moveEntity } from '../engine/crud';
import { timeToString } from '../engine/time';
import { callDeepSeek, getCurrentFlowNumber } from '../engine/agent';
import { formatKLevel, formatPLevel } from '../engine/config';

export async function stateOrchestrationAI(
  worldState: WorldState, config: WorldCardConfig,
  diplomacyOutput: string, allCharacters: CharacterInstance[],
  actionSummaries: string = '',
): Promise<{ logs: string[]; executed: number }> {
  const logs: string[] = [];
  const timeStr = timeToString(worldState.game_time);
  const time = worldState.game_time;
  let executed = 0;

  // ── 构建角色状态列表 ──
  let charList = '';
  for (const ch of allCharacters) {
    if (ch.is_player) continue;
    const loc = config.locations.find(l => l.location_id === ch.position.location_id);
    const locName = loc?.name || ch.position.location_id;
    const invSummary = ch.inventory.map(r => {
      const def = config.resource_types.find(rt => rt.resource_type_id === r.resource_type_id);
      return `${def?.name || r.resource_type_id}×${r.quantity}`;
    }).join(' ') || '无';
    const driveSummary = ch.drives.map(d => `${d.type}:${d.description}(${Math.round(d.progress*100)}%)`).join(' | ');
    const facName = config.factions.find(f => f.faction_id === ch.faction_binding.faction_id)?.name || ch.faction_binding.faction_id;
    const relSummary = ch.relationships
      .filter(r => Math.abs(r.affinity) > 10)
      .map(r => {
        const target = allCharacters.find(c => c.character_id === r.target_id);
        return `${target?.name || r.target_id}:${r.affinity > 0 ? '好感' : '敌意'}${Math.abs(r.affinity)}`;
      }).join(' ') || '无';
    charList += `- ${ch.name}（ID:${ch.character_id} ${formatKLevel(ch.identity.k_level, config.mapping.k_level_names)} ${formatPLevel(ch.stats.p_level, config.mapping.p_level_names)} HP${ch.stats.hp}/${ch.stats.max_hp} 战力${ch.stats.base_combat_power}）| 位置:${locName} | 势力:${facName} 忠诚${ch.faction_binding.loyalty} | 性格:${ch.permanent_memory.personality.speech_style} | 背包:${invSummary} | 关系:${relSummary} | 目的:${driveSummary || '无'}\n`;
  }

  // ── 世界背景 ──
  const worldContext = `世界：${config.world_name} | 阶段：${worldState.event_stage}
氛围：${config.prompt_config.event_stage_mood}
法则：${config.prompt_config.world_rules_summary.slice(0, 200)}`;

  function findChar(nameOrId: string): CharacterInstance | undefined {
    return allCharacters.find(c => c.name === nameOrId || c.character_id === nameOrId) ||
      allCharacters.find(c => c.name.includes(nameOrId));
  }

  const prompt = `你是游戏世界的状态管理者。根据世界状况、外交结果、角色行动计划，综合判断每个角色在本轮世界流中应该发生的状态变化。你的输出直接驱动游戏世界的演变——让变化有意义，不要做无关紧要的微调。
【世界背景】${worldContext}
当前时间：${timeStr}

【可前往的地点】
${config.locations.map(l => `- ${l.name}(${l.location_id}): ${l.description.slice(0, 40)}`).join('\n')}

━━【各NPC行动】━━
${actionSummaries || '（各角色维持日常）'}

━━【外交结果】━━
${diplomacyOutput || '本轮无外交互动'}

━━【角色状态】━━
${charList}

输出格式（每行一条，追求质量）：
[获得资源] 角色名 资源ID 数量 原因   （因行动成功/交易/探索发现获得资源）
[消耗资源] 角色名 资源ID 数量 原因   （修炼/制作/消耗/交易支出）
[状态变化] 角色名 HP变化 +N/-N 原因  （战斗受伤/修炼恢复/丹药疗伤）
[战力变化] 角色名 +N/-N 原因          （修为突破/习得技能/装备更新）
[关系变化] 角色A → 角色B +/-N 原因   （外交互动/冲突/合作影响好感）
[移动] 角色名 目标地点名             （目的驱动/外交约定/事件牵引）
[目的完成] 角色名 目的描述            （明确达成的目的）
[无事] 角色名                       （确实什么都没变化的角色）

判断原则：
1. 行动成功 → 自动获得资源，需要符合逻辑：采药→灵草，修炼→修为，交易→灵石变更
2. 外交中的对话不应自动加好感（闲聊不加），但合作/冲突应有关系变化
3. 角色目的有实质进展才标记完成（如收集到足够资源、到达目标地点）
4. 移动必须有驱动力：目的牵引、外交约定、重大事件——不要为了移动而移动
5. 宁可漏掉小变化，不要编造不存在的变化
6. 每个变化都要有明确的原因，体现在输出中`;

  try {
    const { text } = await callDeepSeek(
      '你是一个状态编排AI。输出格式严格遵循：[类型] 参数。不要输出其他内容。',
      prompt,
      {
        type: 'state_orchestration',
        gameTime: timeStr,
        flowNumber: getCurrentFlowNumber(),
      },
      1200,
      0.7,
    );

    logs.push(`[状态编排AI] 完成`);

    // 解析并执行每条指令
    const lines = text.split('\n').filter((l: string) => l.trim());
    
    for (const line of lines) {
      logs.push(`[状态] ${line.trim()}`);
      
      let match = line.match(/^\[获得资源\]\s*(\S+)\s+(\S+)\s+(\d+)\s*(.*)?$/);
      if (match) {
        const [, charName, resId, qtyStr] = match;
        const qty = parseInt(qtyStr);
        // 校验资源ID必须存在于世界配置中
        const resDef = config.resource_types.find(rt => rt.resource_type_id === resId);
        if (!resDef) {
          logs.push(`[状态] ⚠非法资源ID：${resId}（不在世界配置中），已跳过`);
          continue;
        }
        const ch = findChar(charName);
        if (ch && qty > 0) {
          await addResource(ch.character_id, resId, qty, time, '状态编排');
          const fresh = await loadCharacter(ch.character_id);
          if (fresh) ch.inventory = fresh.inventory;
          executed++;
        } else if (!ch) { logs.push(`[状态] ⚠找不到角色：${charName}`); }
        continue;
      }
      
      match = line.match(/^\[消耗资源\]\s*(\S+)\s+(\S+)\s+(\d+)\s*(.*)?$/);
      if (match) {
        const [, charName, resId, qtyStr] = match;
        const qty = parseInt(qtyStr);
        // 校验资源ID必须存在于世界配置中
        const resDef = config.resource_types.find(rt => rt.resource_type_id === resId);
        if (!resDef) {
          logs.push(`[状态] ⚠非法资源ID：${resId}（不在世界配置中），已跳过`);
          continue;
        }
        const ch = findChar(charName);
        if (ch && qty > 0) {
          await addResource(ch.character_id, resId, -qty, time, '状态编排');
          const fresh = await loadCharacter(ch.character_id);
          if (fresh) ch.inventory = fresh.inventory;
          executed++;
        } else if (!ch) { logs.push(`[状态] ⚠找不到角色：${charName}`); }
        continue;
      }
      
      match = line.match(/^\[状态变化\]\s*(\S+)\s+HP变化\s*([+-]?\d+)\s*(.*)?$/);
      if (match) {
        const [, charName, hpStr] = match;
        const hpDelta = parseInt(hpStr);
        const ch = findChar(charName);
        if (ch && !isNaN(hpDelta)) {
          const fresh = await loadCharacter(ch.character_id);
          if (fresh) { ch.inventory = fresh.inventory; ch.relationships = fresh.relationships; ch.drives = fresh.drives; }
          ch.stats.hp = Math.max(0, Math.min(ch.stats.max_hp, ch.stats.hp + hpDelta));
          await saveCharacter(ch); executed++;
        } else if (!ch) { logs.push(`[状态] ⚠找不到角色：${charName}`); }
        continue;
      }
      
      match = line.match(/^\[战力变化\]\s*(\S+)\s*([+-]?\d+)\s*(.*)?$/);
      if (match) {
        const [, charName, pwrStr] = match;
        const pwrDelta = parseInt(pwrStr);
        const ch = findChar(charName);
        if (ch && !isNaN(pwrDelta)) {
          const fresh = await loadCharacter(ch.character_id);
          if (fresh) { ch.inventory = fresh.inventory; ch.relationships = fresh.relationships; ch.drives = fresh.drives; }
          ch.stats.base_combat_power = Math.max(0, ch.stats.base_combat_power + pwrDelta);
          await saveCharacter(ch); executed++;
        } else if (!ch) { logs.push(`[状态] ⚠找不到角色：${charName}`); }
        continue;
      }
      
      match = line.match(/^\[关系变化\]\s*(\S+)\s*→\s*(\S+)\s*([+-]?\d+)\s*(.*)?$/);
      if (match) {
        const [, nameA, nameB, deltaStr] = match;
        const delta = parseInt(deltaStr);
        const a = findChar(nameA); const b = findChar(nameB);
        if (a && b && !isNaN(delta)) {
          await setRelation(a.character_id, b.character_id, delta, time, '状态编排');
          // 同步关系：setRelation 内部已保存
          const freshA = await loadCharacter(a.character_id);
          const freshB = await loadCharacter(b.character_id);
          if (freshA) a.relationships = freshA.relationships;
          if (freshB) b.relationships = freshB.relationships;
          executed++;
        } else { logs.push(`[状态] ⚠找不到角色：${!a ? nameA : nameB}`); }
        continue;
      }
      
      match = line.match(/^\[移动\]\s*(\S+)\s*(.+)$/);
      if (match) {
        const [, charName, locName] = match;
        const ch = findChar(charName);
        const locStr = locName.trim();
        // 支持名称或 location_id 匹配
        const targetLoc = config.locations.find(l =>
          l.name === locStr || l.name.includes(locStr) || l.location_id === locStr
        );
        if (ch && targetLoc && targetLoc.location_id !== ch.position.location_id) {
          const moveResult = await moveEntity(ch.character_id, ch.position.location_id, targetLoc.location_id, time, '状态编排');
          if (moveResult.ok) {
            ch.position.previous_location_id = ch.position.location_id;
            ch.position.location_id = targetLoc.location_id;
            logs.push(`[状态·移动] ${ch.name}: → ${targetLoc.name}`);
            executed++;
          } else {
            logs.push(`[状态·移动] ⚠${ch.name} 移动失败: ${moveResult.error}`);
          }
        } else if (!ch) { logs.push(`[状态] ⚠找不到角色：${charName}`); }
        else if (!targetLoc) { logs.push(`[状态] ⚠找不到地点：${locName.trim()}`); }
        continue;
      }

      match = line.match(/^\[目的完成\]\s*(\S+)\s*(.*)?$/);
      if (match) {
        const [, charName, desc] = match;
        const ch = findChar(charName);
        if (ch) {
          const fresh = await loadCharacter(ch.character_id);
          if (fresh) { ch.inventory = fresh.inventory; ch.relationships = fresh.relationships; ch.drives = fresh.drives; }
          for (const d of ch.drives) { if ((d.type === 'quest' && desc?.includes(d.description || '')) || d.progress >= 1) { d.progress = 1; } }
          await saveCharacter(ch); executed++;
        }
      }
    }
  } catch (e: any) {
    logs.push(`[状态编排AI] 调用失败: ${e.message}`);
  }

  return { logs, executed };
}
