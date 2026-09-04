# 领域模型

## 层级关系

```text
产品（Product）
├── 组件（Components）
├── 功能区域（Areas）
├── 代码仓库（Repositories）
└── 工作条目（Work items）
    ├── 附件（Attachments）
    ├── 评论与事件（Comments and events）
    └── AI 执行记录（Execution runs）
```

产品是用户所认知的一款完整应用。组件是可以独立构建或独立修改的技术单元。功能区域是扁平的功能分类。代码仓库表示逻辑代码位置，不保存与某台机器绑定的绝对路径。

以 Hermes Go 为例，Android 和 macOS 应归为同一个产品下的不同组件，而不是两个独立产品。

## 工作条目标识

每个产品拥有一个大写字母前缀和一条单调递增的编号序列。用户看到的编号格式是 `<PREFIX>-<SEQUENCE>`，例如 `HG-128`。

数据库内部还会保存一个不透明 ID。外部客户端应尽量使用用户可读的条目编号。

## 环境信息与附件

工作条目可以保存结构化环境快照，包括平台、产品版本、构建版本、代码版本、系统版本、设备型号，以及数量和长度受限的自定义元数据。Web 管理端支持手动填写和修改这些字段；未来的 Android 和 macOS SDK 也会自动写入同一份数据契约。

附件元数据保存在 SQLite 中，文件内容保存在配置的本地附件目录中。首版支持图片、视频，以及 `.log`、`.txt`、`.json` 日志。服务端负责生成存储文件名，附件内容只能通过带鉴权的 API 读取，并始终按不可信输入处理。

## 来源组件与受影响组件

- `sourceComponentId`：记录反馈最初在哪个组件中被发现。
- `affectedComponentIds`：记录需要修改或验证的组件。

一条来自 Android 的反馈可能同时影响 Android、macOS、共享核心和服务端组件，不需要拆成多个顶层工作条目。

## 工作条目类型

每条记录统一称为工作条目，类型可以是 `idea`、`requirement`、`bug`、`task` 或 `note`。随着内容逐渐明确，可以修改条目类型，但稳定编号和完整时间线不会改变。

## 工作条目状态机

```text
inbox
  -> ready
  -> in_progress
  -> on_hold
  -> pending_verification
  -> done
```

人工验收失败后，条目会回到 `ready`，并追加重新打开事件。`cancelled` 是由人工控制的旁路状态。

`packages/domain` 中的实现是状态规则的唯一权威来源。REST 和 MCP 处理层必须调用它，不能分别复制状态流转逻辑。

## AI 执行记录

工作条目状态与 AI 执行状态相互独立。一个工作条目可以包含多次失败、中断或成功的执行。每次执行保存处理模式、触发来源、AI 类型、时间、处理报告和租约历史。

MVP 首先支持 `agent_pull`，即用户让 AI 主动按编号读取。领域模型会预留 `web_dispatch`、`android_dispatch` 和 `scheduler` 等未来触发来源，但首版不实现调度。
