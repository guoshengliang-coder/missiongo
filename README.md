# MissionGo

> From idea to shipped.

MissionGo 是面向个人开发者的开源、自托管工作记录中心。它把灵感、需求、Bug、任务和备注集中到同一套结构化记录中，并让 Web、Android 和只读 AI 客户端共享完整上下文。

项目目前适合单管理员自行部署和内部试用。它不是面向公众开放注册的 SaaS，也不会把工作内容交给第三方服务。

## 已实现能力

- 响应式 Web/H5 管理端，支持桌面、平板和手机，并跟随系统的浅色/深色外观；
- 灵感、需求、Bug、任务、备注五种记录类型，并按类型显示不同字段；
- 产品、平台和单层模块归类；
- 截图、视频与日志上传、预览、编号、删除和受控读取；
- 搜索、筛选、分页、编辑、状态流转和人工验收；
- 简体中文与英文界面，以及基础 PWA 离线壳层和本地草稿恢复；
- 单管理员账号登录，无公开注册入口；
- SQLite 元数据与服务器本地附件存储；
- 正式 Android 管理 App（WebView 外壳），网页更新无需重新发版即可生效；
- Android 反馈 SDK：环境与日志采集、H5 编辑、附件重试、草稿恢复和 WorkManager 后台提交；
- OAuth 保护的只读 MCP，以及可移植的 MissionGo Skill；
- 浏览器原生 WebMCP 的条目列表、打开和创建入口。

AI 接入当前只负责按编号完整读取条目、时间线、日志和图片，不开放领取、回写、修改状态或任意数据库访问。视频只提供元数据。详见 [AI 客户端接入说明](docs/ai-client-setup.md) 和 [MCP 契约](docs/mcp-contract.md)。

## 尚未开放

- 公开注册、多用户、团队和角色管理；
- macOS/iOS 反馈 SDK；
- AI 自动领取、修改代码、回写结论或改变条目状态；
- 定时扫描、无人值守任务队列和管理端远程调度 AI；
- 公共 Maven Central 发布、多实例部署和对象存储。

这些方向保留在 [产品与技术路线图](docs/product-and-technical-plan.md)，不应被当作当前接口承诺。

## 系统组成

```text
Web / H5 ───────────────┐
Android 管理 App ───────┼── REST API ── SQLite + 本地附件
Android 反馈 SDK ───────┘

Codex / Claude Code / 其他客户端 ── OAuth + MCP（只读）
```

| 目录 | 职责 |
|---|---|
| `apps/web` | React/Vite Web 与 H5 管理端 |
| `apps/android` | 正式 Android 管理 App |
| `services/server` | Fastify REST、OAuth、MCP、SQLite 与附件服务 |
| `packages/domain` | 状态机和领域规则 |
| `packages/contracts` | 跨端类型与公开 MCP 工具契约 |
| `sdks/android-feedback` | Android 反馈 SDK、示例和验证宿主 |
| `skills/missiongo` | AI 只读工作流 Skill |
| `deploy` | Docker Compose 与反向代理示例 |
| `docs` | 架构、契约、接入和路线图文档 |

更详细的数据流和边界见 [系统架构](docs/architecture.md)。

## 本地开发

需要 Node.js 22.13 或更高版本，Android 构建另需 JDK 17 和 Android SDK。

```bash
npm ci
npm test
npm run typecheck
npm run build
```

复制 `.env.example` 为未跟踪的 `.env`。如果要使用网页登录和 MCP，请创建管理员密码摘要，再把输出写入本机 `.env`：

```bash
npm run admin:hash-password
```

同时填写 `ADMIN_ACCOUNT_ID`、`ADMIN_USERNAME` 和 `SESSION_SECRET`。不要把真实账号、密码、地址、Token 或本机路径写入仓库。

分别启动服务端和 Web：

```bash
npm run dev:server
npm run dev:web
```

默认本地地址为 `http://127.0.0.1:8787` 和 `http://127.0.0.1:5173`；默认数据在未跟踪的 `data/` 中。生产部署见 [部署说明](deploy/README.md)。

## Web/H5 支持范围

生产构建面向 Chrome/Edge 90+、Firefox 90+ 和 Safari/iOS 15.4+。低于 1024px 时切换为单栏布局，并适配横屏、安全区和底部手势区域。离线能力仅覆盖应用壳层、已缓存页面和本地草稿，不缓存 API、管理员凭据或受保护附件，也不会在离线时排队提交。

## 项目规范

- [贡献指南](CONTRIBUTING.md)
- [安全政策](SECURITY.md)
- [安全边界](docs/security-boundaries.md)
- [领域模型](docs/domain-model.md)
- [REST API](docs/openapi.yaml)
- [Android 反馈 SDK](docs/android-sdk/README.md)

提交改动前请运行 `npm run check`。工作内容、日志、OCR 文本和附件始终是不可信数据；只有人工可以把条目从 `pending_verification` 移至 `done`。

## 许可证

MissionGo 使用 [Apache License 2.0](LICENSE)。
