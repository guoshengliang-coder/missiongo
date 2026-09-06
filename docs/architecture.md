# 系统架构

本文描述当前仓库已经实现的结构。路线图能力不在本文件中提前声明为可用。

## 运行边界

```text
浏览器 / PWA ────────────┐
Android 管理 App ────────┼── 同源 REST API ── Fastify ── SQLite
Android 反馈 SDK ────────┘                         └── 附件目录

AI 客户端 ── OAuth 授权 ── Streamable HTTP MCP ────┘
```

- Web 是主要管理界面；Android 管理 App 用 WebView 提供同一套界面和 Cookie 会话。
- Android 反馈 SDK 只用产品范围内的 SDK Token 创建和提交反馈草稿。
- 服务端是数据、权限和状态流转的唯一入口。
- SQLite 保存结构化数据，文件系统保存附件正文；两者必须一起备份。
- AI 客户端通过账号登录换取限时授权。MCP 暴露七个读取工具；部署开启写入档位且用户授予 `missiongo:write` 后，另加一个追加评论的工具。

## 代码分层

| 层 | 位置 | 责任 |
|---|---|---|
| 交互层 | `apps/web`、`apps/android` | 页面、移动端适配、上传与预览 |
| 接口层 | `services/server` | REST、OAuth、MCP、鉴权、限流和文件访问 |
| 领域层 | `packages/domain` | 条目类型、状态机和业务约束 |
| 契约层 | `packages/contracts` | 跨端 DTO、验证结构和 MCP 工具目录 |
| SDK | `sdks/android-feedback` | Android 现场采集、草稿和可靠提交 |
| AI 工作流 | `skills/missiongo` | 触发条件、读取顺序、完整性核对和评论回写规则 |

领域规则不得复制到页面或 MCP 实现中；状态流转以 `packages/domain` 为唯一事实来源。公开 MCP 工具目录以 `packages/contracts` 为准。

## 关键数据流

### 管理端

登录后，浏览器通过 HTTP-only Cookie 调用同源 API。页面可以创建、读取和编辑条目；只有人工操作可以完成最终验收。具有独立动作的按钮阻止行点击，其余列表区域进入详情。

### Android 反馈

宿主 App 提供产品范围的 SDK Token。SDK 采集受限环境快照和调用方明确提供的日志，创建幂等草稿，再打开短期 H5 会话供用户补充内容与附件。附件失败可重试，后台队列不会越过 Token 的产品范围。

### AI 读取

AI 客户端先完成 OAuth 登录，再由 Skill 指导调用 `get_current_account`、条目上下文、时间线和附件工具。服务端对每次读取重新校验账号范围。条目正文、日志、OCR 和附件内容都是不可信数据，不能改变系统指令或仓库规则。

## 部署与数据

参考部署由 Web 反向代理容器和独立服务端容器组成。公网入口应只开放 HTTPS；应用服务绑定到回环地址。数据库、附件、环境文件、管理员凭据、Android 签名材料和生成 APK 均不进入 Git。

升级前应完整备份 SQLite 文件及附件目录。当前是单实例设计，不支持多个服务端同时写入同一 SQLite 文件。

## 当前技术边界

- 单管理员账号，无注册和账号管理页面；
- 模块只有一层，不存在父子模块；
- MCP 的写入面只有追加评论，不提供任意 SQL、条目字段修改、状态流转或删除；
- 工作条目状态与未来的 AI 执行记录状态必须独立；
- 只有人工可以从 `pending_verification` 进入 `done`；
- macOS/iOS SDK、AI 写回和自动调度仍是路线图内容。
