// 青云界 · 世界基础配置
import type { GameTime, Season, TimeOfDay } from '../../engine/types';

export const ZERO_TIME: GameTime = { year: 0, season: '春' as Season, day: 1, timeOfDay: '卯时' as TimeOfDay };

export const timeConfig = {
  world_flow_step_days: 5,
  season_days: { '春': 90, '夏': 90, '秋': 90, '冬': 90 } as Record<Season, number>,
  total_time_span_years: 300,
};

export const promptConfig = {
  reply_max_length: 250,
  player_gender: '男',  // 玩家性别：男/女，AI 据此使用正确称呼
  event_stage_mood: '风雨欲来，暗流涌动——各方势力都在积蓄力量，青云界的平静即将被打破。',
  world_rules_summary: '修真世界，力量体系为凡人→练气→筑基→金丹→元婴。只有修炼者能使用法术，凡人无法使用任何超自然能力。灵石是通用货币，灵晶是高等货币。',
  cultivation_thresholds: {
    '0→1': { required_progress: 20, required_spirit_stones: 10, required_pills: 1, require_skill: 'RES_基础功法' },
    '1→2': { required_progress: 60, required_spirit_stones: 40, required_pills: 5, require_skill: 'RES_基础功法' },
    '2→3': { required_progress: 200, required_spirit_stones: 200, required_pills: 20, require_skill: 'RES_基础功法' },
    '3→4': { required_progress: 1000, required_spirit_stones: 1000, required_pills: 60, require_skill: 'RES_基础功法' },
  } as Record<string, { required_progress: number; required_spirit_stones: number; required_pills: number; require_skill: string }>,
};

export const mapping = {
  p_level_names: ['凡人', '练气期', '筑基期', '金丹期', '元婴期'],
  k_level_names: ['杂役', '外门弟子', '内门弟子', '真传弟子', '执事', '长老', '掌门'],
  drive_type_names: { maintain: '维持', expansion: '扩张', quest: '任务', revenge: '复仇', survival: '求生', ambition: '野心', loyalty: '效忠', curiosity: '探索' } as Record<string, string>,
  agent_state_names: { active: '活跃', pending: '待定', dormant: '休眠', alert: '警戒' } as Record<string, string>,
  memory_mode_names: { summary: '摘要', detailed: '详细' } as Record<string, string>,
  resource_category_names: { material: '材料', currency: '货币', consumable: '消耗品', skill: '技能书', equipment: '装备', cultivation: '修炼' } as Record<string, string>,
  rarity_names: {
    r1: { name: '凡品', color: '#a8a8a8' },
    r2: { name: '良品', color: '#30b070' },
    r3: { name: '灵品', color: '#4090e0' },
    r4: { name: '宝品', color: '#a060e0' },
    r5: { name: '仙品', color: '#d4aa48' },
    r6: { name: '神品', color: '#e06060' },
  } as Record<string, { name: string; color: string }>,
  time_flavors: {
    卯时: { 春: '晨光初现，薄雾笼罩。', 夏: '天刚蒙蒙亮，已有几分燥热。', 秋: '清晨露水很重，凉意透骨。', 冬: '天色昏暗，寒风刺骨。' },
    午时: { 春: '阳光温暖和煦，春风拂面。', 夏: '烈日当头，暑气蒸腾。', 秋: '秋高气爽，天高云淡。', 冬: '阳光微弱，寒意不减。' },
    酉时: { 春: '夕阳西下，天色渐暗。', 夏: '黄昏时分，暑气渐消。', 秋: '暮色苍茫，落叶纷飞。', 冬: '天色已暗，寒风更紧。' },
    子时: { 春: '夜深人静，只有虫鸣。', 夏: '夜空中繁星点点。', 秋: '月光如水，万籁俱寂。', 冬: '长夜漫漫，万籁俱寂。' },
  } as Record<string, Record<string, string>>,
  speech_guides: {
    接地气: '说话直白通俗，用大白话。',
    文绉绉: '说话文雅，多用成语典故。',
    江湖气: '说话豪爽直接，爱用俚语。',
    书卷气: '说话条理清晰，引经据典。',
    乡土气: '说话朴实，带着乡音。',
  } as Record<string, string>,
};

export const combatConfig = {
  p_level_base_power: { 0: 5, 1: 25, 2: 120, 3: 500, 4: 2000 } as Record<number, number>,
  equipment_bonuses: { RES_铁剑: 5, RES_铁甲: 8, RES_法袍: 20, RES_寒铁剑: 25 } as Record<string, number>,
  skill_bonuses: { RES_基础剑法: 5, RES_高阶剑法: 20, RES_身法: 5, RES_毒术: 8 } as Record<string, number>,
  optional_rules: { ally_assist: true, consecutive_penalty: false, escape_roll: true, fatal_wound: false },
};
