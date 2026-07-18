// TO-RPG 核心类型 — v2 对称设计，玩家和AI共用

export type Season = '春'|'夏'|'秋'|'冬';
export type TimeOfDay = '卯时'|'午时'|'酉时'|'子时';
export type KLevel = 0|1|2|3|4|5|6;
export type PLevel = 0|1|2|3|4;
export type AgentState = 'active'|'pending'|'dormant'|'alert';
export type DriveType = 'maintain'|'expansion'|'quest'|'revenge'|'survival'|'ambition'|'loyalty'|'curiosity';
export type VisibilityLevel = 'public'|'semi_public'|'private'|'secret'|'player_only';
export type FactionRelationState = '隶属'|'同盟'|'友好'|'中立'|'冷淡'|'敌对'|'战争';
export type CombatResult = '大失败'|'失败可撤退'|'险胜'|'完胜'|'大成功'|'碾压胜'|'碾压败';
// 六阶稀有度（r1=凡品 ~ r6=神品）
export type Rarity = 'r1'|'r2'|'r3'|'r4'|'r5'|'r6';

export type ResourceCategory = 'material'|'currency'|'consumable'|'skill'|'cultivation'|'equipment';

export interface GameTime { year:number; season:Season; day:number; timeOfDay:TimeOfDay; }

export interface ResourceTypeDef {
  resource_type_id:string; name:string; category:ResourceCategory;
  rarity:Rarity; base_value:number; stackable:boolean; description:string;
}

export interface ResourceInstance {
  resource_type_id:string; quantity:number; durability?:number; last_updated:GameTime; location_id:string;
}

export interface PersonalityParams {
  formality:number; talkativeness:number; emotional_express:number; speech_style:string; quirks:string[];
}

export interface KnowsOther { character_id:string; description:string; }

export interface PermanentMemory {
  core_identity:string; personality:PersonalityParams; immutable_facts:string[]; knows_others:KnowsOther[];
}

export interface MemoryCard {
  id:string; timestamp:GameTime; title:string; summary:string; tags:string[]; links:string[];
  linked_characters:string[]; importance:number; archived:boolean;
}

export interface CharacterDrive {
  type:DriveType; description:string; priority:number; progress:number; target_entity_id?:string;
}

export interface CharacterRelation { target_id:string; affinity:number; hatred:number; }

export interface FactionBinding { faction_id:string; loyalty:number; contribution:number; k_level:KLevel; }

export interface ScheduleEntry { time:TimeOfDay; location_id:string; action:string; }

export interface LastKnownPosition { character_id:string; location_id:string; timestamp:GameTime; }

export interface ConversationTurn { speaker_id:string; content:string; timestamp:GameTime; }

// NPC 与玩家的对话记忆（保留细节，独立压缩）
export interface PlayerConversationMemory {
  id: string; timestamp: GameTime; summary: string; importance: number;
}

export interface EventSummary {
  id:string; visibility:VisibilityLevel; summary:string; timestamp:GameTime; location_id:string; involved_characters:string[];
}

// 修炼突破阈值配置
export interface CultivationThreshold {
  required_progress:number; required_spirit_stones:number; required_pills:number; require_skill:string;
}

// 通路缓存：存储AI已认证的资源转换通路
export interface PathwayCache {
  id:string;                         // key: <世界名>::<操作类型>::<投入哈希>::<产出哈希>
  world_name:string;
  operation_type:string;             // 如 "炼丹" "突破" "修炼" 等
  inputs:Record<string,number>;      // { resource_id: quantity }
  outputs:Record<string,number>;
  certified_at:string;               // ISO时间戳
  token_cost:number;                 // 认证消耗的token数
  ai_judgement:string;               // AI判定的理由摘要
}

export interface CharacterInstance {
  character_id:string; name:string; is_player:boolean;
  identity:{ faction_id:string; k_level:KLevel; title:string; character_type:string; };
  stats:{ p_level:PLevel; hp:number; max_hp:number; base_combat_power:number; cultivation_progress:number; };
  position:{ location_id:string; previous_location_id:string; };
  inventory:ResourceInstance[];
  permanent_memory:PermanentMemory;
  long_term_memory:{ card_ids:string[]; total_count:number; capacity:number; };
  short_term_buffer:{ conversations:ConversationTurn[]; pending_events:EventSummary[]; };
  drives:CharacterDrive[];
  player_conversation_memory: PlayerConversationMemory[];
  relationships:CharacterRelation[];
  faction_binding:FactionBinding;
  schedule:ScheduleEntry[];
  agent_state:AgentState; agent_alert_reason?:string;
  last_known_positions:LastKnownPosition[];
  memory_mode:'summary'|'detailed';
}

// 敌人定义
export interface EnemyDef {
  enemy_id: string;           // 如 ENM_妖兽
  name: string;               // 如 "妖兽"
  danger_level: '低'|'中'|'高';
  hp: number;
  combat_power: number;
  p_level: PLevel;            // 相当于P几的修为
  description: string;
  loot: { resource_type_id: string; quantity: number }[]; // 击败后掉落
}

// v2: 地点不再有基建设施
export interface LocationDef {
  location_id:string; name:string; danger_level:'低'|'中'|'高'; description:string;
  environment_modifier:number; resources:ResourceInstance[];
  present_characters:string[]; present_enemies:string[];
  access_rule?: { min_k_level?: number; min_p_level?: number; description?: string };
}

// 预设指令：世界卡级预定义的本地CRUD操作（0 token，不走AI）
export interface PresetCommand {
  command_id: string;          // 唯一ID（如 CMD_collect_herb）
  name: string;                // 显示名（如 "采集灵草"）
  command: string;             // 指令（如 /采集灵草）
  description: string;         // 说明
  target_type: 'self' | 'npc' | 'location'; // 目标类型
  condition?: {                // 执行条件（可选）
    min_p_level?: PLevel;
    min_k_level?: KLevel;
    require_item?: string;     // 需要拥有的资源ID
    require_location?: string; // 需要在特定地点
    require_npc?: string;      // 需要特定NPC在场
  };
  inputs?: { resource_type_id: string; quantity: number }[];   // 消耗的资源
  outputs?: { resource_type_id: string; quantity: number }[];  // 产出的资源
  hp_change?: number;          // HP变化
}

export interface FactionDef {
  faction_id:string; name:string; k_level:KLevel; controlled_locations:string[]; core_interests:string[];
  treasury:ResourceInstance[]; diplomatic_states:Record<string,FactionRelationState>; member_requirements:string;
}

export interface SkillDef { skill_id:string; name:string; p_level_requirement:PLevel; combat_bonus:number; description:string; }

export interface Recipe {
  recipe_id:string; name:string; inputs:{resource_type_id:string;quantity:number}[];
  outputs:{resource_type_id:string;quantity:number}[]; prerequisite_skills:string[];
}

export interface InstructionType { type:string; allowed_targets:string[]; max_delta:number; }

export interface AIInstruction { instruction_type:string; target_id:string; delta:number; reason:string; }

export interface WorldBaseline { min_alive_characters:number; min_resource_amounts:Record<string,number>; min_enemy_density:Record<string,number>; }

export interface WorldState {
  game_time:GameTime; flow_count:number; event_stage:string;
  event_stage_start_year:number; event_stage_end_year:number;
  current_year:number; total_time_span:number;
  is_ended:boolean; is_free_exploration:boolean;
  world_flow_step_length_days:number;
  baseline:WorldBaseline;
}

// 世界观映射配置：换世界观时只需改这里，不动 engine 代码
export interface WorldMappingConfig {
  rarity_names: Record<Rarity, { name: string; color: string }>;
  time_flavors: Record<string, Record<string, string>>;
  speech_guides: Record<string, string>;
  p_level_names: string[];
  k_level_names: string[];
  drive_type_names: Record<string, string>;        // maintain→维持, etc.
  agent_state_names: Record<string, string>;       // active→活跃, etc.
  memory_mode_names: Record<string, string>;       // summary→摘要, etc.
  resource_category_names: Record<string, string>; // material→材料, etc.
}

export interface WorldCardConfig {
  world_name:string; world_description:string;
  time_config:{ season_days:Record<Season,number>; world_flow_step_days:number; total_time_span_years:number; };
  world_flow_trigger_count: number; // 每N次玩家交互后自动触发世界流（默认5）
  locations:LocationDef[]; enemies:EnemyDef[]; factions:FactionDef[]; characters:CharacterInstance[];
  resource_types:ResourceTypeDef[];
  recipes?:Recipe[];                // [已废弃] AI 叙事管线接管制造
  exchange_rates?:{from_resource:string;to_resource:string;base_rate:number}[];
  instruction_types:InstructionType[];
  preset_commands?: PresetCommand[]; // [已废弃] AI 叙事管线接管
  combat_config:{ p_level_base_power:Record<PLevel,number>; equipment_bonuses:Record<string,number>; skill_bonuses:Record<string,number>; optional_rules:{ally_assist:boolean;consecutive_penalty:boolean;escape_roll:boolean;fatal_wound:boolean;}; };
  skill_defs:SkillDef[];
  grand_events:any[];
  prompt_config:{ reply_max_length:number; player_gender?:string; event_stage_mood:string; world_rules_summary:string; cultivation_thresholds:Record<string,CultivationThreshold>; };
  mapping: WorldMappingConfig; // 映射层 —— 换世界观的核心
}

export interface CrudLogEntry {
  log_id:string; timestamp:GameTime; operation:string; target_id:string; before:unknown; after:unknown; context:string;
}

// 战斗上下文（AI语C模式，无D20）
export interface CombatContext {
  attacker: { id: string; name: string; power: number };
  defender: { id: string; name: string; power: number };
  result: CombatResult;
  damage: number;
  loot: ResourceInstance[];
  narrative: string;
  consequence: 'attackerWon' | 'defenderWon' | 'defenderFled';
}

export interface WorldFlowRecord {
  flow_id:string; flow_number:number; timestamp:GameTime;
  narrative?: string;
  changeSummary: string[];
  reports: { character_id: string; name?: string; report: string }[];
  steps:{
    step2_narrative?:string; step3_infoDispatch:string[];
    step4_personalActions:string[]; step5_diplomacy:string[]; step5_state:string[];
    step6_cognition:string[]; step7_reactions:string[]; step7_memory:string[];
  };
}

export interface APILogEntry {
  id: string; timestamp: number; gameTime: string;
  flow_number?: number;  // 所属世界流编号，undefined=自由游玩
  type: 'conversation' | 'world_narrative' | 'narrative_outline' | 'narrative_writing' | 'narrative_parsing' | 'report' | 'init_world' | 'diplomacy' | 'state_orchestration' | 'creation_certify' | 'personal_action' | 'memory_compression' | 'player_summary' | 'drive_check' | 'action_parser';
  characterName?: string;
  request: { model: string; systemPrompt: string; userPrompt: string; maxTokens: number; };
  response?: { text: string; tokenUsage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number }; };
  error?: string; durationMs: number;
}

// ── 玩家操作记录 ──
export interface PlayerActionRecord {
  id: string;
  timestamp: GameTime;
  type: 'conversation' | 'command' | 'combat' | 'move' | 'trade' | 'gift' | 'collect' | 'cultivate' | 'other';
  targetName: string;       // NPC名 / 地点名 / 物品名
  summary: string;          // 简要描述（20字以内）
  detail: string;           // 详细描述
  flowNumber?: number;      // 所属世界流
  processed: boolean;       // 是否已被世界流总结
}

// ── AI 生成的系统变更 JSON（后置CRUD：叙事完成后由AI从叙事中提取）──
export interface WorldChangeSet {
  // 资源变化：{ 角色ID或地点ID: { 资源类型ID: 变化量（正=获得，负=消耗） } }
  resource_changes: Record<string, Record<string, number>>;
  // 关系变化：{ 角色A_ID: { 角色B_ID: 好感度变化量（正=增加，负=减少） } }
  relation_changes: Record<string, Record<string, number>>;
  // 位置变化：{ 角色ID: 新地点ID }
  position_changes: Record<string, string>;
  // HP变化：{ 角色ID: HP变化量 }
  hp_changes: Record<string, number>;
  // 状态变化：{ 角色ID: 新状态（active | dormant | alert） }
  state_changes: Record<string, string>;
  // 修为变化：{ 角色ID: +1（突破）或 -1（退步），变化量只能是±1 }
  p_level_changes: Record<string, number>;
  // 身份变化：{ 角色ID: +1（晋升）或 -1（降级），变化量只能是±1 }
  k_level_changes: Record<string, number>;
  // 物品交换日志（用于展示）：[{ from:角色ID, to:角色ID, resource:资源ID, quantity:数量 }]
  item_transfers: { from: string; to: string; resource: string; quantity: number }[];
  // 角色交互记忆：叙事中与哪些NPC发生了互动 [{ npc_id, summary, importance }]
  interaction_memories: { npc_id: string; summary: string; importance: number }[];
  // 叙事摘要（供世界流同步用）
  narrative_summary: string;
}

// 认知同步条目
export interface CognitionEntry {
  target_character_id:string; location_id:string; description:string;
  source_id:string; source_type:'direct_interaction'|'diplomacy_ai'|'state_ai'|'gossip';
}

// ═══════════════════ 存档系统 ═══════════════════

export interface SaveSlotMeta {
  slot_id: number;       // 1-20
  name: string;          // 自定义名称
  saved_at: number;      // Date.now()
  game_time: string;     // 当前游戏时间字符串
  flow_count: number;    // 世界流计数
}

export interface SaveSnapshot {
  worldState: WorldState;
  characters: CharacterInstance[];
  locations: LocationDef[];
  factions: FactionDef[];
  memoryCards: MemoryCard[];
  worldstream: WorldFlowRecord[];
  apiLogs: APILogEntry[];
  pathwayCaches: PathwayCache[];
  journals: CrudLogEntry[];
}
