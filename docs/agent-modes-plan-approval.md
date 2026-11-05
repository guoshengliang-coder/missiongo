# Agent 模式与方案批准（AND-400）

方案批准、客户端原生模式、工具权限批准分别记录。Bypass、Build、自动审查、完整访问及普通文字同意都不会生成方案批准。纯讨论/查询无需实施批准。

## 开发流程

1. Agent 读取条目和项目规则，完成诊断与澄清，提出方案及验证目标。
2. `request_plan_approval` 使用原派单或原外部会话身份，登记明确条目范围、方案和验证目标。`approvalMethod: web` 将精确版本交给会话中的批准按钮；`native`（默认）请求原生人工交互。它不领取、不写评论、不登记另一会话。
3. Web 登录用户批准，或原生客户端返回人工接受后，服务端保存批准人、来源、方案正文、验证目标、版本与条目内容边界。普通工具参数不能自报批准，技术权限请求也不提供这份授权。
4. 节点应用原先明确选择的实施模式，回报实际生效结果；之后才能领取和实施。OpenCode/Claude 明确选择 Plan 时仍保持 Plan，需要明确选择实施模式。同一批准方案切换模式不重复批准。
5. 新方案取代旧请求，条目内容、返工或 Builder 交接边界变化使旧授权失效。旧版本、其他会话、其他账号、扩大的条目范围和未确认的原生模式不能用于领取。

批准、提问和投递继续复用现有会话、权限区、`Select`、`Modal` 与队列。派单不常驻展示固定开发流程，不增加“工作方式”或“沙箱范围”选项。

## 原生语义与默认值

| 客户端 | 选项 | 无明确偏好时 |
| --- | --- | --- |
| Codex | 默认权限、自动审查、只读、完整访问权限 | 自动审查 |
| Claude Code | Default、Accept edits、Auto、Bypass permissions、Plan | 原生确认 Auto 可用时 Auto；确认不可用时 Bypass；未知时必须选择可用模式 |
| OpenCode | Plan、Build | Build |

Codex 完整访问目前受节点“受管工作区”策略禁止，界面禁用并说明原因。只读保持原生只读沙箱。实施前的阶段使用原生 Plan collaboration mode 与只读约束；不会把 `plan` 继续当作权限选项。旧 Codex `plan` 按原有自动审查权限含义映射到 `auto`，原先等待批准的意图由统一批准流程保留。旧 OpenCode `default` 按原含义映射为 `build`。其他保存值不静默替换，失效值继续显示并要求处理。

Claude 的能力探测使用隔离的原生控制协议，不发模型请求、不运行用户 hooks。对当前配置与有限的原生模型目录逐项 `set_model`、`set_permission_mode`，只有返回的实际模式与请求相同才认定可用；明确拒绝为不可用，缺少回执或探测失败为未知。模型目录超过探测上限的选项保持未知。原生版本、供应商及组织策略通过实际回执体现，不按模型或渠道名称推断。实际会话切换模型后先重新校验模式，失败保留实际已生效字段并显示错误。

## 兼容与验证边界

无关联条目的项目会话按明确选择的原生权限模式启动；Codex 自动审查保持 workspace-write，Claude Code 保留 Auto/Bypass 等选择，OpenCode 保留 Build，显式只读/Plan 也保持不变。讨论、需求登记和经确认的条目创建不要求先取得代码实施方案批准。普通项目开发仍须先调查并由用户明确批准方案；用户后来指定工作条目时，沿用原会话登记有范围的正式方案批准，未批准时切回原生计划阶段。

节点设置中的 `planning` 仅表示原生阶段，不授予方案批准。普通会话发送 `planning: false` 而不生成 `planApproved` 或批准记录；条目流程继续由持久化方案记录决定 `planning` 和实施权限。新节点兼容旧 `planApproved` 阶段字段。已有被错误限制的普通会话在更新节点后重新选择权限可恢复；已有正式方案请求的会话仍受该方案门禁约束。macOS 与 Linux 三个适配器共用该规则；外部接入会话保留原有来源权限边界。

节点 heartbeat 的 `planApprovalProtocol: 1` 表示本适配器具备原生阶段约束与回执检查；未声明的旧节点不能接收新派单，排队任务也不会被旧节点领取，`permit-start` 再次校验，需升级。旧偏好与历史不删除，不虚构旧任务的批准记录。

不支持原生交互批准的客户端可使用已连接会话的 Web 入口；没有可读原生连接的外部会话需要支持 elicitation 的客户端。协议失败保留未批准状态，不能用工具参数代替人工回答。外部会话仍保留原客户端支持的设置边界，不能借 Web 回复扩大原生权限。

必需发布产物为 Web/Server、macOS 客户端与 Linux CLI；无需重建 Android 壳或 Android SDK。交付时仍按实际 diff、发布覆盖门禁和公开制品核验，不能把测试通过当作已发布。

契约回归：`implementation-plan-gate.test.ts`、`implementation-plans.test.ts`、`plan-approval-routes.test.ts`、`AgentModeCapabilityTests.swift`、Linux native fixture 及既有会话恢复测试。界面回归覆盖派单、新会话、快捷设置、方案批准及窄屏“更多设置”。真实供应商账号、组织策略变化和真实 Linux/OpenCode 服务仍需在对应环境核验；模拟协议不能证明全部外部环境都可用。

原生接口参考：[Codex App Server](https://learn.chatgpt.com/docs/app-server)、[Claude Code 权限模式](https://code.claude.com/docs/en/permission-modes)、[OpenCode Agent](https://opencode.ai/v2/docs/agents)。
