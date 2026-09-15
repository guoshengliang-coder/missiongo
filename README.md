# MissionGo

> From idea to shipped.

MissionGo 是面向个人开发者的开源、自托管工作记录中心。它把灵感、需求、Bug、任务和备注集中到同一套结构化记录中，并让 Web、Android 和 AI 客户端共享完整上下文。

项目目前适合自行部署和小范围协作。它不是面向公众开放注册的 SaaS：账号由管理员创建，没有注册入口。它也不会把工作内容交给第三方服务。

## 已实现能力

- 响应式 Web/H5 管理端，支持桌面、平板和手机，并跟随系统的浅色/深色外观；
- 灵感、需求、Bug、任务、备注五种记录类型，并按类型显示不同字段；
- 产品、平台和单层模块归类；
- 截图、视频与日志上传、预览、编号、删除和受控读取；
- 搜索、筛选、分页、编辑、状态流转和人工验收；
- 简体中文与英文界面，以及基础 PWA 离线壳层和本地草稿恢复；
- 邮箱账号登录，账号由管理员创建，无公开注册入口；
- 管理员与普通用户两种角色，以及按账号逐个产品配置的查看 / 操作 / AI 调用权限；
- SQLite 元数据与服务器本地附件存储；
- 正式 Android 管理 App（WebView 外壳），网页更新无需重新发版即可生效；
- Android 反馈 SDK：环境与日志采集、H5 编辑、附件重试、草稿恢复和 WorkManager 后台提交；
- OAuth 保护的 MCP（读取，以及可选开启的评论与领取），以及可移植的 MissionGo Skill；
- 浏览器原生 WebMCP 的条目列表、打开和创建入口。

AI 接入负责按编号完整读取条目、时间线、日志和图片；在部署开启写入档位、且用户授予 `missiongo:write` 后，还可以发表评论、把「待处理」的条目领为「处理中」，并在 PR 确实合并后推到「待验证」——只有这两个状态流转。不开放修改条目内容与字段、创建或删除条目、撤回评论，或决定任务是否通过验收。视频只提供元数据。详见 [AI 客户端接入说明](docs/ai-client-setup.md) 和 [MCP 契约](docs/mcp-contract.md)。

## 尚未开放

- 公开注册、团队与组织；
- 从产品一侧反向配置账号权限，以及把自建产品分享给其他账号的邀请流程；
- 忘记密码找回，以及已签发 AI 授权的列表与主动撤销入口；
- macOS/iOS 反馈 SDK；
- AI 决定任务是否通过验收（验收、退回、搁置都由人做）；AI 修改条目内容与字段；
- 定时扫描和无人值守任务队列（管理端派单已经可用，但始终要人点一下，见 [执行机器](docs/node.md)）；
- 公共 Maven Central 发布、多实例部署和对象存储。

这些方向保留在 [产品与技术路线图](docs/product-and-technical-plan.md)，不应被当作当前接口承诺。

## 系统组成

```text
Web / H5 ───────────────┐
Android 管理 App ───────┼── REST API ── SQLite + 本地附件
Android 反馈 SDK ───────┘

Codex / Claude Code / 其他客户端 ── OAuth + MCP（读取 + 评论）

macOS 客户端（执行机器）── OAuth 登录 + 长轮询拉取派单 ── 本机启动 Claude Code / Codex 会话
```

| 目录 | 职责 |
|---|---|
| `apps/web` | React/Vite Web 与 H5 管理端 |
| `apps/android` | 正式 Android 管理 App |
| `apps/macos` | macOS 菜单栏客户端：把 Mac 登记为执行机器，接收派单并启动会话 |
| `services/server` | Fastify REST、OAuth、MCP、SQLite 与附件服务 |
| `packages/domain` | 状态机和领域规则 |
| `packages/contracts` | 跨端类型与公开 MCP 工具契约 |
| `sdks/android-feedback` | Android 反馈 SDK、示例和验证宿主 |
| `skills/missiongo` | AI 读取与评论工作流 Skill |
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

## 发布

四个产物从这个仓库发出：Web 应用、Android 应用、Android SDK 和 macOS 客户端。`released.json`
记录每个产物上次发布的版本和它构建自哪个提交，`npm run release:state` 据此说明
谁需要发、谁不用动：

```sh
npm run release:state -- --deployed https://<host>
```

- **up to date** — 自上次发布以来，喂给这个产物的路径没有任何改动
- **ready to publish** — 有改动，版本号也已经抬过了
- **needs a version bump** — 有改动但版本号没动

只有 **ready to publish** 能发。另外两种，两个发布脚本都会在构建任何东西之前拒绝。
拦下「没改动」不是洁癖：versionCode 是构建时间戳，构建也不可复现，所以重发一次会产生
第二个内容不同、版本名却相同的文件——正是这套记账要消除的那种歧义，换个门进来。

一个版本号必须只对应一份构建。`scripts/publish-android-internal.sh`、
`scripts/publish-android-sdk.sh`、`scripts/publish-macos.sh` 各自在开工前检查这一点，发布成功后把新的版本和提交
写回 `released.json`——那个文件是被跟踪的，记得和发布一起提交，否则下一次比较的
就是错的提交。三个脚本都有 `--allow-republish` 作为逃生口。

Web 应用没有自己的版本号，它的身份就是提交：`scripts/deploy.sh` 负责发布，
`/health` 报告线上跑的是哪个提交，细节见[部署说明](deploy/README.md)。

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
