# Phase 0 决策

> 本文记录最初的架构决策和目标边界，不等同于当前完成清单。当前已实现能力以 [README](../README.md) 和各公开接口契约为准；macOS SDK、AI 写回及部分 Android 原生增强仍属于后续阶段。

## 总体架构

- 整个仓库使用 Apache-2.0 开源许可证。
- 首版采用模块化单体，而不是微服务。
- REST 和 MCP 适配层保持轻量，共同调用同一套领域服务。
- Web、服务端、共享契约、Android 外壳和 SDK 统一放在 monorepo 中。
- 首个自托管版本使用 SQLite 和私有本地附件目录。
- 存储接口保持可替换，后续可以增加 PostgreSQL 和 S3 兼容对象存储。

## 客户端边界

- Web 应用承担共享管理界面和 H5 反馈表单。
- Android 管理 App 使用 Web 界面作为主体，并增加原生分享、附件、安全存储、离线草稿和深度链接能力。
- Android 反馈 SDK 是供宿主应用接入的小型 Kotlin 库。
- macOS 反馈 SDK 使用 Swift Package，支持 SwiftUI 和 AppKit 应用。

## AI 边界

- AI 客户端通过 MCP 访问实时工作条目，永远不直接访问 SQL。
- Skill 负责教授可复用工作流和不同客户端的调用细节。
- MVP 只支持用户按需触发，不自动领取或定时执行。
- 工作条目内容属于不可信数据，不能覆盖 Skill、代码仓库或用户指令。
- 真正处理代码时使用隔离分支或 worktree，可以创建本地 commit。
- 默认禁止 push 和 merge。
- 最终验收权始终属于人工。

## 暂缓决定

- Android 自动更新和系统通知。
- 从管理端远程派发到 Mac mini 或服务器 AI 节点。
- 自动调度、iOS、崩溃自动采集、PostgreSQL 和对象存储。
