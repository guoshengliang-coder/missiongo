# MissionGo

> From idea to shipped.

MissionGo 是一款面向独立开发者的个人自托管工作中枢。它可以从 Web、Android 和 macOS 开发版本中收集灵感、需求、Bug、任务和备注，并让编程 AI 通过 MCP 按条目编号读取和处理工作。AI 会把结构化分析、代码修改依据和测试结果写回条目，最终由人工完成验收。

## 当前进度

项目的核心服务端基础已经可以运行。目前仓库包含：

- 工作条目核心状态机；
- 类型化 MCP 契约和可工作的 Streamable HTTP MCP 端点；
- 领域模型与安全边界；
- 初版 REST API 契约；
- 基于 SQLite 的 Fastify 服务端；
- Product、Component、Work Item 和 Timeline 持久化；
- 图片、视频和日志的本地附件存储；
- 支持快速记录、筛选、编辑、状态流转和时间线查看的响应式 Web 管理端；
- 手动填写设备、系统、产品版本、构建版本和代码版本信息；
- 简体中文与英文界面，首次使用默认显示中文；
- 用于列出、打开和创建条目的浏览器原生 WebMCP 能力；
- 覆盖持久化、输入校验、鉴权和高风险状态流转规则的测试；
- 只做分析的 MissionGo Skill，以及 Codex、Claude Code 和其他 MCP 客户端的本地接入说明。

Android App 和反馈 SDK 尚未实现。REST 数据契约已经预留客户端 SDK 自动采集字段，但尚未完成实际 SDK。MCP 的任务领取、代码处理执行和自动调度仍属于后续工作；当前 MCP 支持读取、附件查看和分析回写。

## 已确认的 MVP 范围

- 单用户、自托管。
- 支持多个产品、组件、功能区域和代码仓库。
- 响应式 Web 管理端，加 Android 原生外壳。
- Android 反馈 SDK 和 Swift macOS 反馈包。
- 通过远程 MCP 服务和可复用 Skill 按需调用 AI。
- SQLite 元数据存储和本地附件目录。
- AI 可以创建隔离的本地修改和提交，但默认不 push、不 merge。
- AI 最多把条目推进到 `pending_verification`，由人工验收后移至 `done`。

## 本地运行

需要 Node.js 22.13 或更高版本，建议使用 Node.js 24 LTS 或更新版本。

```bash
npm install
npm test
npm run typecheck
npm run build
npm run dev:server
npm run dev:web
```

API 默认运行在 `127.0.0.1:8787`，Web 管理端默认运行在 `127.0.0.1:5173`，本地数据默认存放在 `./data/missiongo.sqlite`。请在两个终端中分别运行服务端和 Web 开发命令。复制 `.env.example` 为 `.env` 后，可以覆盖本地配置。服务端绑定到非本机回环地址时，必须配置 `ADMIN_API_TOKEN`。

设置独立的 `MCP_API_TOKEN` 后才会启用 `/mcp` 端点。Codex、Claude Code 和通用 MCP 客户端的配置方式见 [AI 客户端接入说明](docs/ai-client-setup.md)。

构建公开站点时，可以把 `MISSIONGO_PUBLIC_ORIGIN` 设置为规范的 HTTP(S) 地址，例如 `https://missiongo.example.com`，以便生成绝对地址形式的 Open Graph 和 X 图片元数据。不要在仓库中提交真实部署地址。

## 安全说明

请复制 `.env.example` 到本地 `.env`，不要提交真实部署地址或任何密钥。详细规则见 [安全边界](docs/security-boundaries.md)。

## 开源许可证

MissionGo 使用 [Apache License 2.0](LICENSE)。

## 规划文档

- [产品需求与技术方案](docs/product-and-technical-plan.md)
- [Phase 0 决策](docs/phase-0-decisions.md)
- [领域模型](docs/domain-model.md)
- [MCP 契约](docs/mcp-contract.md)
- [AI 客户端接入说明](docs/ai-client-setup.md)
- [REST API 草案](docs/openapi.yaml)
