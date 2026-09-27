# AND-232：受监督的原生 Agent 执行控制

这是 AND-230 ledger 与 AND-231 人工决定之上的本地、默认关闭切片。Hermes 是唯一协调者；MissionGo 保存业务事实。它不是不互信租户平台，不提供 OS 隔离、全客户端网络限制、完整后代进程证明或 exactly-once 外部执行。没有 VM、容器、父进程防火墙、特权模式、全局 Agent 配置修改或自动 continuation Bridge。没有新 dashboard、通知或生产试运行；执行完成不改变工作条目状态。

## 启用与身份

服务端 `MISSIONGO_MANAGED_EXECUTION=1` 才允许创建 Run 和启动意图；`MISSIONGO_COORDINATOR_CLIENT_IDS` 明确允许现有 OAuth 注册客户端 ID。必须配置为 Hermes 的专用客户端授权，不能填显示名，也不能把 worker 客户端列入。仍使用现有签名 OAuth、账号有效性、单独授权撤销和实时产品 view/operate/ai 检查；所有协调者请求要求 `missiongo:read`，变更操作另要求 `missiongo:write`，白名单不能扩大 OAuth 授权。人工决定接口仍只接受人类 Cookie，不接受此协调者 Bearer。普通 MCP、运维 token、Node token、请求体角色标签都不能取得协调权。

macOS Node 启动新执行也须显式设置 `MISSIONGO_MANAGED_EXECUTION=1`，且现有 Codex 集成已获本机用户启用。默认关闭时仍回放本地待确认观察并轮询托管工作与会话，以接收停止信息；不领取或启动新执行，也不投递托管输入。启动使用现有 Codex daemon/socket 路径；托管路径不会为故障自动重启 daemon。节点仍用自己的既有凭据领取和报告，不能为其他节点领取。worker 不接收这些控制凭据。

这是运行时开关，代码交付未启用它。关掉服务端开关拒绝新启动，仍接受读取、停止请求、结果与清理核对；已运行的 Node 会通过既有会话轮询收到停止标志。离线、被撤销或本机集成关闭的 Node 无法被服务端强行停止，所有权继续保留。不要把开关关闭当作进程已经消失。

## 启动与持久化

协调者先列出其账号可访问的 opaque repositoryRef（现有 node_product_repos.id，不返回路径），核对本机仓库未被其他 Node 共享后，通过 `POST /executors/{nodeId}/register` 注册 `single_node_local` 模式和证据，再创建冻结范围 Run。注册要求当前账号及所有映射产品权限，同一 installation 只允许一个执行器注册；不接受 shared 模式。注册是可信协调者的监督核对，不是服务器独立证明物理机器唯一。人工为该 Run 建立并批准 AND-231 decision 后，协调者请求 implement/review/verify stage。请求不接受路径、命令、模型、actor 标签或自由字段 patch。

每个意图绑定 run、decision ID、内容版本、状态版本、内容摘要、范围摘要、契约版本、stage key/ID、generation、完整 input commit、已注册 node/repository、角色权限模式和稳定幂等键。读写和幂等回放均重查账号与完整条目范围；启动事务内再次检查批准和注册映射。相同 key/载荷返回当前 receipt；异载荷冲突。被撤销或内容已改变的旧请求不会恢复授权。

`managed_execution_intents` 在交付前保存意图和所有权。`managed_execution_events` 保存不可改写的单意图递增事件。UTC 迁移 `202609270536` 与 receipt 同事务；SQLite `BEGIN IMMEDIATE` 包住权限/批准检查、stage、所有权及审计。AND-230/231 同步事务组合使用内部 SAVEPOINT，外层失败回滚全部记录。

AND-230 的 attempt 仍要求真实 executor identity。**意图不是虚构 attempt**：只有原生 `thread/start`/运行时读取报告了 session ID 和 model 才建立 ledger attempt；请求的别名不代替实际 model。已知 session、未知 model 可以先建立会话镜像，但 execution 保持 unknown，不能成功结案。Node 报告属于受信任节点的运行时观察，并非服务器对模型供应商或磁盘的独立证明。

状态：requested → acknowledged → starting（仅准备线程）→ bound（真实 session/model 已由服务端持久确认）→ turn_starting（首次 turn 的独立一次性许可）→ running / waiting；不确定结果、重启后未完成启动、超过两分钟没有观察的活跃执行进入 unknown。Node permit 在 acknowledged→starting 和 bound→turn_starting 两个明确阶段各只授权一次，重放返回当前记录和 false；丢失响应不会重新授权另一启动。许可之前撤销会取消并释放未启动意图；许可之后撤销只请求停止，保留可能已经产生的效果及所有权。工作目录准备也在许可之后进行。

unknown 不会靠租约过期重新派发。协调者使用证据显式核对结果，terminal 仍保留所有权；独立 cleanup 观察才释放。证据是协调者记录的人工/原生核对引用，不是自动验证的后代进程证明。未启动取消、或失败且清理已核对的意图可在相同 input/role、ready/failed stage 下重试。意图 generation 独立按 stage 持久分配，不因无 attempt 的取消而复用；`attemptGeneration` 记录真实 ledger 代次，仅从 beginAttempt 的返回值取得，后续 ledger 操作使用该映射。旧代次不能写回新执行。成功 stage 的新输入需要新 stage。

Node 在协调者私有 runtime 目录保存完整绑定、启动阶段、真实收据、观察序列和待确认载荷，目录权限 0700、文件 0600；在同目录写临时文件、fsync、rename，再 fsync 目录，不使用 worker worktree 保存收据。网络失败前后、服务端提交后 ACK 丢失及 Node 重启均重放同一观察载荷。首次 turn 必须等 bound 回报 ACK，再取得当前批准下的首 turn 许可；任何未确认的线程/turn 副作用都保留 unknown 占用，不能新启 writer。线程返回与本地落盘之间仍有不可原子化的崩溃窗口：此时启动前日志保证保守 unknown，但不能凭空恢复未收到的 session/model，也不声称原生副作用 exactly-once。

观察用单意图持久单调 sequence 作为事件身份；相同事件重放原始 generation/state/session/model，不取新版本拼旧幂等键。HTTP 观察身份字段不做 trim，首尾空白直接拒绝。服务端事务中保存载荷摘要与原文，分别生成 begin/state 的 ledger key；重复事件返回确认，不重复 beginAttempt，也不覆盖较新的终态。复用序列但载荷不同、未提交且落后于已提交序列的观察均拒绝。terminal 下精确匹配冻结 generation/session/model 的新序列迟到观察可以归档并返回 terminal ACK；不改变原终态、结果或所有权，已释放旧占用时也不影响新执行占用。Node 核对 ACK 绑定后持久封存；封存前退出仍重放原 pending。新的同状态观察使用新序列。同步原生会话的生产者也经同一 outbox，不能绕回直接报告。

## 工作区和旧手动派单

本切片以显式注册的 Node installation 为本地执行器所有权域，域内所有仓库路径、符号链接别名及共享 git common-dir 一律串行，不以用户路径或 mapping ID 分锁。不同账号、不同 installation 的历史会话不会阻塞此域。**跨 Node 的共享物理工作区不支持**：协调者必须拒绝把这种拓扑注册为 single_node_local；installation 身份和“不共享”证据属于可信注册前提，不能把任意账号自行声明的另一个 installation 当作服务器已经验证的另一台物理机器。本实现没有多机共享盘调度或全平台排他证明。

域内任何未解决的托管意图、manual queued/delivered/launched 或保留 delivered_at 的失败派单都会阻塞。idle、归档、时间经过都不等于结束。数据库触发器和入口检查使用同一所有权条件，覆盖派单、恢复、设置、输入和 queued 投递；未注册且没有托管占用的普通 manual 路径保持既有行为。外部终端或原生 UI 自行启动的 writer 不在这个服务器协议的排他证明内。

旧 manual 先用 `GET /manual-dispatches/{id}` 读取当前 generation 和历史证据，再用 `POST /manual-dispatches/{id}/reconcile` 绑定 execution generation、精确 deliveredAt 和核对证据，待输入、未知投递、设置和恢复必须先解决。记录不可改写。旧 session 之后可以重新取得域内所有权并进入新 execution generation，历史审计保留；功能关闭也不永久禁止其输入/恢复/设置。新代次未核对前仍阻塞托管，不能复用旧证据解除新占用。

相同仓库映射保存保留 repositoryRef；占用期间拒绝真实改删。启动时单独冻结映射、账号、Node 和路径，后续 jobs/收据不因配置保存丢失。每次仍查当前可信 Node、账号和产品权限；撤销权限会阻断控制，不扩大跨账号访问。

Node 根据注册仓库和固定算法建立每意图独立 detached worktree，验证精确 commit；不覆盖已存在目录，不自动清理。实现者可在该目录写入；reviewer 的独立快照使用原生 read-only + never，不能申请提升写权限；verifier 使用自己的构建目录。worktree 共享 Git 元数据，不是安全隔离。目录与共享 Git 的最终清理由协调者另行检查，本 API 不删除目录。

## 原生会话、输入与停止

复用 Swift `CodexAppServerControl` 和 `CodexLauncher`，不是 Python 生产启动器。独立 bounded prompt 明确角色、commit、Hermes 协调权和禁止业务写回/发布；不会调用 MissionGo Skill、领取条目或以 worker MCP readiness 为前置条件。任务上下文包含批准内容和条目标题/描述（每条描述最多 2000 字符），整体 prompt 上限 64 KiB；长任务需要协调者检查补充输入。

线程级 config 对 missiongo 的关闭仅是配置请求，不是权限证明。managed 没有 MCP allowlist：thread-scoped 列表中的每个注册必须明确报告 runtimeStatus=disabled 且 tools={}；改名的 worktracker、未知/缺失状态、仍有工具、分页不完整均拒绝，disabled 条目即使叫 missiongo 也接受。启动及 resume 都核对，托管 active-turn 输入等待 idle 后走受检 resume，不走未经核对的 steering。manual 和全局配置不变。目标协议版本为 Codex 0.155.0-alpha.16.3；这些状态字段目前只有 fixture 覆盖，尚未取得该版本真实无凭据协议证据，启动和托管 resume 要求 initialize.userAgent 中精确匹配该版本，缺失/不同版本拒绝；这个版本回包形态本身也尚待实机核对。Hermes 必须核对 threadId 是否真正限定 runtime、配置和能力回包语义；无法证明则保持默认关闭并拒绝启用。未引用官方 main schema 作为本机证明。不声称阻断所有 shell 网络访问或用户另行给予的凭据。

原生 session 关联现有 MissionGo 会话视图，显示 run/stage/generation/角色；真实 Node HTTP 投影携带相同绑定。持有占用或待停止的会话不因 idle/归档过滤消失。托管镜像包含 native thread/read 的用户、Agent、plan、可见工具和执行记录，不仅终态总结；加密 reasoning 字段不展示。沿用已有快照传输，能显示原生持久历史和当前可见输出，不是所有瞬时通知的无损事件捕获。超过既有单快照消息/文本上限时会拒绝报告并保留原生会话供检查，不能宣称全量无损。

补充输入只能由协调者为精确 intent/generation 发起；需当前批准且处于 running/waiting。投递确认时再次检查功能开关、批准和绑定，关闭/撤销后旧 queued 输入也不能绕过。稳定 key 绑定输入，回放返回当前 command receipt；复用 AND-203 的 queued/delivering/delivery_unknown 控制与原生 client message ID。恢复线程时再次关闭 MissionGo MCP 并检查原生角色权限。手动会话控制入口拒绝托管输入/权限修改。stop 标志通过精确 session/当前 turn 请求原生 interrupt；返回 idle 只是原生观察，不释放所有权。原生 app 中的人工直接操作仍是此监督模型的信任边界。

事件读取接口可供后续 Bridge 用游标轮询；`GET /intents/{id}/session` 返回该意图的既有会话镜像及真实 ledger attempt，尚无真实身份时相应字段为 null。**本版没有自动继续下一 stage、自动重试 unknown、自动通知或自动完成条目。**

## API 与检查

精确字段见 [openapi.yaml](openapi.yaml)。控制路径 `/api/v1/managed-execution` 仅允许可信协调者；`/api/v1/node/managed-execution` 仅允许已认证 Node。后台服务必须经本地评审再启用；不要在真实账户或生产 DB 上运行 fixture。

```sh
npm run build:types
npm run test --workspace @missiongo/server -- src/managed-execution-store.test.ts src/managed-execution.test.ts src/managed-run-store.test.ts src/managed-decision-store.test.ts src/managed-decision.test.ts
MANAGED_WIRE_FIXTURE="$TMPDIR/managed-node-wire.json" npm run test --workspace @missiongo/server -- src/managed-execution.test.ts
MANAGED_WIRE_FIXTURE="$TMPDIR/managed-node-wire.json" swift test --package-path apps/macos --filter ManagedExecutionTests
# SwiftPM 的嵌套 manifest 沙箱不可用时，直接编译同一组源文件和 XCTest（不关闭沙箱）：
MANAGED_WIRE_FIXTURE="$TMPDIR/managed-node-wire.json" sh scripts/test-managed-native-fixtures.sh
npm run check
```

测试使用合成身份和真实临时 SQLite 文件；两连接检查写锁及重复许可。Swift 单元测试覆盖策略、wire binding、可见执行记录和缺失运行时身份；未启动真实 Agent。实现过程的红/绿与沙箱限制见交付报告。生产迁移、发布、真实原生执行及完整 AND-229 试运行均未发生。

本次修复的红绿结果、实际验证命令及未完成的实机检查见 [review-fix 验证记录](and-232-review-fix-validation.md)。
