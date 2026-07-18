# 青云界 — 全 AI 驱动修真世界模拟器

v3 架构，DeepSeek API + OPFS 持久化 + Capacitor Android 打包。摒弃传统游戏引擎，由 AI 驱动叙事生成和系统变更。

## 功能

- **AI 即游戏引擎** — 叙事生成、系统变更决策全部交给 AI，代码仅负责持久化、校验和状态协调
- **自治 Agent 系统** — 地图 Agent 与势力 Agent 自主决策，为世界注入多样性和涌现叙事
- **全平台运行** — Web 端（Vite） + Android 端（Capacitor）
- **OPFS 持久化** — 浏览器端文件系统存储，无需后端服务

## 技术栈

| 层 | 技术 |
|---|---|
| 构建 | Vite 8 |
| 语言 | TypeScript |
| 移动端 | Capacitor 8 (Android) |
| AI | DeepSeek API |
| 存储 | OPFS (浏览器文件系统) |

## 快速开始

```bash
npm install
npm run dev
```

## 项目结构

```
data/        世界观数据层（配置驱动）
transform/   AI 转化层（prompt 拼装）
engine/      引擎层（世界观无关的纯逻辑）
ui/          前端展示层
```

## 许可证

MIT
