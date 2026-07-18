// 青云界 · AI 指令白名单 + 技能定义（配方/汇率/预设指令已移交 AI 叙事管线）
import type { InstructionType, SkillDef } from '../../engine/types';

export const instructionTypes: InstructionType[] = [
  { type: 'state_change', allowed_targets: [], max_delta: 100 },
  { type: 'resource_give', allowed_targets: 'RES_灵石.RES_灵草.RES_丹药.RES_萝卜.RES_白菜.RES_干粮.RES_酒.RES_灵晶'.split('.') },
  { type: 'relation_change', allowed_targets: ['好感度'], max_delta: 5 },
  { type: 'cultivation', allowed_targets: ['修炼'], max_delta: 1 },
];

export const skillDefs: SkillDef[] = [
  { skill_id: 'RES_基础剑法', name: '基础剑法', p_level_requirement: 0, combat_bonus: 3, description: '入门剑法' },
  { skill_id: 'RES_炼丹技能', name: '炼丹技能', p_level_requirement: 1, combat_bonus: 0, description: '炼制丹药的能力' },
  { skill_id: 'RES_基础功法', name: '基础功法', p_level_requirement: 0, combat_bonus: 0, description: '修真入门的吐纳导引之术' },
  { skill_id: 'RES_高阶剑法', name: '高阶剑法', p_level_requirement: 2, combat_bonus: 8, description: '精妙的高级剑术' },
  { skill_id: 'RES_身法',     name: '身法',     p_level_requirement: 0, combat_bonus: 2, description: '轻盈的步伐' },
  { skill_id: 'RES_制符技能', name: '制符技能', p_level_requirement: 1, combat_bonus: 0, description: '制作符箓的能力' },
  { skill_id: 'RES_炼器技能', name: '炼器技能', p_level_requirement: 1, combat_bonus: 0, description: '锻造装备的能力' },
  { skill_id: 'RES_毒术',     name: '毒术',     p_level_requirement: 2, combat_bonus: 2, description: '炼制和使用毒药的秘术' },
];
