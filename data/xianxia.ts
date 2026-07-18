// 青云界 · 世界配置总入口
// 从 world/ 子模块导入，保持对外接口不变
import type { WorldCardConfig, WorldState, GameTime, Season, TimeOfDay } from '../engine/types';
import { timeConfig, promptConfig, mapping, combatConfig } from './world/config';
import { resourceTypes } from './world/resources';
import { locations } from './world/locations';
import { npcCharacters } from './world/characters';
import { factions, enemies } from './world/factions';
import { instructionTypes, skillDefs } from './world/commands';

export const xianxiaConfig: WorldCardConfig = {
  world_name: '青云界',
  world_description: '以修真为根基的广袤大陆。青云宗雄踞天柱山脉，统御方圆千里。飞仙城散修与商会云集，万宝商会旗帜遍布各城。南方幽冥沼泽终年瘴气弥漫，传说有上古魔修遗迹。北境剑崖剑气千年不散。古秘境时隐时现，每次开启都牵动各方势力。弱肉强食，灵石是硬通货，修为是话语权，秘境机缘足以改变命运。',
  time_config: timeConfig,
  world_flow_trigger_count: 5, // 每5次交互触发世界流
  prompt_config: promptConfig,
  mapping,
  combat_config: combatConfig,
  resource_types: resourceTypes,
  locations,
  characters: npcCharacters,
  factions,
  enemies,
  instruction_types: instructionTypes,
  skill_defs: skillDefs,
  grand_events: [],
};

export const initialWorldState: WorldState = {
  game_time: { year: 1524, season: '春' as Season, day: 3, timeOfDay: '卯时' as TimeOfDay },
  flow_count: 0,
  event_stage: '太平时期',
  event_stage_start_year: 1524,
  event_stage_end_year: 1824,
  current_year: 1524,
  total_time_span: timeConfig.total_time_span_years,
  is_ended: false,
  is_free_exploration: true,
  world_flow_step_length_days: timeConfig.world_flow_step_days,
  baseline: {
    min_alive_characters: 3,
    min_resource_amounts: { RES_灵石: 50, RES_灵草: 20 },
    min_enemy_density: {},
  },
};
