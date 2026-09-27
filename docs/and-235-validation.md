# AND-235 本地实施验证

基线：`0a21224d0f27598f4a9972c0946c6db02e049368`。仅修改当前工作树，未调用外部业务接口，未提交、推送、合并或部署，未启动其他 agent。所有运行日志与命令保存在 `$HOME/and-235-validation/`，不加入 Git。测试身份、模型、域名均为合成值。

## 入口与约束定位

| 路径 | 核查结果与改动 |
| --- | --- |
| `services/server/src/app.ts` | 普通派单、重试、会话输入、设置、恢复、Node claim-next/snapshot；保留账号、产品权限、重复派发和托管专用控制入口校验。无需修改。 |
| `dispatch-store.ts` | 移除普通 create 的整节点托管占用检查；批次、Agent/model/mode、计划流程和重复派发检查保留。queued 交付原先也受 SQL 触发器影响。 |
| `agent-session-store.ts` | 移除其他执行对普通输入、设置、恢复及 queued 交付的阻挡；托管自身 stop/unknown 输入限制仍在。普通和托管各取最多 100 条会话，避免托管恢复挤掉普通控制。 |
| `managed-execution-store.ts`、`managed-execution-routes.ts` | 注册、审批、绑定、claim/permit/report/input/stop/finish/cleanup 全链路已检查。request 的占用改为当前托管 run；不同批次可并行。routes 无需修改。 |
| `managed-run-store.ts`、`managed-decision-store.ts` | 保留批次内部未决 attempt、审批撤销、版本和 generation 隔离。当前 run 的 unknown 不能用新 stage 或新幂等键替换；不会阻挡其他 run 或普通派单。无需修改。 |
| `storage/execution-ownership-sql.ts`、`managed-execution-schema.ts` | 原 helper、旧 schema 内容保持原样；helper 现在仅供历史迁移使用。新迁移移除 5 个跨控制路径触发器和节点唯一索引。 |
| `apps/macos/Sources/MissionGoNodeCore/NodeLoop.swift`、`APIClient.swift` | 普通容量使用现有 `occupiesExecutionSlot`；服务端现在对托管会话发送 false，ownership 仍在托管绑定中。协议字段兼容，无需修改 Node 启动器。 |
| `ManagedExecutionRuntime.swift`、`ManagedExecution.swift`、`CodexLauncher.swift`、`CodexWorkspace.swift` | 每执行日志、防重许可、程序先建专属工作树、已有路径拒绝、冻结 cwd/model/session、恢复范围及 MCP 校验均保留。未发现 common-dir 锁。旧 receipt 缺少 cwd 时仍不能恢复托管写入。 |
| `packages/domain/src/managed-execution.ts`、测试 fixtures | 未新增协议字段。调整真实服务端 wire 的容量断言；旧数据库 fixture 同步撤去新迁移 receipt，保证历史重建后重新升级。 |

普通启动提示、计划批准、先建 worktree 再编辑、产品身份和配置均未修改。原有 manual reconciliation 历史及 generation 记录仍可读取，普通控制不以该人工核对为启动前提。

实际修改文件：服务端 `dispatch-store.ts`、`agent-session-store.ts`、`managed-execution-store.ts`、`storage/database.ts`；回归 `managed-execution-store.test.ts`、`managed-execution.test.ts`、`storage/dispatch-separation-migration.test.ts`；fixtures `test-fixtures/before-managed-execution.ts`、`test-fixtures/before-dispatch-separation.ts`；Swift `apps/macos/Tests/MissionGoNodeCoreTests/ManagedExecutionTests.swift`；本文档。上表其余文件仅定位和检查。

## 新迁移与兼容性

通过 `date -u +%Y%m%d%H%M` 取得编号 `202609271508`，仅在 `storage/database.ts` 末尾增加迁移。新建库先执行历史迁移，再执行此迁移；旧库原地升级，不删除任何业务记录。

迁移在 `BEGIN IMMEDIATE` 内重查 receipt，删除 `managed_manual_message/settings/restore/insert/start` 五个触发器及 `managed_execution_node_owner`。保留 run ownership、`stage_id/generation` 唯一约束、幂等约束、immutable binding/observation/event/reconciliation 触发器以及普通原有权限约束。

真实 SQLite 文件验证了：新建库、恢复历史约束后的升级、重复打开、另一连接在锁前完成迁移、receipt 写入故障时 DDL 全部回滚。含旧 unknown、原生身份合成 receipt、attempt、会话、审批及审计的数据库升级前后逐表比较一致；升级后 unknown 仍不能再次获准启动，其他批次可启动，证据表删除仍被拒绝，外键检查为空。

## RED → GREEN

下表中的 `server test` 指 `npm run test --workspace @missiongo/server --`。每个日志首行保存完整命令，末行保存退出码。RED 是需求断言失败，不把工具或 fixture 错误当作有效 RED。

| 行为 | RED 命令及证据 | GREEN 命令及结果 |
| --- | --- | --- |
| 普通 queued 与不同托管批次并行 | `server test src/managed-execution-store.test.ts -t AND-235`；`02-red.log`，2 项分别被 SQL `workspace_owned` 和托管整节点检查拒绝 | `06-store-green.log`：store 与迁移共 42 项通过；后续扩大覆盖也通过 |
| 普通输入、设置、恢复、queued 控制交付 | 同文件 `-t 'AND-235 ordinary'`；`04-controls-red.log`，4 项因整节点检查或投影隐藏 command 失败 | `06-store-green.log`；后续增加 desiredSettings/restoreInSource 投影断言，`22-final-targeted.log` 通过 |
| 新建、升级、幂等与回滚 | `server test src/storage/dispatch-separation-migration.test.ts`；`03-migration-red.log`，缺少迁移 receipt 且故障未触发 | `06-store-green.log`、`23-migration-final.log`：2 项通过，包括锁前另一连接迁移与故障回滚 |
| 普通 HTTP 派单与控制 | `08-http-red.log`：临时加载基线的四个服务端实现文件运行 `src/managed-execution.test.ts -t separation`，普通派单实际返回 409 `workspace_owned`，随后恢复实施文件 | `12-http-green.log` 通过；补充 running 和 unknown/stop 两种状态、不同工作条目及重复派发保护后，`21-http-running-green.log` 两项通过 |
| 托管不占普通 Node 容量 | `server test src/managed-execution-store.test.ts -t 'ordinary Node capacity'`；`13-capacity-red.log`，实际 true、预期 false | `14-targeted-green.log` 通过；普通 active 仍占容量，托管 running/unknown/stop 不占普通容量且继续持有 ownership |
| 同仓库真实 worktree 并行 | `17-worktree-red.log`：基线执行 `-t 'synthetic Agent adapter'`，普通已交付时托管被整节点锁拒绝 | `18-worktree-green.log` 通过。临时 Git 仓库中一个普通、两个托管 worktree 共享 common-dir，同时写入各自文件；重复许可无效，已有路径创建被拒绝、原文件保留 |
| 大量托管恢复不挤占普通交付 | `server test src/managed-execution-store.test.ts -t 'recovery pages'`；`26-page-red.log`，100 个托管 unknown/stop 会话挤掉普通 queued command | 同文件 `-t 'recovery pages\|page limit'`；`27-page-green.log` 两项通过，保留托管恢复优先且普通交付独立取页 |

已有权限撤销、旧 generation、session/model identity 漂移、重复 observation、未知结果重启、清理前保留 ownership 等测试保留。两条真实 SQLite 连接验证持锁竞争、幂等和一次启动许可。

worktree 演练使用明确的合成 Agent 适配器，真实 Git/SQLite/文件写入，并非真实模型端到端。测试只在临时仓库生成合成提交，禁用系统和用户 Git 配置；没有提交任务工作树。

## 全量检查与原始记录

- `00-build.log`：`npm run build:types` 通过。`01-red.log` 是此前缺少 workspace 构建产物的环境失败，不计有效 RED。
- `05-green.log`：设置测试 fixture 未声明 models 的失败；补齐合成能力声明后 `06-store-green.log` 通过。`09-http-green.log`、`11-http-green.log` 是 fixture 错用 dispatch archive 入口的失败；改用实际 Agent session archive 入口后 `12-http-green.log` 通过。
- `16-check.log`：真正执行 `npm run check`。lint、identity、macOS contract、迁移编号、styles、build:types 通过；scripts 测试 34 通过、1 失败。失败为既有 `macos-permissions.test.mjs` 的子进程使用系统默认临时目录，`mktemp` 被沙箱拒绝；没有改该无关脚本。
- `19-workspaces.log`：独立执行 `npm run test --workspaces --if-present`，Web 356、contracts 9、domain 39、server 440 通过，2 项跳过。随后扩展的 HTTP running 和会话分页在后续针对性及服务端全量测试复验。
- `20-build.log`：`npm run build` 通过（类型及 Web 构建）。`24-lint.log`、`25-typecheck.log` 分别通过 lint 和 typecheck。
- `22-final-targeted.log`：9 文件、99 项通过、2 项跳过，含审批、托管、历史数据库迁移，并生成 `managed-wire.json` 及相关 wire fixtures。
- `23-migration-final.log`：补充迁移锁前竞争后 2 项通过。
- `28-server-final.log`：会话分页修改后，24 文件通过、1 文件失败；441 项通过、2 跳过，未修改的 `accounts.test.ts` 中一项测试在 `afterEach` 清理 hook 超时。`31-accounts-retry.log` 单独运行 `src/accounts.test.ts -t 'loses a product the moment'` 通过，保留两次原始结果，不把第一次失败抹去。
- `30-final-build.log`：最终类型及 Web 构建通过。`32-final-lint.log`：最终 lint 通过；`git diff --check` 无输出。

## 阻断与待父协调者复验

真实 TCP 测试 `15-real-http.log`：`AND235_TCP=1 npm run test --workspace @missiongo/server -- src/managed-execution.test.ts -t separation`，在本机随机端口监听时被沙箱以 `listen EPERM` 拒绝。此前所有 HTTP 注入断言已运行。Fastify inject 使用真实路由、鉴权、序列化和 SQLite，但不代表 TCP 验证完成。

Swift 测试 `07-node-red.log` 首次受系统默认 module cache 写权限阻断；`10-node-red-local-cache.log` 使用任务目录缓存后，SwiftPM manifest 因 `sandbox-exec: unable to open "system.sb": not found` 失败。未关闭沙箱、未提升权限。初始 Node 容量测试方案已收回，实际修复由服务端协议回归驱动；Node 产品源码不变。

最终 Swift 命令记录在 `29-swift-final.log`，选择 `ManagedExecutionTests|NodeLoopTests|DispatchPermissionsTests|CodexTests`，传入生成的 `MANAGED_WIRE_FIXTURE` 并使用任务目录缓存，仍以相同 `system.sb` manifest 错误退出。新增工作树路径/符号链接冲突断言和调整后的 wire 容量断言需要在可运行 SwiftPM 的环境复验，不能声称已执行通过。

两项原生进程 closeout 测试因未提供 `MANAGED_PROCESS_EXECUTABLE` 跳过；真实模型会话、真实原生 Agent 端到端、TCP HTTP 和完整 `npm run check` 均未验证完成。父协调者可在其授权环境运行上述命令，并用 `MANAGED_REAL_HTTP=1`、合成原生测试进程补跑跨进程用例。

## 独立修复轮次：P1 容量门禁与 P2 托管遍历

本节追加首轮冻结候选的两项纠正，前文历史失败记录保持原样。首轮容量测试仅覆盖 DTO，未覆盖服务端 claim-next 的计数门禁；首轮独立托管页只解决普通交付被挤掉，未保证超过 100 个托管批次自身可遍历。本轮只修这两点，未进行真实用户审批、生产试点或外部系统调用，未提交、推送、合并、部署或启动其他 Agent。

本轮原始日志均在 `$HOME/and-235-repair-validation/`，由任务目录中的 `run.mjs` 保存命令、完整输出和退出码。Vitest 使用 `VITEST_MAX_WORKERS=2`，没有放宽 timeout、删除或跳过原断言。后续 Git 验证通过单次命令的 PATH 选择已安装的 Xcode Git 可执行文件，绕过系统 Git shim 的缓存权限错误；未修改全局配置。

本轮增量文件共 8 个：

- `services/server/src/agent-session-store.ts`：计数排除所有托管镜像，Node 投影同步排除已归档普通会话；托管页按稳定会话 ID 和持久游标遍历。
- `services/server/src/storage/database.ts`：仅追加迁移 `202609271554`，编号取自当时的 `date -u +%Y%m%d%H%M`；历史迁移未改。
- `services/server/src/test-fixtures/before-managed-execution.ts`：历史库 fixture 撤去新增游标表、索引及 receipt，确保旧 schema 重建后正确升级。
- `services/server/src/and-235-repair.test.ts`：新增真实 Fastify inject 路由容量回归。
- `services/server/src/managed-execution-store.test.ts`：追加超过页上限、旧库证据不变、重启、队列新增和状态更新、多节点及 SQLite 连接竞争回归。
- `services/server/src/storage/managed-session-poll-migration.test.ts`：新增迁移原子性、锁内重查、重复打开及持久进度回归。
- `docs/managed-execution.md`：纠正整机互斥和旧 manual 阻挡其他批次的过时描述，补充容量与遍历保证。
- 本文件：仅追加本轮结果。

### 最小修复与保证

P1 的根因是 `countExecutionSlots` 仍计入托管 active/stalled 会话，虽 DTO 已声明不占普通槽位。现在 SQL 通过同一 `dispatch_id -> managed_execution_intents` 关联排除托管镜像；普通未归档 active/stalled 仍计入十槽上限，归档后释放。立即领取和长轮询醒来后的两个既有门禁都复用此计数，未改变派单模式、计划流程、模型选择或 Node 启动逻辑。

P2 的根因是固定按最新状态取前 100 条。现在每个 Node 仅保存一个稳定会话 ID 游标，选择托管页和推进游标同处 `BEGIN IMMEDIATE` 事务；每页最多 100 条，最多查询当前尾部和回绕头部两个有界页，不在应用内读取全量。普通页仍独立最多 100 条并保留原排序。新增索引为 `agent_sessions(node_id,id)`；游标不外键引用某个会话，所以游标对应会话退出候选集合也不会卡住。不同 Node 的进度分开；跨 store 实例、连接和服务重启共享已提交进度；数据库锁竞争失败不推进游标。

静态 N 条合格托管会话从任意游标起，至多 `ceil(N/100)+1` 次成功轮询覆盖全部。stop 不享有可造成普通观察饥饿的永久优先级；超过一页一直未清理的 stop/unknown 也按相同顺序循环。状态、更新时间变化不改变排序；新增或重新合格条目在游标之后进入本轮，在游标之前等待回绕。持续无界新增不承诺固定轮询次数或墙钟延迟。游标表示已选择交付，不表示 Node ACK；丢失响应会在后续轮次重投。轮询本身不发启动许可，既有一次启动许可和 journal 防重机制保留。

迁移只增加交付进度表及索引，不删除或改写旧 ownership、unknown、观察、绑定、attempt 或审计。测试用包含 205 个 held 批次、105 个 stop 的真实 SQLite 旧库原地升级并逐表比较证据；另验证 receipt 写入失败时 DDL 回滚、另一连接先完成迁移时锁内重查、重复打开不重建游标。

### 本轮 RED / GREEN 与环境失败

| 日志 | 原始结果 |
| --- | --- |
| `01-red.log` | 未构建 workspace 依赖，测试无法加载；不是有效 RED。 |
| `02-build.log` | `npm run build:types` 通过。 |
| `03-red.log` | P2 有效失败：第二页重复已见会话；P1 fixture installation ID 不合规，尚非有效 RED。 |
| `04-red.log` | P2 保持失败；P1 fixture 复用了托管工作条目，被既有重复派单校验拒绝。随后改用独立普通条目，保留该校验。 |
| `05-red.log` | 有效 RED：托管 running/unknown/stop 三种立即领取及等待后加入托管再唤醒领取均返回 204 而非 200；P2 重复第一页。普通十槽立即及等待后阻挡两项通过。 |
| `06-green.log` | 编辑命令语法错误使修复未应用，这次名称虽为 green，实际仍是相同 RED；没有计作成功。 |
| `07-green.log` | 最小修复后 7 项回归通过（其余 44 项被 `-t` 筛选，未改原测试）。 |
| `08-targeted.log` | 扩展测试 76 项通过；既有 synthetic Git worktree 测试受系统 Git shim 缓存权限错误拖慢，触发原有 15 秒测试和 10 秒清理 hook timeout。没有改 timeout。 |
| `09-check.log` | 执行完整 `npm run check`：lint、identity、macOS contract、migrations、styles 和 build:types 通过；scripts 出现已知 macOS `mktemp` 权限失败，同时系统 Git shim 持续缓存失败。约六分钟后以 Ctrl-C 中止（执行会话退出 130），不是通过；后续分项完成于下列日志。 |
| `10-workspaces.log` | 完整 workspace：Web 356、contracts 9、domain 39、server 451 项通过；原有 2 项原生进程测试因未提供 fixture executable 跳过。 |
| `11-build.log` | 类型及 Web 构建通过。 |
| `12-final-targeted.log` | 最终增量回归 3 文件 53 项通过，包含新增升级证据比较和归档容量投影断言。 |
| `13-scripts.log` | 单独重跑 scripts：34 通过、1 失败。失败仍为 `macos-permissions.test.mjs` 子进程 `mktemp` 使用系统临时目录被沙箱拒绝；未改无关脚本。 |
| `14-lint.log`、`15-typecheck.log`、`16-migrations.log` | lint、typecheck、迁移编号检查通过。 |

路由测试是 Fastify inject：真实鉴权、路由、序列化及 SQLite，**不是 TCP**。长轮询测试等待真实 waiter 安装后才加入十个托管会话，再经真实普通入队路由唤醒；也验证等待期间普通自身达到十槽仍返回 204。205 个托管批次测试覆盖最旧停止、超过一页未清理 stop、三次轮询覆盖全部、后续再次覆盖、普通 command 每次独立可见，并逐个验证不能再次获得启动许可。两节点各 101 条及两个连接验证游标隔离和锁竞争。

本轮按已知环境限制未重试 TCP 监听或 SwiftPM；真实 TCP、Swift journal/runtime 与首轮 Swift 断言由父协调者独立复验。全量 `npm run check` 不能宣称通过，macOS 脚本环境阻断保留；没有真实模型会话、真实用户审批或生产试点。

`17-diff-check.log`：最终 `git diff --check` 通过。上述 8 个文件之外的首轮已有修改保持保留，未清理工作树或更改 Git 元数据。
