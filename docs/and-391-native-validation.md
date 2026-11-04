# AND-391 真实原生协议验证

2026-11-04，独立合成聊天，使用本机真实 CLI 与实际适配器。测试未读取或中断已有会话，也未让测试 Agent 处理工作条目。每个会话先记住随机标记，停止后主动发送新消息，要求返回该标记及新的续聊标记，以核实原会话上下文。

| 路径 | 版本 | 停止前 | 实际结果 |
| --- | --- | --- | --- |
| Codex / Node 适配器 | codex-cli 0.164.0 | 首次 turn/start 回执后 active | 精确 turn 中断后轻量读取为 idle；同一会话正确返回上下文及续聊标记 |
| Claude / Node 适配器 | Claude Code 2.1.316 | AskUserQuestion 等待输入 | 中断后 turnActive=false、无旧待答请求；同一会话续聊并正确返回上下文 |
| Claude / macOS 宿主 | Claude Code 2.1.316 | AskUserQuestion 等待输入 | 真实 MissionGoClaudeHost 文件命令停止后 idle；同一宿主续聊，保留上下文 |
| OpenCode / Node 适配器原生控制协议 | OpenCode 2.1.4 | 独立会话 active | 实际中断后 active 状态消失；同一会话续聊并正确返回上下文 |

Claude 首轮真实测试揭示：等待工具时中断返回 `is_error=true`、`subtype=error_during_execution`、`terminal_reason=aborted_tools`，此前只有 `aborted_streaming` 被视为正常取消。已将 macOS/Linux 的 `aborted_tools` 同样识别为回合取消，并以该真实终态补回归。修正后的真实续聊验证通过。

OpenCode 共享服务对新测试目录及当前项目目录均未提供 connected 的 MissionGo MCP，产品派单的启动前检查拒绝启动。本次 OpenCode 结果来自同一已登记共享服务上专门新建的原生会话和实际适配器停止/续聊方法，未改认证或 MCP 配置；不能据此声称 MissionGo 派单至 OpenCode 的全链路验证通过。

自动化补查：Linux 31 项通过；Swift Claude/宿主专项 95 项中 94 通过、1 条件跳过（缺少该测试要求的显式本地 CLI 配置）；lint/typecheck 通过。更早的完整检查及 14 个浏览器场景见条目交接评论。

证据范围：上述结果证明真实供应商协议和本机适配器的停止与上下文续聊；不替代发布后安装客户端的界面端到端验收。服务端启动前取消、迟到请求、防重放、后台残留展示由自动化覆盖；真实断网/节点重启、全部后台子进程退出及外部客户端并发输入仍需单独核实。Claude/OpenCode 会话级中断的原子性边界见 `agent-session-stopping.md`。

## 后续真实复查

同日 13:41（Asia/Shanghai），未修改 MCP 或认证配置，OpenCode 的 MissionGo MCP 复查已为 connected。重新通过正常 OpenCodeAdapter.start 启动预检创建独立合成会话后，真实停止、同一会话保留上下文续聊、迟到旧停止不影响新回合三项均通过，补齐了最初启动预检未通过的验证缺口；仍不冒充发布后已安装节点的网页端到端验收。

三种 Agent 的真实迟到旧停止验证均通过：对新回合进行中提交旧输入标识，Codex 原生精确 turn 拒绝中断，Claude/OpenCode 在目标核对时拒绝，随后新回合仍 active。OpenCode 中断可能在接口返回后稍晚变为 idle；即时无法独立确认时保持未确认，不能用 ACK 宣称结束。
