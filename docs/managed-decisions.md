# Managed decisions：人工批准门禁（AND-231）

AND-232 adds a separate, default-off supervised execution control surface; see [managed-execution.md](managed-execution.md). The boundaries below describe the original ledger/decision APIs, whose recording and human-approval semantics remain unchanged.

## 边界

这是持久 Run 之上的批准记录与页面，不是执行器。`/managed-decisions/:id` 可深链访问，未登录时在原链接完成正常登录；读取、查看原条目及讨论都不产生批准。

- 实现、审查、验证是本版唯一可声明的动作：`implement` / `review` / `verify`。
- 不接受 merge、release、deploy 或 production migration；不会创建 dispatch、stage、attempt 或运行进程，不改变工作条目状态。
- 不新增 MCP 工具或外部 Agent 写权限。普通 MCP、节点、运维凭据均不能进入这些接口。
- Run 仍由受信任的内部 `ManagedRunStore` 创建；本版没有对外 create-run、执行资格消费或调度接口。提出决策须已有同账号的 Run，页面不伪造未存在的 Run。
- 手动派单保留原有行为，**尚未强制接入此门禁**；不能把本功能的测试结果说成全部派单已受正式批准控制。

## 版本、幂等与并发

每个 `runId + decisionKey` 对应稳定决策 ID。`version` 标识实质内容版本，`stateVersion` 标识授权状态版本。批准内容包含标题、推荐、其他选项及其代价、本方案代价、验收标准和明确允许动作；字段严格限界。

- 实质内容改变：内容版本和状态版本递增，清空旧批准及旧解释，回到 pending；只影响该决策，不影响同 Run 的其他独立决策。
- 同内容修订：不改变批准。仅补充解释：不改内容摘要、版本、状态或批准；解释显示在单独的“非批准内容”区域，不能增加动作。
- Run 范围、条目顺序、仓库映射引用及契约版本仍冻结。要改变范围，必须建立新 Run 和新的待批准决策；旧决策不能重新绑定新范围。
- 批准/撤销提交必须携带用户看到的 `version/stateVersion/contentDigest/scopeDigest/contractRevision`，以及稳定 `idempotencyKey`。账号身份不接受请求体参数。
- 相同操作、账号、决策和幂等键重放，必须同载荷且仍是当前授权状态；否则拒绝。同键异载荷为 `idempotency_conflict`。内容变化、旧状态、撤销后的旧批准回放为冲突，绝不恢复授权。
- 撤销可取消 pending 或 approved，撤销后原版本不能重新批准。重新提出实质变化要经过新版本。撤销记录保留在事件历史。
- `BEGIN IMMEDIATE` 包含权限回调、完整范围检查、版本比较、结果写入及事件 receipt。两个连接争用时最多一个相同状态版本写入成立；SQLite 写锁忙也会失败，不代表另一请求成功，客户端须回查。

内部 `requireApproval` 只检查该瞬间是否有匹配 run、范围、版本、动作的当前批准。它不是执行租约，不保证检查后到外部副作用之间不发生撤销。未来 worker 必须单独实现授权消费、fencing 与撤销/执行竞态处理，不能仅拿此函数返回值启动外部命令。

## 身份与权限

所有接口都先要求有效人类账号会话 Cookie，并拒绝任何 Authorization 头，包括“有效 Cookie + 运维 Bearer”。无认证部署也不开放本接口。

- 会话验证重读账号：停用、删除、改密、角色和产品授权变化即时生效；幂等重放也重新验证。
- 决策只对 Run 所有者开放，管理员不能借角色读取另一账号的 Run。
- 读取需 view；提出、修订、解释和批准需 operate + ai；撤销需 operate，因此取消 AI 权限后仍可撤销已有批准。
- 每次访问检查持久 Run 中的全部 itemKeys 仍存在且属于冻结产品，不能只验证请求自报产品或客户端条目子集。任一条目不符，整单拒绝。
- 写请求的 Origin 必须精确匹配配置的 `MISSIONGO_PUBLIC_ORIGIN`；未配置、缺失、null、外源或 `Sec-Fetch-Site: cross-site` 均拒绝。不依据 Host/X-Forwarded-Host 推断可信来源。
- 返回 `Cache-Control: no-store`。新页面不接入离线持久缓存；确认勾选绑定决策 ID、版本、状态版本、内容/范围摘要、契约、状态及当前权限，不能沿用到另一个绑定。初始读取、刷新和写后回查共用递增请求序号；过期成功或错误响应都不得覆盖新结果。网络写结果不明时先回查、清空确认，不自动批准最新版。

Cookie 代表服务器验证过的账号会话，不能证明屏幕前一定是该自然人；已泄露 Cookie、同源脚本被控制或直接数据库管理员不属于本接口能消除的风险。不得把“人类会话入口”夸大成硬件身份确认。

## HTTP 接口

详见 `openapi.yaml`。所有路径都在 `/api/v1` 下，仅人类 Cookie，不接受 Bearer。

| 方法与路径 | 作用 |
|---|---|
| POST `/managed-runs/:runId/decisions` | 为已有 Run 提出决策；返回 pending 或同请求 receipt |
| GET `/managed-decisions/:id` | 当前决策、产品可读名称、当前操作权限 |
| GET `/managed-decisions/:id/events?after=0` | 按 sequence 读取审计元数据，每页最多 100，跟随 nextAfter 至 null |
| POST `/managed-decisions/:id/revise` | Guard + 完整 content；不接受任意字段 patch |
| POST `/managed-decisions/:id/explain` | Guard + explanation；与批准内容分离 |
| POST `/managed-decisions/:id/approve` | Guard；记录本账号对该版本/范围/动作的批准 |
| POST `/managed-decisions/:id/revoke` | Guard；撤销/取消当前批准资格 |

批准与撤销返回记录快照，不是执行回执。常见错误：401 会话失效；403 身份来源/权限/Origin 不符；404 不存在或不属于此账号/产品不可见；400 不支持的字段或动作；409 版本、幂等或状态冲突。

## 数据与迁移

UTC 迁移 `202609270131` 增加 `decision_records` 与 `decision_events`，不改业务条目。迁移 receipt 在写锁内检查，DDL 和 receipt 同事务。事件保存每次操作的结果快照、请求摘要、账号、时间及顺序，可重建内容版本和批准/撤销历史；解释不会覆盖旧内容快照。

不记录 Token、Cookie、密码。HTTP 日志不增加请求正文；审计中的批准正文仅保存在有账号/产品权限门禁的数据库。不要将真实生产数据写入测试 fixture。

部署前按既有流程备份，迁移仅新增表；回滚代码会停止这些接口，但保留新增表和审计，禁止为回滚自动删除审批记录。生产发布与迁移另行批准。

## 验证与人工待验

自动测试：domain 合法动作及内容；持久化/重开；版本及幂等；撤销重放；资格检查；完整条目、跨账号和实时撤权；审计失败回滚；两个 SQLite 连接竞争；迁移失败回滚与锁内 receipt；真实 HTTP 登录、MCP/节点/运维及混合凭据拒绝；CSRF；手机浏览器深链登录、查看不批准、批准/撤销、旧页面冲突、重复点击、写响应丢失后的回查、窄屏/横屏及明暗可读性。

用户手机实测单列待验：发布到获准的环境后，用本人的手机打开真实决策链接，核对原条目、版本、代价及全部允许动作；确认查看/讨论不批准；明确批准并重新打开核对；再撤销并重开核对。自动化浏览器通过不能替代这一步。当前代码交付不代表已上线或人工验收通过。
