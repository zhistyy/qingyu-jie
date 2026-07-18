// 引擎层 —— 驱动/目的消解系统（AI 判断）
// 
// 两层机制：
//   updateDriveProgress — 纯逻辑，世界流 Step 7 中根据变化量自动推进目的进度
//   checkDriveSwitch    — AI 判断，评估目的是否已完成/应替换/应新增

import type { CharacterInstance, GameTime, DriveType, WorldCardConfig } from './types';
import { callDeepSeek, getCurrentFlowNumber } from './agent';
import { timeToString } from './time';

// ── 驱动力保底追踪：记录每个 NPC 连续只有 maintain 驱动的轮数 ──
const _maintainStreak = new Map<string, number>();

/** 纯逻辑保底：如果 NPC 连续 3 轮只有 maintain 驱动，自动添加 quest */
function applyDriveFallback(ch: CharacterInstance, flowCount: number): string | null {
  const onlyMaintain = ch.drives.length > 0 && ch.drives.every(d => d.type === 'maintain');
  const streak = (_maintainStreak.get(ch.character_id) || 0) + 1;
  _maintainStreak.set(ch.character_id, streak);

  if (!onlyMaintain || streak < 3) return null;

  // 连续 3 轮只有 maintain → 自动生成 quest
  _maintainStreak.set(ch.character_id, 0); // 重置
  const identity = ch.permanent_memory.core_identity;
  const quests = [
    { type: 'quest' as DriveType, desc: `提升修为到下一境界`, reason: '修行者本能' },
    { type: 'quest' as DriveType, desc: `寻找机缘增强实力`, reason: '世界动荡不安' },
    { type: 'ambition' as DriveType, desc: `在宗门中提升地位`, reason: indexPath(identity, '宗门') },
    { type: 'curiosity' as DriveType, desc: `探寻世界中隐藏的秘密`, reason: '对未知的好奇' },
    { type: 'quest' as DriveType, desc: `获取更强的武器/功法`, reason: '实力不足的危机感' },
  ];
  const pick = quests[Math.floor(Math.random() * quests.length)];
  ch.drives.push({ type: pick.type, description: pick.desc, priority: 0.5, progress: 0 });
  return `[保底新增] ${pick.type}: ${pick.desc} — ${pick.reason}`;
}

function indexPath(_identity: string, _default: string): string {
  return _identity.includes('宗门') || _identity.includes('弟子') ? '宗门归属感' : _default;
}

// ── 目的进度自动推进：纯逻辑，基于本轮世界流实际变化 ──
export function updateDriveProgress(
  ch: CharacterInstance,
  eventsThisCycle: string[],      // 本轮 pending_events 摘要
  personalActionSummary: string,  // 角色本轮行动摘要
  resourceChanges: { id: string; delta: number }[], // 资源增减
  relationChanges: { target: string; delta: number }[], // 关系变化
  movedToLocation: string | null, // 是否移动到了新地点
  hpChange: number,               // HP 变化
  powerChange: number,            // 战力变化
  config?: WorldCardConfig,       // 世界配置（用于动态提取资源关键词）
): string[] {
  const logs: string[] = [];

  // ── 动态资源关键词：从配置中提取资源名 + 通用修真词 ──
  const resourceKeywords = (config?.resource_types || []).map(r => r.name)
    .concat(['修为', '功法', '武器', '装备']);

  for (const drive of ch.drives) {
    if (drive.progress >= 1) continue; // 已完成
    let advance = 0;
    const desc = drive.description.toLowerCase();

    // ── 根据目的类型和本轮变化，估算进度增量 ──

    // quest / ambition: 任何主动行动 + 相关关键词
    if (drive.type === 'quest' || drive.type === 'ambition') {
      if (personalActionSummary.length > 10 && personalActionSummary !== `${ch.name}按部就班地度过。`) {
        advance += 0.08; // 主动行动就有进展（从5%提升到8%）
      }
      // 关键词匹配：目的描述中的词是否出现在行动/事件中
      const keywords = drive.description.split(/[，,。\s]+/).filter(w => w.length >= 2);
      const matchCount = keywords.filter(kw => {
        const lower = kw.toLowerCase();
        return personalActionSummary.toLowerCase().includes(lower) ||
          eventsThisCycle.some(e => e.toLowerCase().includes(lower));
      }).length;
      if (keywords.length > 0 && matchCount > 0) {
        advance += 0.05 * Math.min(matchCount, 5);
      }
      // 获得相关资源：目的涉及"灵石/丹药/功法"等 → 资源获取即进展
      for (const kw of resourceKeywords) {
        if (desc.includes(kw)) {
          const gained = resourceChanges
            .filter(r => r.delta > 0 && r.id.toLowerCase().includes(kw.toLowerCase()))
            .reduce((s, r) => s + r.delta, 0);
          if (gained > 0) advance += 0.03 * Math.min(gained, 10);
        }
      }
      // 移动到目标相关地点
      if (movedToLocation && desc.includes(movedToLocation.slice(0, 3))) {
        advance += 0.1;
      }
    }

    // survival: HP 恢复、威胁消除
    if (drive.type === 'survival') {
      if (hpChange > 0) advance += 0.02 * Math.min(hpChange, 20);
      // 有威胁相关的消息处理了 → 进展
      const threatWords = ['战斗', '受伤', '威胁', '危险', '敌人', '入侵'];
      if (eventsThisCycle.some(e => threatWords.some(w => e.includes(w)))) {
        advance += 0.05;
      }
      // 自身没受伤 → 存活进展
      if (hpChange >= 0 && ch.stats.hp >= ch.stats.max_hp * 0.5) {
        advance += 0.03;
      }
    }

    // expansion: 资源增长、势力扩张
    if (drive.type === 'expansion') {
      const totalGained = resourceChanges.filter(r => r.delta > 0).reduce((s, r) => s + r.delta, 0);
      if (totalGained > 0) advance += 0.02 * Math.min(totalGained, 50);
      if (movedToLocation && !ch.last_known_positions?.some(p => p.location_id === movedToLocation)) {
        advance += 0.05; // 探索新地点
      }
    }

    // revenge: 目标受损、关系恶化
    if (drive.type === 'revenge') {
      const negativeRels = relationChanges.filter(r => r.delta < 0);
      if (negativeRels.length > 0) {
        advance += 0.05 * Math.min(negativeRels.length, 3);
      }
      // 目的描述中提到的角色如果受了负面关系变化 → 进展
      for (const rel of relationChanges) {
        if (rel.delta < 0 && desc.includes(rel.target.slice(0, 3))) {
          advance += 0.08;
        }
      }
    }

    // loyalty: 势力贡献/关系变好
    if (drive.type === 'loyalty') {
      const positiveRels = relationChanges.filter(r => r.delta > 0);
      if (positiveRels.length > 0) advance += 0.03 * Math.min(positiveRels.length, 5);
      // 获得资源也可以理解为对势力的贡献
      const gained = resourceChanges.filter(r => r.delta > 0).reduce((s, r) => s + r.delta, 0);
      if (gained > 0) advance += 0.01 * Math.min(gained, 20);
    }

    // curiosity: 探索新地点、获知新信息
    if (drive.type === 'curiosity') {
      if (movedToLocation) advance += 0.08; // 移动到新地方
      if (eventsThisCycle.length > 0) advance += 0.02 * Math.min(eventsThisCycle.length, 5);
      if (personalActionSummary.includes('探索') || personalActionSummary.includes('查看') || personalActionSummary.includes('调查')) {
        advance += 0.05;
      }
    }

    // maintain: 缓慢自动推进
    if (drive.type === 'maintain') {
      advance += 0.05; // 维持型目的每轮自然推进 5%（50轮→20轮）
    }

    // 泛用：战力提升 → ambition/quest 都有推进
    if (powerChange > 0 && (drive.type === 'ambition' || drive.type === 'quest')) {
      advance += 0.03 * Math.min(powerChange, 50);
    }

    // 泛用：HP 提升 → 生存/维持
    if (hpChange > 0 && (drive.type === 'survival' || drive.type === 'maintain')) {
      advance += 0.01 * Math.min(hpChange, 20);
    }

    if (advance > 0) {
      drive.progress = Math.min(1, drive.progress + advance);
      logs.push(`${ch.name}「${drive.description}」+${Math.round(advance * 100)}% → ${Math.round(drive.progress * 100)}%`);
    }
  }

  return logs;
}

// ── 目的消解：世界流 Step 7 中调用，AI 判断目的是否完成/变化 ──
export async function checkDriveSwitch(
  ch: CharacterInstance, time: GameTime,
  options?: { worldEvents?: string; nearbyNpcNames?: string; flowCount?: number; worldStage?: string },
): Promise<{ switched: boolean; removed: string[]; added: string[] }> {
  const removed: string[] = [];
  const added: string[] = [];

  // 如果没有目的，给一个保底
  if (ch.drives.length === 0) {
    ch.drives.push({ type: 'maintain', description: '按日常安排活动', priority: 0.3, progress: 0 });
    added.push('[保底] 日常活动');
    return { switched: true, removed, added };
  }

  const timeStr = timeToString(time);
  const drivesText = ch.drives.map((d, i) =>
    `[${i}] ${d.type}: ${d.description}（进度 ${Math.round(d.progress * 100)}%）`
  ).join('\n');

  const eventsText = ch.short_term_buffer.pending_events.map(e =>
    `- ${e.summary.slice(0, 60)}`
  ).join('\n') || '无新事件';

  const hpPercent = Math.round(ch.stats.hp / ch.stats.max_hp * 100);

  // 附加上下文：世界事件和周边 NPC 动态
  let extraContext = '';
  if (options?.worldEvents) {
    extraContext += `\n【世界大事】${options.worldEvents}`;
  }
  if (options?.nearbyNpcNames) {
    extraContext += `\n【周边人物】${options.nearbyNpcNames}`;
  }
  if (options?.worldStage) {
    extraContext += `\n【世界阶段】${options.worldStage}`;
  }
  // 驱动力不足的提示
  const onlyMaintain = ch.drives.every(d => d.type === 'maintain');
  if (onlyMaintain && ch.drives.length === 1) {
    extraContext += `\n【特别提示】此角色目前只有一个维持型目的（${ch.drives[0].description}），驱动力不足。请考虑为其创造符合身份（${ch.permanent_memory.core_identity}）的 quest 或 ambition 类型新目的。`;
  }

  const prompt = `你是角色 ${ch.name}（${ch.permanent_memory.core_identity}）的目的评估者。根据角色当前状态、本轮经历的事件、以及现有目的，判断哪些目的已经完成或应该改变。

【角色状态】
HP: ${ch.stats.hp}/${ch.stats.max_hp} (${hpPercent}%)
战力: ${ch.stats.base_combat_power}
性格: ${ch.permanent_memory.personality.speech_style}

【本轮经历】
${eventsText}
${extraContext}

【当前目的】
${drivesText}

输出格式（每行一条，无变化不输出）：
[完成] 目的编号 — 原因（如果某目的已达成）
[放弃] 目的编号 — 原因（如果某目的不再适用）
[新增] 类型: 描述 — 原因（如果某个新目的出现了）

注意：
- quest 类型目的在 progress≈100% 时通常已完成
- survival 类型目的在 HP 恢复后可能消解
- 性格影响目的转变方式
- 最多新增 2 个目的
- 保留至少 1 个目的
- 鼓励为角色创造符合其身份和处境的新目的，让世界更生动
- 如果角色只有一个维持型目的，强烈建议新增更有驱动力的目的（quest 或 ambition）`;

  try {
    const { text } = await callDeepSeek(prompt, '请评估目的状态。', {
      type: 'drive_check',
      gameTime: timeStr,
      characterName: ch.name,
      flowNumber: getCurrentFlowNumber(),
    }, 300);

    const lines = text.split('\n').filter((l: string) => l.trim());

    for (const line of lines) {
      const completeMatch = line.match(/^\[完成\]\s*(\d+)\s*[-—]\s*(.+)$/);
      if (completeMatch) {
        const idx = parseInt(completeMatch[1]);
        const reason = completeMatch[2].trim();
        if (idx < ch.drives.length) {
          removed.push(`[完成] ${ch.drives[idx].description}：${reason}`);
          ch.drives[idx].progress = 1; // 标记完成，下一步过滤
        }
        continue;
      }

      const abandonMatch = line.match(/^\[放弃\]\s*(\d+)\s*[-—]\s*(.+)$/);
      if (abandonMatch) {
        const idx = parseInt(abandonMatch[1]);
        const reason = abandonMatch[2].trim();
        if (idx < ch.drives.length) {
          removed.push(`[放弃] ${ch.drives[idx].description}：${reason}`);
          ch.drives[idx].progress = -1; // 标记放弃，下一步过滤
        }
        continue;
      }

      const addMatch = line.match(/^\[新增\]\s*(\S+)[:：]\s*(.+?)\s*[-—]\s*(.+)$/);
      if (addMatch) {
        const [, type, desc, reason] = addMatch;
        // 最多新增 2 个
        if (added.length < 2) {
          const validTypes: DriveType[] = ['maintain','expansion','quest','revenge','survival','ambition','loyalty','curiosity'];
          const driveType: DriveType = validTypes.includes(type as DriveType) ? (type as DriveType) : 'quest';
          ch.drives.push({ type: driveType, description: desc.trim(), priority: 0.5, progress: 0 });
          added.push(`[新增] ${type}: ${desc.trim()} — ${reason.trim()}`);
        }
        continue;
      }
    }
  } catch (e) {
    console.error('[drive] checkDriveSwitch AI 调用失败:', e);
    // AI 调用失败：保留所有目的，不做变更
  }

  // 过滤已标记完成/放弃的目的
  ch.drives = ch.drives.filter(d => d.progress >= 0 && d.progress < 1);

  // 同类型去重
  const seenTypes = new Set<string>();
  ch.drives = ch.drives.filter(d => {
    if (seenTypes.has(d.type)) {
      removed.push(`[去重] ${d.description}`);
      return false;
    }
    seenTypes.add(d.type);
    return true;
  });

  // 如果全被清空，保底
  if (ch.drives.length === 0) {
    ch.drives.push({ type: 'maintain', description: '按日常安排活动', priority: 0.3, progress: 0 });
    added.push('[保底] 日常活动');
  }

  // ── 纯逻辑保底：连续3轮只有 maintain 驱动 → 自动添加 quest ──
  const fallbackResult = applyDriveFallback(ch, options?.flowCount || 0);
  if (fallbackResult) {
    added.push(fallbackResult);
  }

  return { switched: removed.length > 0 || added.length > 0, removed, added };
}
