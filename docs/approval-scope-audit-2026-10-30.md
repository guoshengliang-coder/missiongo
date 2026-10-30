# Agent 授权范围审计（2026-10-30）

## 范围和结论

审计开始时拉取并核对 `origin/main`（`3dc6aa9`），交付前同步到更新后的主线 `f83b141` 并重新验证。此次审查 Codex、Claude Code、OpenCode 的工具授权，从来源请求解析、节点快照、服务端校验与存储、Web 展示到来源回复。修改在独立分支完成，保留主工作区已有提交和未跟踪文件。此文档记录代码和测试证据，不代表已发布。

原则：用户必须能够选择来源协议支持的授权范围；单次、当前回合、当前会话、持久规则分别处理。持久授权必须携带用户明确选择的来源规则或来源元数据，不能把文字批准推断成持久授权。

## 发现与修复

| 编号 | 原问题 | 修复结果 |
| --- | --- | --- |
| A1 | Codex MCP 确认忽略 `_meta.persist`，即使来源提供 `session` / `always`，也只显示单次 | 支持字符串和数组形式；按来源声明显示单次、会话、始终允许；通过回复 `_meta.persist` 回传所选范围 |
| A2 | Codex MCP 的 `turnId` 合法缺失或为 null 时，请求被静默忽略 | 接受没有回合 ID 的请求，使用仅限本地展示的线程级标识；回复仍绑定原连接和原 RPC ID |
| A3 | Codex 旧版连接器通过 `item/tool/requestUserInput` / `tool/requestUserInput` 提供授权选择，节点未处理 | 支持单个封闭选择题，完整保留所有来源标签和说明，使用原问题 ID 和原选项文本回复；回答后记为 resolved，避免把拒绝选项错误记录为批准 |
| A4 | Claude Code 丢弃 `permission_suggestions`，只有批准/拒绝 | 显示来源提供的规则及保存位置；支持 session、localSettings、projectSettings、userSettings。对持久 allow 规则和目录建议另提供原生 session 目的地，范围不变、生命周期缩短；明确选择后才返回 updatedPermissions |
| A5 | OpenCode 点击始终允许后，按 action 相同批量批准，忽略资源和拟保存规则差异 | 只有 action、resources 和 save 范围都相同的重复请求才联动回复；不同命令、目录、保存范围保持独立。显示此次资源和拟保存范围 |
| A6 | OpenCode 批量回复失败仍把其他请求标记为已回答 | 仅将回复成功的重复请求写入已回答记录，失败请求保留待核实状态 |
| A7 | Codex 额外权限等 action 超过展示长度时，会截断展示但仍保留完整授权能力 | 范围或规则不能完整展示时转为 unavailable，提示到原客户端核对，阻止通过截断预览批准 |
| A8 | Claude / OpenCode 的记住授权原先只靠重复的选项文字，旧页面或延迟回复可能应用到下一条请求 | 使用现有问题 key 将选择绑定来源请求 ID；过期答案明确失败，保留新请求，不转成普通消息、不写入新规则；Claude 本机 /answer 继续校验显式请求 ID |

## 授权类型覆盖矩阵

| 来源 | 可选择范围 | 校验结论 |
| --- | --- | --- |
| Codex 命令执行 | 单次、会话、来源提供的命令规则、来源提供的网络允许/拒绝规则 | 保留 `availableDecisions` 约束和原规则内容；明确为空时不补出权限。必须人工逐次批准的 humanCommand 不提供记住授权 |
| Codex 文件修改 | 单次、会话、拒绝、取消 | 原有会话选择保留；协议未提供通用永久授权，不添加虚假按钮 |
| Codex request_permissions | 当前回合、会话、拒绝 | 回传原请求权限和独立 scope；该协议没有通用 always 范围 |
| Codex MCP 空确认表单 | 单次及来源声明的 session / always | 单次/拒绝不携带 persist；不会回显来源的其他元数据；不支持的生命周期不显示 |
| Codex 旧版连接器选择题 | 所有来源提供的选项 | 不解释或翻译原标签，不将其改写为命令审批的 decision 格式 |
| Claude 普通工具请求 | 单次、建议规则的会话范围和明确保存位置 | 单次不包含 updatedPermissions；未知选项不能触发规则保存；遵守 suppress_always_allow_rule |
| Claude 外部桥接会话 | 同上，显示本机桥接可用的原选项 | 仍要求带请求 ID 的本机 /answer；Web 普通文字不能替代外部会话的授权 |
| OpenCode V2 | once / always / reject | 原生 always 保存工具建议的项目规则；不虚构独立 session 回复；批量批准限相同范围 |
| 自动审核 | 保留上游审核和现有人工重试入口 | 不把一次自动通过当作用户选择的持久授权 |

## 明确保留的边界

- MCP 非空表单、OAuth URL 流程、用户验证等需要填写或外部交互的请求，继续提示到原客户端完成，不用空内容伪造批准。旧版选择题的多问题、敏感输入、纯自由输入同理；单问题已有选项即使允许额外自定义输入，仍可选择其已有选项。
- Claude 的 AskUserQuestion 和 ExitPlanMode 继续按提问和计划确认处理，不混同于普通工具规则授权。
- 新增的始终允许及来源标签需要配套更新服务端/Web 与 macOS 节点。旧节点不报告完整选项时，Web 无法凭空恢复来源能力。
- 持久规则由各来源工具实际保存；MissionGo 保存选择并回传，不自行建立跨应用的全局放行表。本次没有向真实浏览器或用户工具配置授予权限，没有替用户选择长期授权。
- 本次验证不声称已在所有真实来源服务上证明跨重启持久化；来源协议、精确回传、断线失效、服务端存储及界面提交由本地回归覆盖。

## 依据

- [OpenAI App Server：审批及 MCP 请求](https://learn.chatgpt.com/docs/app-server#approvals)，并核对本机 Codex CLI 0.166.0 生成的实验协议 schema（MCP 回复包含 `_meta`）。
- [OpenAI 官方协议实现说明中的 MCP 生命周期声明](https://github.com/openai/codex/blob/f11583b8f69f97426afc1c2722d84ae040535efc/codex-rs/app-server/README.md#mcp-server-elicitations)。
- [Claude Agent SDK TypeScript：CanUseTool、PermissionResult、PermissionUpdate](https://code.claude.com/docs/en/agent-sdk/typescript#canusetool)，并核对本机 Claude Code 2.1.312 的 can_use_tool 字段。
- [OpenCode V2：Approvals](https://dev.opencode.ai/v2/docs/permissions/#approvals)。仓库适配的 `/api/session/.../permission/.../reply` 是 V2，不能把 V1 的 always 会话语义套用到它。

## 验证

- `npm run check`：通过；包括 lint、产品身份、macOS/Android 契约、迁移、样式、55 个脚本测试、469 个 Web 测试、9 个 contracts 测试、43 个 domain 测试、682 个服务端测试（另有 2 个既有跳过）、类型检查和生产构建。
- 服务端授权存储及迁移定向测试：2 个文件、4 个测试通过；覆盖会话、永久和来源标签的保存、精确选择、断线失效、旧请求拒绝及不支持选项的拒绝。
- 授权 Web 回归：已有和新增的 6 项通过；覆盖 375px 手机和 1440px 桌面、会话/永久/原文选项提交、导航和重连、不自动选择、提交后禁用重复操作、布局不溢出。
- 客户端最终定向回归：98 个测试全部通过，覆盖 CodexApprovalTests、ClaudePermissionRequestTests、ClaudeExternalBridgeTests、ClaudeSessionHostTests、OpenCodeTests，以及主线更新涉及的 CodexTests、GatewayEnvironmentTests。
- Claude 手机界面专项回归：1 项通过，验证规则范围可见、会话和永久选项可选、选择后仍需明确发送、带具体请求标识的原选项文本正确提交；与前述 6 项合计 7 项浏览器回归通过。

所有服务测试和浏览器测试使用隔离的临时数据；没有 push、merge 或部署。
