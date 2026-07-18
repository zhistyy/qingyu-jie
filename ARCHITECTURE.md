# 青云界 · 架构索引

> v3 全 AI 驱动修真世界模拟器。DeepSeek API + OPFS 持久化 + Capacitor Android 打包。

---

## 设计理念

### 核心思想：AI 即游戏引擎

青云界摒弃了传统游戏开发中"用代码枚举所有玩法分支"的思路，将 **叙事生成** 和 **系统变更决策** 全部交给 AI，代码层仅负责：
- **数据持久化**（OPFS 文件系统）
- **安全校验**（白名单、范围限制、ID 校验）
- **确定性逻辑**（时间推进、战力计算、事件条件检查）
- **状态协调**（认知同步、记忆压缩、基线修复）

### 分层架构原则

```
┌─────────────────────────────────────────┐
│  data/  世界观数据层（配置驱动、可换皮）    │
├─────────────────────────────────────────┤
│  transform/  AI 转化层（prompt 拼装）      │
├─────────────────────────────────────────┤
│  engine/  引擎层（世界观无关的纯逻辑）      │
├─────────────────────────────────────────┤
│  ui/     前端展示层                       │
└─────────────────────────────────────────┘
```

- **引擎层不依赖具体世界观** — 所有世界设定由 `data/` 注入
- **AI 层不直接操作数据** — 只产出 prompt 和解析 JSON，变更由 engine 层的 `changeApplier` 安全执行
- **前端层不接触业务逻辑** — 仅负责展示和路由，所有逻辑在 engine/transform 层

### 安全设计：三层防线

```
AI 生成 WorldChangeSet JSON
        │
        ▼
Layer 1: parseChangeSet —— JSON 格式校验、类型规范化
        │
        ▼
Layer 2: validateXxx —— 值域裁剪 (好感±30, HP±50, 资源±100, P±1, K±1)
        │
        ▼
Layer 3: applyWorldChanges —— 白名单校验 (角色ID/地点ID/资源ID 必须在目录中存在)
```

任何一层校验失败，该条目被静默跳过，不会污染数据。

---

## 交互管线（主循环）

```
玩家输入自然语言
  │
  ├─ /状态 /背包 /地图 /存档 → handleCommand (纯查询，0 token)
  │
  └─ 自然语言 → 三阶段叙事 AI (循环每轮 3 次 API)
       ├─ Stage 1: 提纲 AI → 结构化叙事提纲（6-8 情节点）
       ├─ Stage 2: 写作 AI → 承接上文 + 严格遵循提纲 → 小说正文
       └─ Stage 3: 解析 AI → 从正文提取 JSON → WorldChangeSet

交互计数 ≥ N（默认 5）→ 触发世界流 (8 步管线)

注：移动/战斗/修炼/采集/交易/制造等所有变革操作均由 AI 叙事管线统一处理，
    不再有独立指令或按钮。
```

### 三阶段叙事详解

| 阶段 | 系统 Prompt 核心约束 | Token 预算 |
|------|---------------------|-----------|
| **Stage 1 提纲** | 一个提纲只覆盖一个场景；从上一段结尾开始推进；禁止编造目录外内容；6-8 情节点 | 1200 |
| **Stage 2 写作** | 第三人称；严格承接上文；主语多变（主角名不超过 40%）；对话穿插动作；禁止悬念钩子；至少 300 字 | 3000 |
| **Stage 3 解析** | 只提取叙事中明确发生的变更；资源 ID 必须来自目录；修炼突破需检查阈值；位置移动必须追踪 | 1200 |

### 写作 AI 的铁律约束

叙事 AI 有严格的写作规则，确保输出质量可控：
1. 第三人称，只用主角配置名
2. 严格承接上一段的结尾句——不能跳跃场景
3. 主语多变——同一段落内主角名开头的句子不超过 40%
4. 结尾自然收束——禁止人影/异响/悬念钩子（除非玩家在主动调查）
5. 禁止扫镜式收尾（转身离去/身影渐远/走向XX）
6. 采集/修炼/炼丹等操作须描写具体过程
7. 长短句交替，长句不超过 40 字

这些约束通过在 Stage 2 的 system prompt 和 user prompt 中精确表达来实现。

---

## 目录与文件职责

### `engine/` — 引擎层（世界观无关的纯逻辑）

| 文件 | 职责 |
|------|------|
| `types.ts` | **核心类型定义** — CharacterInstance, WorldState, WorldCardConfig, GrandEvent, ResourceInstance, WorldChangeSet, APILogEntry, SaveSnapshot 等 |
| `config.ts` | **共享常量** — API 配置, 20+ 资源 ID 常量, 世界流触发阈值, localStorage 键, 通用工具函数 |
| `db.ts` | **OPFS 持久化** — 10 个 JSON 文件存储 + 批量写入 + 写队列防冲突 + 20 槽位存档系统 |
| `crud.ts` | **四大原子操作** — addResource / setRelation / moveEntity / setAgentState（含状态转换合法性检查） |
| `changeApplier.ts` | **AI 变更应用器** — 接收 WorldChangeSet，三层防线校验后安全应用 + 资源池同步 |
| `agent.ts` | **AI 调用基础设施** — callDeepSeek 统一入口（含超时控制）+ API 日志 + 指令管线验证 |
| `pool.ts` | **资源池** — 系统级资源缓冲层，单端操作（获得从池扣，失去上交池），允许透支 |
| `microLoop.ts` | **微观回合** — NPC 对话 [给予]/[交换] 标签处理 + AI 语 C 战斗 |
| `worldFlow.ts` | **世界流主循环** — 8 步管线，详见下方 |
| `combat.ts` | **NPC 间战斗结算** — 战力计算 / 段位压制 / 队友助战 / D20 / 撤退 / 致命伤 |
| `time.ts` | **时间系统** — GameTime 推进 (4 时辰 × 4 季节)，世界流跨日步进 |
| `memory.ts` | **记忆系统** — 短期缓冲 → AI 压缩 → 长期卡片 + 合并去重 + 玩家对话独立记忆 |
| `drive.ts` | **目的系统** — 8 种驱动类型 + 纯逻辑进度推进 + AI 目的消解 + maintain 保底 |
| `relations.ts` | **关系/外交** — 好感度 (±100) + 仇恨值 + 势力关系自动化 + 认知同步 |
| `resources.ts` | **资源逻辑** — produce/consume/process/exchange + K 层级管辖（稀有度 → 最小K级） |
| `worldResource.ts` | **世界资源** — 采集 / 招募 / 敌人清除 + 世界线更正（人口/资源/敌人密度基线修复） |
| `stateMachine.ts` | **游戏状态机** — idle/dialog/combat/world_flow 四状态 + 转换校验 + 指令白名单 |
| `playerLog.ts` | **玩家操作日志** — 世界流间操作记录，持久化到 OPFS，供 AI 总结 |
| `destiny.ts` | **命石结算** — 世界结束时计算成就奖励 + 命石商店 |
| `init.ts` | **世界初始化** — 首次世界流（isInitialFlow），跳过部分步骤 |
| `creation.ts` | **创造系统** — 资源产出/消耗的本地逻辑校验 + 通路缓存键生成 |
| `commands/index.ts` | **命令路由** — 仅 4 个信息查询：/状态 /背包 /地图 /存档 |

### `transform/` — AI 转化层

| 文件 | 职责 | API 次数 |
|------|------|---------|
| `narrativeAI.ts` | **三阶段叙事** — Stage 1 提纲 + Stage 2 写作 + Stage 3 变更提取，含多层校验函数 | 3 |
| `prompt.ts` | **NPC 对话 prompt 构建** — 分层拼接：Layer1 静态缓存 + Layer2 时间地点 + Layer3 角色锚点(身份/性格/目的/人脉) + Layer4 状态(HP/记忆/物品) + Layer5 对话指令([给予]/[交换]) + 资源指引 | — |
| `combatAI.ts` | **语 C 战斗 AI** — 自由文本描述战斗 → AI 判定伤害 + 叙事 | 1 |
| `personalActionAI.ts` | **NPC 个人行动 AI** — 世界流 Step 4，每个活跃 NPC 并发调用 AI 决定行动 | N (并发) |
| `diplomacyAI.ts` | **外交编排 AI** — 世界流 Step 5a，接收行动方案 + 互动意图，编排 NPC 互动 | 1 |
| `stateAI.ts` | **状态编排 AI** — 世界流 Step 5b，接收外交结果，决定资源/状态/关系变化 | 1 |
| `playerSummaryAI.ts` | **玩家行动摘要 AI** — 世界流 Step 1.5，汇总玩家在两次世界流间的操作 | 1 |
| `creationCertify.ts` | **创建认证 AI** — 验证资源创建请求是否合理 | 1 |

### `data/` — 世界观数据层

| 文件 | 职责 |
|------|------|
| `xianxia.ts` | **青云界配置总入口** — 组装 WorldCardConfig + initialWorldState |
| `world/config.ts` | 时间/季节/修为阈值(0→1 至 3→4)/映射/战力指数级标度(5→2000) |
| `world/characters.ts` | 玩家 + 13 个 NPC 定义（青云宗 8 人 + 野外/飞仙城/幽冥教 5 人 + 3 个扩展角色） |
| `world/locations.ts` | 23 个地点定义（含 6 个扩展地点：清风镇/白云洞/黑风寨/古剑冢/坠星湖/断魂崖） |
| `world/factions.ts` | 5 个基础势力（外门/内门/万宝商会/散修/幽冥教）+ 1 扩展势力（天机阁）+ 12 种敌人 |
| `world/resources.ts` | 6 大类 48 种资源类型（基础 35 种 + 6 种扩展） |
| `world/commands.ts` | AI 指令白名单（4 条）+ 技能定义（8 种） |
| `world/factions.ts` | 5 个基础势力（外门/内门/万宝商会/散修/幽冥教）+ 1 扩展势力（天机阁）+ 12 种敌人 |

### `ui/` — 前端页面

| 文件 | 职责 |
|------|------|
| `setup.html` + `setup.js` | **设置页面** — API Key 配置 / 角色创建 (姓名/称号/势力/K级/P级/性格) / 存档管理(20槽) / 世界元素编辑(地点/角色/敌人/势力/资源) / 命石商店 / NPC冲突检测 |
| `game.html` + `game.js` | **主游戏页面** — 叙事交互管线 / 世界初始化 / 世界流触发 / 8面板系统(自身/地图/角色/势力/世界线/背包/API日志/系统变更日志) / 手动存档 / 世界结算 |
| `chat.html` + `chat.js` | **NPC 对话页面** — 聊天软件风格 / 全地图 NPC 列表 / 一对一对话 / [给予]/[交换] 标签 |
| `api-log.html` + `api-log.js` | **API 日志查看器** — 按世界流分组 / Token 统计 / 调用详情 / 类型筛选 / 批量删除 |
| `style.css` | **全局样式** — 修真主题配色 / 响应式 / PC端 800px 最大宽度 |
| `state.js` | **跨页面状态管理** — OPFS 持久化 app_state / 时间格式化 / rarity 映射 / $ 选择器 |
| `panels.js` | **面板渲染** — 自身/地图/角色/势力/世界线/背包 6 面板 + AI 建议交互 |
| `narrative-manager.js` | **叙事历史管理** — 展示（含世界流标记）/ localStorage 持久化 / 建议交互入口 |
| `combat-hud.js` | **战斗 HUD** — HP 条 / 战力显示 / 攻击/撤退 按钮 |
| `changeLog.js` | **系统变更日志** — 每次叙事/世界流的资源/关系/HP/移动变更记录(localStorage) |

---

## 核心数据流

```
[玩家输入] → game.js
               │
               ├─ /指令 → commands/index.ts → CRUD → OPFS
               │
               └─ 自然语言 → transform/narrativeAI.ts
                                ├─ Stage 1: 提纲
                                ├─ Stage 2: 写作
                                └─ Stage 3: WorldChangeSet JSON
                                     │
                                     ▼
                              engine/changeApplier.ts
                                (三层校验：JSON格式 → 值域裁剪 → 白名单)
                                     │
                                     ▼
                              engine/crud.ts → engine/db.ts → OPFS
                                (同时同步 资源池 pool.json)
```

### 世界流数据流（8 步管线）

```
Step 1:  玩家行动总结（1 次 API）
         汇总两次世界流间的玩家操作 → AI 叙事化摘要

Step 2:  世界 AI 叙事（1 次 API，4000 token）
         输入：角色摘要 / 目的进度 / 上次叙事 / 玩家摘要
         输出：宏观世界叙事（2000+ 字）

Step 3:  信息派发（0 token）
         世界叙事 → NPC 短期缓冲 pending_events
         同地点 NPC / 与玩家互动过的 NPC 收到个性化消息

Step 4:  个人行动 AI（N 次 API，并发）

Step 5a: 外交编排 AI（1 次 API）
Step 5b: 状态编排 AI（1 次 API）

Step 6:  认知同步（0 token）
         ├─ 外交/状态事件 → NPC pending_events
         ├─ 势力关系变化广播
         └─ 同地点 NPC 互更新 last_known_positions + knows_others

Step 7:  收尾 + NPC 同步
         ├─ 个人行动 CRUD 执行
         ├─ 玩家对话记忆压缩
         ├─ NPC 记忆压缩
         ├─ 目的进度推进 + 消解
         ├─ 世界线更正（人口/资源/敌人基线）
         ├─ 时间推进
         ├─ NPC 状态同步
         └─ 批量刷写 OPFS
```

---

## WorldChangeSet（AI 输出的系统变更 JSON）

```typescript
{
  resource_changes:  { "角色/地点ID": { "资源ID": 变化量(±100) } },
  relation_changes:  { "角色A": { "角色B": 好感变化(±30) } },
  position_changes:  { "角色ID": "新地点ID" },
  hp_changes:        { "角色ID": HP变化(±50) },
  state_changes:     { "角色ID": "active|dormant|alert" },
  p_level_changes:   { "角色ID": ±1 },              // 修为突破/退步
  k_level_changes:   { "角色ID": ±1 },              // 身份晋升/降级
  item_transfers:    [{ from, to, resource, quantity }],
  interaction_memories: [{ npc_id, summary, importance }],
  narrative_summary: "50字内摘要"
}
```

所有变更经过三层防线：
1. **JSON 格式校验** — parseChangeSet，去除 markdown 包裹，提取 JSON 对象
2. **值域裁剪** — 资源 ±100, 好感 ±30, HP ±50, P±1, K±1
3. **白名单校验** — 角色/地点/资源 ID 必须在目录中存在

---

## 关键配置点

| 配置项 | 位置 | 默认值 |
|--------|------|--------|
| 世界流触发交互数 | `data/xianxia.ts` → `world_flow_trigger_count` | 5 |
| 世界流步进天数 | `data/world/config.ts` → `timeConfig.world_flow_step_days` | 5 |
| 总时间跨度 | `data/world/config.ts` → `timeConfig.total_time_span_years` | 300 年 |
| 存档槽位 | `engine/config.ts` → `TOTAL_SAVE_SLOTS` | 20 |
| API 日志上限 | `engine/config.ts` → `API_LOG_MAX` | 2000 |
| 单次赠与上限 | `engine/config.ts` → `SINGLE_GIVE_MAX` | 50 |
| 单次交易上限 | `engine/config.ts` → `SINGLE_TRADE_MAX` | 50 |
| 玩家对话记忆上限 | `engine/config.ts` → `PLAYER_CONV_MEMORY_MAX` | 20 |
| 玩家操作日志上限 | `engine/config.ts` → `PLAYER_LOG_MAX` | 100 |
| API 超时 | `engine/config.ts` → `API_TIMEOUT_MS` | 60,000ms |
| 写作 AI 外层超时 | `transform/narrativeAI.ts` | 90,000ms |

### 修炼突破阈值

| 突破 | 所需进度 | 所需灵石 | 所需丹药 | 前置技能 |
|------|---------|---------|---------|---------|
| 凡人 → 练气期 | 20 | 10 | 1 | RES_基础功法 |
| 练气期 → 筑基期 | 60 | 40 | 5 | RES_基础功法 |
| 筑基期 → 金丹期 | 200 | 200 | 20 | RES_基础功法 |
| 金丹期 → 元婴期 | 1000 | 1000 | 60 | RES_基础功法 |

### 战力标度（指数级）

```
P0 凡人:     5
P1 练气期:   25
P2 筑基期:   120
P3 金丹期:   500
P4 元婴期:   2000
```

装备/技能加成叠加到基础战力上，环境修正 (±) 再叠加，段位压制按倍数修正。

---

## 持久化策略

### OPFS 文件结构

```
to-rpg/
  ├─ worldState.json      — 世界状态（时间、流计数、基线）
  ├─ characters.json      — 所有角色（Key-Value Map）
  ├─ locations.json       — 所有地点
  ├─ factions.json        — 所有势力
  ├─ events.json          — 所有大事件
  ├─ memoryCards.json     — 所有记忆卡片
  ├─ worldstream.json     — 所有世界流记录
  ├─ apiLogs.json         — API 调用日志
  ├─ pathwayCache.json    — 创造通路缓存
  ├─ journals.json        — CRUD 操作日志（数组格式）
  ├─ pool.json            — 资源池状态
  ├─ playerLogs.json      — 玩家操作日志
  ├─ destinyStones.json   — 命石存储
  ├─ app_state.json       — 跨页面应用状态
  └─ saves/
      ├─ meta.json        — 20 槽位元信息
      └─ slot_N.json      — 各槽位快照
```

### 写入机制

- **批量写入**：`beginBatch()` / `endBatch()` — 世界流执行期间缓存所有 dirty store，结束时一次性刷写
- **写队列**：`enqueueWrite()` — 防止多页面并发写入导致 NotReadableError
- **先写临时文件**：写 `.tmp` → 校验 JSON 可解析 → 原子替换正式文件 → 删除临时文件
- **重试机制**：最多重试 3 次，指数退避 (100ms / 200ms / 400ms)
- **内存缓存**：每个 store 加载一次后缓存在内存中，通过 `loaded` 标记

### 资源池

系统级资源流转不要求双端守恒。角色获得资源 → 从池扣除；角色失去 → 上交池子。池子允许透支（余额为负），由世界线更正机制补充。NPC 间直接交互（[给予]/[交换]）走双端 CRUD 校验，不走池子。

---

## 游戏状态机

```
┌──────────────────────────────────────────────────────┐
│                      idle                             │
│              允许: /状态 /背包 /地图 /存档              │
│         可转: dialog, combat, world_flow              │
├──────────────────────────────────────────────────────┤
│                     dialog                            │
│             允许: /状态 /背包 /地图                     │
│              可转: idle, combat                        │
├──────────────────────────────────────────────────────┤
│                     combat                            │
│                 允许: /状态                             │
│                  可转: idle                             │
├──────────────────────────────────────────────────────┤
│                  world_flow                           │
│             允许: 无（全部阻塞）                         │
│                  可转: idle                             │
└──────────────────────────────────────────────────────┘
```

自由文本输入在 idle / dialog / combat 状态下均允许，world_flow 期间全部阻塞。

---

## 战斗系统

### NPC 间战斗（combat.ts，纯逻辑，0 token）

```
战力计算 = P级基础战力 + 装备加成 + 技能加成 + 环境修正 - 连续战斗惩罚
         × 段位压制倍率（跨1段×0.5, 跨2段×0.2, 跨3段×0）
         + 队友助战（好感>30的队友提供半数战力）
```

战斗结果按战力差区间判定：

| 战力差 | 结果 | 伤害(%maxHP) |
|--------|------|-------------|
| > 300 | 碾压胜 | 60% |
| > 100 | 完胜 | 35% |
| > 30 | 险胜 | 20% |
| -30~30 | 随机（50%胜率） | 10% |
| -30~-80 | 失败可撤退 | 10% |
| -80~-200 | 大失败 | 20% |
| < -200 | 碾压败 | 35% |

撤退机制：失败可撤退时 60% 概率成功撤退到随机其他地点。

### 语 C 战斗（combatAI.ts，1 次 API）

玩家输入自由文本描述战斗动作 → AI 判定伤害 + 生成叙事文本，适用于 player vs NPC 的战斗场景。

---

## 记忆系统

### 三层结构

```
短期缓冲 (short_term_buffer)
  ├─ conversations[]     — 最近几轮对话
  └─ pending_events[]    — 世界流派发的消息
        │
        ▼ (世界流 Step 7: AI 压缩)
长期卡片 (memoryCards.json)
  ├─ 每个 NPC 独立存储
  ├─ 上限 50 张（超限时：弱链接合并 → 归档低重要性）
  └─ 检索时按 标签匹配 + 链接匹配 + 时效衰减 排序
        │
        ▼ (独立于通用记忆)
玩家对话记忆 (player_conversation_memory)
  ├─ 保留细节（可达 150 字）
  ├─ 上限 20 条
  └─ 用于 NPC 对话时拼接 prompt，使 NPC "记住"与玩家的互动
```

---

## 关系系统

- **好感度**：±100，双向不对称（A对B +10 → B对A +7）
- **仇恨值**：好感降低时累积，仇恨 ≥60 即视为仇敌
- **关系状态**：至交(≥50) / 友好(>0) / 中立(=0) / 敌对(<0) / 死敌(≤-50) / 仇敌(hatred≥60)
- **势力关系**：隶属/同盟/友好/中立/冷淡/敌对/战争 — 含合法转换路径，8% 概率随机漂移
- **认知同步**：同地点 NPC 互更新 last_known_positions 和 knows_others 描述

---

## 命石系统（跨世界 Meta-currency）

### 世界结算
世界结束时根据以下维度计算奖励：
- 基础完成 +1
- P 层级 ×5
- K 层级 ×3
- 触发大事件数 ×1
- 修炼进度 ×10（向下取整）
- 总好感 ÷100
- 世界流次数 ÷10

### 命石商店（7 件商品）
| 商品 | 消耗 | 效果 |
|------|------|------|
| 生命强化 | 2 | HP+10, max_hp+10 |
| 战力强化 | 3 | 战力+5 |
| 天生灵根 | 8 | 初始P1 |
| 灵石积蓄 | 3 | 初始灵石×50 |
| 铁剑 | 2 | 初始携带铁剑 |
| 疗伤丹 | 1 | 初始疗伤丹×3 |
| 基础剑法 | 5 | 初始掌握基础剑法 |

---

## 构建与部署

```bash
npm run dev      # Vite 开发服务器 → http://localhost:5173/ui/setup.html
npm run build    # 生产构建 → dist/
# Android: 使用 Capacitor 打包 (skill: qyj-apk-build)
```

### Vite 多入口配置

5 个 HTML 入口页面：`setup.html` → `game.html` (+ `chat.html`, `api-log.html`)。根 `index.html` 自动重定向到 `ui/setup.html`。

### Capacitor Android 配置

- 包名：`com.qyj.app`
- 应用名：`青云界`
- Web 目录：`dist/`
- 签名：`qyj-release.keystore`

---

## 附录：技术债务 / 已知局限性

1. **API 依赖**：全部叙事和系统变更依赖 DeepSeek API，网络不可用时游戏无法推进
2. **Token 消耗**：一次玩家行动消耗 3 次 API（提纲+写作+解析），约 5000+ token；一次世界流（5 个 NPC）约 12 次 API
3. **OPFS 限制**：数据存储在浏览器 Origin Private File System，清除浏览器数据会丢失存档
4. **无测试覆盖**：当前无自动化测试，回归验证依赖手动操作
5. **内存占用**：所有数据缓存在内存中，超大规模世界可能 OOM
6. **Android init.html**：Android 构建产物中残留不存在的 `init.html`，重新打包前需清理 build 目录
