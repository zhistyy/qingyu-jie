// 青云界 · 势力 + 敌人定义（精简版）
import type { FactionDef, EnemyDef } from '../../engine/types';
import { ZERO_TIME } from './config';

export const factions: FactionDef[] = [
  {
    faction_id: 'FAC_外门', name: '外门', k_level: 1,
    controlled_locations: ['LOC_山门广场', 'LOC_外门弟子院', 'LOC_灵田', 'LOC_演武场', 'LOC_功勋堂', 'LOC_灵石矿脉', 'LOC_地火炼器坊'],
    core_interests: ['招收有资质的弟子', '维持宗门日常运转', '保护矿脉资源'],
    treasury: [
      { resource_type_id: 'RES_灵石', quantity: 200, last_updated: ZERO_TIME, location_id: 'FAC_外门' },
      { resource_type_id: 'RES_铁矿', quantity: 50, last_updated: ZERO_TIME, location_id: 'FAC_外门' },
    ],
    diplomatic_states: { FAC_内门: '友好', FAC_万宝商会: '友好', FAC_散修: '中立', FAC_幽冥教: '冷淡' },
    member_requirements: '青云宗杂役或外门弟子',
  },
  {
    faction_id: 'FAC_内门', name: '内门', k_level: 5,
    controlled_locations: ['LOC_炼丹阁', 'LOC_藏经阁', 'LOC_长老殿', 'LOC_天柱峰', 'LOC_灵泉洞'],
    core_interests: ['培养核心战力', '守护宗门机密', '维护青云界秩序'],
    treasury: [
      { resource_type_id: 'RES_灵石', quantity: 1000, last_updated: ZERO_TIME, location_id: 'FAC_内门' },
      { resource_type_id: 'RES_灵晶', quantity: 50, last_updated: ZERO_TIME, location_id: 'FAC_内门' },
    ],
    diplomatic_states: { FAC_外门: '友好', FAC_万宝商会: '中立', FAC_散修: '友好', FAC_幽冥教: '敌对' },
    member_requirements: '修为筑基以上且经过考核',
  },
  {
    faction_id: 'FAC_万宝商会', name: '万宝商会', k_level: 4,
    controlled_locations: ['LOC_飞仙城', 'LOC_坊市', 'LOC_醉仙楼'],
    core_interests: ['垄断灵石交易', '控制资源流通', '收集各地情报'],
    treasury: [
      { resource_type_id: 'RES_灵石', quantity: 5000, last_updated: ZERO_TIME, location_id: 'FAC_万宝商会' },
    ],
    diplomatic_states: { FAC_外门: '友好', FAC_内门: '中立', FAC_散修: '友好', FAC_幽冥教: '中立' },
    member_requirements: '无限制，交灵石即可加入',
  },
  {
    faction_id: 'FAC_散修', name: '散修', k_level: 0,
    controlled_locations: [],
    core_interests: ['各自修行', '零散交易', '不受约束'],
    treasury: [],
    diplomatic_states: { FAC_外门: '中立', FAC_内门: '中立', FAC_万宝商会: '中立', FAC_幽冥教: '冷淡' },
    member_requirements: '无，散修无正式组织',
  },
  {
    faction_id: 'FAC_幽冥教', name: '幽冥教', k_level: 4,
    controlled_locations: ['LOC_幽冥沼泽'],
    core_interests: ['颠覆青云宗', '扩张暗属性势力', '夺取古秘境'],
    treasury: [
      { resource_type_id: 'RES_暗灵石', quantity: 500, last_updated: ZERO_TIME, location_id: 'FAC_幽冥教' },
      { resource_type_id: 'RES_毒囊', quantity: 100, last_updated: ZERO_TIME, location_id: 'FAC_幽冥教' },
    ],
    diplomatic_states: { FAC_外门: '冷淡', FAC_内门: '敌对', FAC_万宝商会: '中立', FAC_散修: '冷淡' },
    member_requirements: '修炼暗属性功法或效忠幽冥教',
  },

  // ═══════════ 扩展势力（可删除） ═══════════
  {
    faction_id: 'FAC_天机阁', name: '天机阁', k_level: 4,
    core_interests: ['收集天下情报', '解读天道征兆', '暗中维持各方势力平衡'],
    controlled_locations: [],
    treasury: [
      { resource_type_id: 'RES_灵石', quantity: 300, last_updated: ZERO_TIME, location_id: 'FAC_天机阁' },
      { resource_type_id: 'RES_灵玉', quantity: 5, last_updated: ZERO_TIME, location_id: 'FAC_天机阁' },
    ],
    diplomatic_states: { FAC_外门: '中立', FAC_内门: '友好', FAC_万宝商会: '友好', FAC_散修: '中立', FAC_幽冥教: '冷淡' },
    member_requirements: '具备观测天象或解读征兆的能力',
    source: 'extension',
  },
];

export const enemies: EnemyDef[] = [
  { enemy_id: 'ENM_灵兔', name: '灵兔', danger_level: '低', hp: 10, combat_power: 3, p_level: 0, description: '偷吃灵草的灵兔，胆小但跑得飞快。', loot: [{ resource_type_id: 'RES_灵草', quantity: 1 }] },
  { enemy_id: 'ENM_妖兽', name: '妖兽', danger_level: '中', hp: 30, combat_power: 15, p_level: 1, description: '后山常见的妖兽，凶悍好斗。', loot: [{ resource_type_id: 'RES_妖兽皮', quantity: 1 }, { resource_type_id: 'RES_妖兽骨', quantity: 1 }] },
  { enemy_id: 'ENM_妖将', name: '妖将', danger_level: '高', hp: 80, combat_power: 40, p_level: 2, description: '妖兽谷中的强大首领，浑身散发着凶煞之气。', loot: [{ resource_type_id: 'RES_妖兽骨', quantity: 3 }, { resource_type_id: 'RES_妖丹', quantity: 1 }] },
  { enemy_id: 'ENM_矿洞鼠', name: '矿洞鼠', danger_level: '低', hp: 15, combat_power: 5, p_level: 0, description: '矿脉里的大老鼠，不光偷灵石灰尘还很凶。', loot: [{ resource_type_id: 'RES_灵石', quantity: 1 }] },
  { enemy_id: 'ENM_剑魂', name: '剑魂', danger_level: '高', hp: 50, combat_power: 35, p_level: 2, description: '上古剑仙残留在剑崖上的剑意凝聚的灵体。', loot: [{ resource_type_id: 'RES_寒铁', quantity: 3 }] },
  { enemy_id: 'ENM_殿灵', name: '殿灵', danger_level: '高', hp: 60, combat_power: 30, p_level: 2, description: '长老殿禁制凝聚的灵体，守护祖师牌位。', loot: [{ resource_type_id: 'RES_灵石', quantity: 20 }] },
  { enemy_id: 'ENM_雪妖', name: '雪妖', danger_level: '高', hp: 70, combat_power: 45, p_level: 3, description: '天柱峰顶的冰雪精怪，常年守护峰顶秘境。', loot: [{ resource_type_id: 'RES_灵晶', quantity: 2 }] },
  { enemy_id: 'ENM_沼泽妖', name: '沼泽妖', danger_level: '高', hp: 55, combat_power: 30, p_level: 2, description: '幽冥沼泽中滋生出的暗属性妖兽。', loot: [{ resource_type_id: 'RES_毒囊', quantity: 2 }] },
  { enemy_id: 'ENM_守护兽', name: '守护兽', danger_level: '高', hp: 100, combat_power: 50, p_level: 3, description: '古秘境入口的守护妖兽，千年不曾离开。', loot: [{ resource_type_id: 'RES_灵晶', quantity: 3 }, { resource_type_id: 'RES_古宝碎片', quantity: 1 }] },

  // ═══════════ 扩展敌人（可删除） ═══════════
  { enemy_id: 'ENM_山贼', name: '山贼', danger_level: '低', hp: 18, combat_power: 8, p_level: 0, description: '黑风寨的亡命之徒，靠打劫为生。三五成群时颇为难缠。', loot: [{ resource_type_id: 'RES_灵石', quantity: 5 }, { resource_type_id: 'RES_干粮', quantity: 2 }], source: 'extension' },
  { enemy_id: 'ENM_剑冢怨灵', name: '剑冢怨灵', danger_level: '高', hp: 45, combat_power: 40, p_level: 2, description: '古剑冢中未散的上古剑修残魂，被剑意束缚千年。', loot: [{ resource_type_id: 'RES_古剑残片', quantity: 2 }, { resource_type_id: 'RES_寒铁', quantity: 2 }], source: 'extension' },
  { enemy_id: 'ENM_水妖', name: '水妖', danger_level: '中', hp: 30, combat_power: 18, p_level: 1, description: '坠星湖中的水生灵兽，被星辰之力异化后变得凶暴。', loot: [{ resource_type_id: 'RES_星陨铁', quantity: 1 }, { resource_type_id: 'RES_妖兽血', quantity: 1 }], source: 'extension' },
];
