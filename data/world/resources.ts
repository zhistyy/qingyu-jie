// 青云界 · 资源类型定义（精简版）
import type { ResourceTypeDef } from '../../engine/types';
import { ZERO_TIME } from './config';

// 精简：只保留核心资源，去除过于琐碎的蔬菜品种
export const resourceTypes: ResourceTypeDef[] = [
  // ── 货币 ──
  { resource_type_id: 'RES_灵石',      name: '灵石',   category: 'currency',   rarity: 'r2', base_value: 1,   stackable: true,  description: '修真界通用货币，蕴含灵气。' },
  { resource_type_id: 'RES_灵晶',      name: '灵晶',   category: 'currency',   rarity: 'r5', base_value: 100, stackable: true,  description: '灵石高度浓缩结晶，一枚抵百枚，极为稀有。' },
  { resource_type_id: 'RES_暗灵石',    name: '暗灵石', category: 'currency',   rarity: 'r3', base_value: 2,   stackable: true,  description: '蕴含暗属性灵气的灵石，幽冥教主要货币。' },

  // ── 材料 ──
  { resource_type_id: 'RES_灵草',      name: '灵草',   category: 'material',   rarity: 'r3', base_value: 3,   stackable: true,  description: '炼丹基础材料，蕴含灵气。' },
  { resource_type_id: 'RES_妖兽皮',    name: '妖兽皮', category: 'material',   rarity: 'r2', base_value: 5,   stackable: true,  description: '妖兽坚韧皮革，可制甲胄。' },
  { resource_type_id: 'RES_妖兽骨',    name: '妖兽骨', category: 'material',   rarity: 'r2', base_value: 8,   stackable: true,  description: '妖兽坚硬骨头，炼器炼丹都需要。' },
  { resource_type_id: 'RES_妖丹',      name: '妖丹',   category: 'material',   rarity: 'r4', base_value: 50,  stackable: true,  description: '妖兽内丹，蕴含精纯妖力。' },
  { resource_type_id: 'RES_铁矿',      name: '铁矿',   category: 'material',   rarity: 'r1', base_value: 2,   stackable: true,  description: '普通铁矿石，可熔炼为铁锭。' },
  { resource_type_id: 'RES_寒铁',      name: '寒铁',   category: 'material',   rarity: 'r3', base_value: 15,  stackable: true,  description: '剑崖产出的稀有矿石，寒气逼人。' },
  { resource_type_id: 'RES_铜矿',      name: '铜矿',   category: 'material',   rarity: 'r1', base_value: 1,   stackable: true,  description: '常见铜矿石。' },
  { resource_type_id: 'RES_朱砂',      name: '朱砂',   category: 'material',   rarity: 'r1', base_value: 3,   stackable: true,  description: '画符用的红色矿物颜料。' },
  { resource_type_id: 'RES_符纸',      name: '符纸',   category: 'material',   rarity: 'r1', base_value: 1,   stackable: true,  description: '以灵木浆制成的黄色符纸。' },
  { resource_type_id: 'RES_毒囊',      name: '毒囊',   category: 'material',   rarity: 'r3', base_value: 12,  stackable: true,  description: '沼泽妖兽毒囊，炼毒材料。' },
  { resource_type_id: 'RES_灵泉水',    name: '灵泉水', category: 'material',   rarity: 'r3', base_value: 20,  stackable: true,  description: '灵泉洞天然泉水，炼丹品质加成。' },
  { resource_type_id: 'RES_古宝碎片',  name: '古宝碎片', category: 'material', rarity: 'r5', base_value: 80,  stackable: true,  description: '上古法宝碎裂后的残片，仍蕴含威能。' },
  // 灵田作物（精简为代表性几种）
  { resource_type_id: 'RES_萝卜',      name: '萝卜',   category: 'material',   rarity: 'r1', base_value: 1,   stackable: true,  description: '灵田里种的新鲜萝卜。' },
  { resource_type_id: 'RES_白菜',      name: '白菜',   category: 'material',   rarity: 'r1', base_value: 1,   stackable: true,  description: '饱满的大白菜。' },

  // ── 消耗品 ──
  { resource_type_id: 'RES_丹药',      name: '丹药',   category: 'consumable', rarity: 'r3', base_value: 10,  stackable: true,  description: '通用修炼丹药，恢复少量HP。' },
  { resource_type_id: 'RES_疗伤丹',    name: '疗伤丹', category: 'consumable', rarity: 'r2', base_value: 12,  stackable: true,  description: '恢复HP的疗伤丹药。' },
  { resource_type_id: 'RES_回气丹',    name: '回气丹', category: 'consumable', rarity: 'r3', base_value: 25,  stackable: true,  description: '恢复灵气的丹药。' },
  { resource_type_id: 'RES_筑基丹',    name: '筑基丹', category: 'consumable', rarity: 'r4', base_value: 80,  stackable: true,  description: '突破筑基期所需的丹药。' },
  { resource_type_id: 'RES_符箓',      name: '符箓',   category: 'consumable', rarity: 'r2', base_value: 15,  stackable: true,  description: '封印了法术的符纸，可施展法术。' },
  { resource_type_id: 'RES_化毒丹',    name: '化毒丹', category: 'consumable', rarity: 'r3', base_value: 30,  stackable: true,  description: '解毒丹药。' },
  { resource_type_id: 'RES_酒',        name: '酒',     category: 'consumable', rarity: 'r1', base_value: 5,   stackable: true,  description: '醉仙楼的招牌灵酒。' },
  { resource_type_id: 'RES_干粮',      name: '干粮',   category: 'consumable', rarity: 'r1', base_value: 2,   stackable: true,  description: '面饼和肉干的组合，填饱肚子。' },

  // ── 装备 ──
  { resource_type_id: 'RES_铁剑',      name: '铁剑',   category: 'equipment',  rarity: 'r2', base_value: 20,  stackable: false, description: '普通铁制长剑。' },
  { resource_type_id: 'RES_铁甲',      name: '铁甲',   category: 'equipment',  rarity: 'r3', base_value: 50,  stackable: false, description: '铁制护甲，提供防御。' },
  { resource_type_id: 'RES_布衣',      name: '布衣',   category: 'equipment',  rarity: 'r1', base_value: 5,   stackable: false, description: '粗布衣裳，舒适透气。' },
  { resource_type_id: 'RES_法袍',      name: '法袍',   category: 'equipment',  rarity: 'r4', base_value: 100, stackable: false, description: '加持了灵气的法袍。' },
  { resource_type_id: 'RES_寒铁剑',    name: '寒铁剑', category: 'equipment',  rarity: 'r4', base_value: 120, stackable: false, description: '以寒铁锻造的上品宝剑。' },

  // ── 技能书 ──
  { resource_type_id: 'RES_基础剑法',  name: '基础剑法', category: 'skill',   rarity: 'r2', base_value: 30,  stackable: false, description: '基本剑术入门。' },
  { resource_type_id: 'RES_基础功法',  name: '基础功法', category: 'skill',   rarity: 'r1', base_value: 20,  stackable: false, description: '修真入门吐纳导引之术。' },
  { resource_type_id: 'RES_高阶剑法',  name: '高阶剑法', category: 'skill',   rarity: 'r3', base_value: 80,  stackable: false, description: '精妙的高级剑术。' },
  { resource_type_id: 'RES_身法',      name: '身法',   category: 'skill',     rarity: 'r2', base_value: 40,  stackable: false, description: '轻盈步伐，战斗闪避。' },
  { resource_type_id: 'RES_炼丹技能',  name: '炼丹技能', category: 'skill',   rarity: 'r4', base_value: 50,  stackable: false, description: '掌握炼丹之术。' },
  { resource_type_id: 'RES_制符技能',  name: '制符技能', category: 'skill',   rarity: 'r3', base_value: 60,  stackable: false, description: '制作符箓的能力。' },
  { resource_type_id: 'RES_炼器技能',  name: '炼器技能', category: 'skill',   rarity: 'r3', base_value: 70,  stackable: false, description: '锻造和修复装备。' },
  { resource_type_id: 'RES_毒术',      name: '毒术',   category: 'skill',     rarity: 'r3', base_value: 65,  stackable: false, description: '炼制和使用毒药的秘术。' },

  // ── 修炼 ──
  { resource_type_id: 'RES_修为进度',  name: '修为进度', category: 'cultivation', rarity: 'r1', base_value: 1, stackable: true, description: '修炼积累的修为点数，用于突破。' },

  // ═══════════ 扩展资源（可删除） ═══════════
  { resource_type_id: 'RES_星陨铁',  name: '星陨铁', category: 'material', rarity: 'r4', base_value: 60, stackable: true, description: '坠星湖底的稀有金属，蕴含星辰之力。', source: 'extension' },
  { resource_type_id: 'RES_灵玉',    name: '灵玉',   category: 'currency', rarity: 'r5', base_value: 500, stackable: true, description: '灵石矿脉深处偶尔产出的极品灵石，一枚抵五百。', source: 'extension' },
  { resource_type_id: 'RES_妖兽血',  name: '妖兽血', category: 'material', rarity: 'r3', base_value: 20, stackable: true, description: '妖兽心头精血，炼丹制符的珍贵材料。', source: 'extension' },
  { resource_type_id: 'RES_灵芝',    name: '灵芝',   category: 'material', rarity: 'r4', base_value: 40, stackable: true, description: '生长在绝壁之上的稀有灵芝，可炼制高阶丹药。', source: 'extension' },
  { resource_type_id: 'RES_灵木',    name: '灵木',   category: 'material', rarity: 'r2', base_value: 10, stackable: true, description: '蕴含灵气的木材，常用于制作符纸和法器。', source: 'extension' },
  { resource_type_id: 'RES_古剑残片', name: '古剑残片', category: 'material', rarity: 'r4', base_value: 45, stackable: true, description: '千年前断折的飞剑碎片，仍残留着上古剑意。', source: 'extension' },
];
