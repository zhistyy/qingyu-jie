# 地图 Agent + 势力 Agent 设计计划

> 替代已移除的大事件系统，以自治 Agent 的方式为世界注入多样性、方向感和涌现叙事。

---

## 设计目标

事件系统是"剧本"——固定触发条件、固定解锁内容。Agent 是"即兴"——每个地点和势力根据当前世界状态自主决策，每局游戏走向不同。

核心诉求：
- **给玩家方向感** — 势力冲突波及你的宗门/朋友 → 自然产生行动动机
- **增加世界多样性** — 每个地点和势力独立决策 → 不重复的世界走向
- **零数据污染** — Agent 只产出 prompt 素材和叙事级决策，变更仍走 changeApplier 校验
- **容错降级** — Agent 失败不影响游戏运行（降级为空输出）

---

## 方案一：势力 Agent（Phase 1，优先实现）

### 定位

每个势力一个自治 Agent，在世界流期间决策该势力在本轮中的宏观行为。

### 触发时机

世界流 Step 5a（外交编排）之前，与外交 AI 串联。

### 输入（每个势力 1 次 API 调用）

```
势力状态快照：
  - 名称、层级、核心利益
  - 成员列表（各 NPC 当前所在位置、目的、修为）
  - 金库资源（灵石/灵晶/暗灵石等）
  - 当前外交关系（与各势力的 relation state）
  - 势力内部关系（成员间好感度矩阵）

世界背景：
  - 当前世界时间、阶段（太平时期/自由探索期）
  - 玩家状态（修为、位置、关系网）
  - 同势力各 NPC 的个人行动方案（来自 Step 4 输出）
```

### 输出

```typescript
{
  // 势力级宏观行动（选一）
  action: 'expand' | 'defend' | 'trade' | 'negotiate' | 'attack' | 'idle';
  action_target?: string;  // 目标势力ID或地点ID

  // 内部调度
  assignments: [
    { npc_id: string; task: string; location_id: string }
  ];

  // 外交姿态变化建议
  diplomatic_shifts: [
    { target_faction_id: string; direction: 'warmer' | 'colder'; reason: string }
  ];

  // 叙事摘要（50字以内，供世界叙事 AI 引用）
  narrative_summary: string;
}
```

### 数据流

```
势力 Agent 输出
    │
    ├─→ 外交编排 (Step 5a) — diplomatic_shifts 作为外交 AI 的输入提示
    │       ↓
    │   NPC 间实际互动编排
    │
    ├─→ 状态编排 (Step 5b) — assignments 影响 NPC 位置/状态变化
    │       ↓
    │   CRUD 执行
    │
    └─→ 世界叙事 (Step 2，下一轮) — narrative_summary 注入 worldAI prompt
            ↓
        玩家在叙事中感知到"青云宗正在集结力量""万宝商会收缩了贸易路线"
```

### 对玩家的影响示例

| 势力 Agent 决策 | 玩家感知 |
|----------------|---------|
| 幽冥教 → attack 青云宗 | 白鹤真人召见你，神情凝重 |
| 万宝商会 → trade 青云宗 | 坊市出现稀有丹药，云霓裳派人找你 |
| 散修 → idle | 无影响 |

### 实现要点

1. **新建文件** `transform/factionAgentAI.ts`
2. **worldFlow.ts Step 5a 前** 插入势力 Agent 调用（并发执行）
3. **prompt 构建**：每个势力 1 次 API，输入约 2000 token，输出约 400 token
4. **校验层**：diplomatic_shifts 需经过合法转换路径检查（复用 relations.ts 中已有逻辑）
5. **最多势力数**：5 个基础势力 = 5 次并发 API 调用，约 2000 token

---

## 方案二：地图 Agent（Phase 2）

### 定位

每个地点一个轻量 Agent，决策该地点的局部环境变化。

### 输入（每个地点 1 次 API 调用）

```
地点状态快照：
  - 名称、描述、危险度、环境修正
  - 当前 NPC 列表（含各自行动方案）
  - 当前敌人类型和数量
  - 资源存量（灵石/灵草/矿石等）

世界背景：
  - 当前时间、季节
  - 该地点所属势力的 Agent 决策（如果有）
```

### 输出

```typescript
{
  // 环境变化
  environment_changes: [
    { type: 'resource_regen' | 'resource_deplete' | 'enemy_spawn' | 'enemy_clear'; detail: string }
  ];

  // 地点级叙事（50字以内）
  narrative: string;

  // NPC 偶遇事件
  encounters: [
    { npc_a: string; npc_b: string; description: string }
  ];
}
```

### 数据流

```
地图 Agent 输出
    │
    ├─→ 信息派发 (Step 3) — narrative 注入 NPC pending_events
    │
    └─→ 世界叙事 (Step 2) — 地点变化作为 story 素材
```

---

## 方案三：Agent 间交叉引用（Phase 3）

### 目标

让势力 Agent 感知地图 Agent 的决策，形成联动。

### 例如

- 地图 Agent："灵石矿脉深处传来崩塌声" → 势力 Agent（外门）：assign 铁牛 去调查矿脉
- 地图 Agent："幽冥沼泽瘴气扩散" → 势力 Agent（幽冥教）：expand 趁机扩张

### 实现方式

Phase 1 势力 Agent 的输入中包含所在地点的地图 Agent 输出；Phase 2 引入后，两者顺序调用（先地图 Agent，后势力 Agent）。

---

## 实现优先级

| 阶段 | 内容 | 新增文件 | API 增加 | 预计复杂度 |
|------|------|---------|---------|-----------|
| Phase 1 | 势力 Agent | `transform/factionAgentAI.ts` | 5 次/世界流 | 中 |
| Phase 2 | 地图 Agent | `transform/locationAgentAI.ts` | ~23 次/世界流 | 高（需控制 API 消耗） |
| Phase 3 | Agent 交叉引用 | 调整调用顺序 | 不变 | 低 |

---

## 注意事项

1. **API 消耗**：Phase 2 地图 Agent 有 23 个地点，全量调用消耗巨大。建议只对"有玩家去过"或"有势力关注的"地点触发
2. **降级策略**：任何 Agent 调用失败 → 返回空输出，不影响世界流继续执行
3. **类型安全**：Agent 输出需要定义严格的 TypeScript 接口 + parse 校验（参考 narrativeAI.ts 的 `parseChangeSet` 模式）
4. **与现有系统的关系**：Agent 不替代现有的个人行动 AI（Step 4）和外交 AI（Step 5），而是作为追加输入丰富它们
