# AND-232 review-fix 验证记录

本次只修改专用候选 worktree，保留已有候选及 Hermes 的 S1 测试；未提交、push、创建 PR、merge、发布或部署。未调用业务接口或真实业务 Agent，未安装依赖、登录、购买、启动容器/VM，未关闭或提升沙箱。功能仍默认关闭。

## 逐项红绿记录

服务端定向命令前缀为：

```sh
npm run test --workspace @missiongo/server -- src/managed-execution-store.test.ts -t '<筛选>'
```

| 项目 | 实际红测试与筛选 | 修复及绿测试结果 |
| --- | --- | --- |
| S1 | Hermes 的 `actual Node session projection` 失败：Node 投影缺 managedExecution；HTTP `binds HTTP` 失败：归档 idle 会话列表为空；`page limit` 失败：占用线程被 100 条上限挤掉；关闭开关后 stale delivery 返回 204 而非 409 | Node 投影带绑定/占用；占用或待停止线程穿透 idle/归档过滤并优先分页；投递确认重查开关、批准与输入绑定；上述筛选均转绿。真实 HTTP 响应写入临时 fixture，Swift 实际解码并交给 CodexLauncher 消费。 |
| S2 | Swift `testMcpCapabilityValidationDoesNotTrustServerNames` 4 个断言失败；`testManagedQueuedInputCannotUseUncheckedActiveTurnSteering` 走入未经核对的 steer；`testManagedProtocolRejectsUnverifiedNativeVersions` 3 个断言失败 | 接受确证 disabled + 空 tools 的注册；拒绝改名写服务、未知状态、非空工具或不完整分页；托管输入等待 idle 再经受检 resume；初始化版本精确限制到 0.155.0-alpha.16.3。全部 fixture 转绿，真实原生回包尚未验收。 |
| L2 | Swift 三种 receipt 重报用例共 5 个断言失败：未重报或真实 session/model 丢失；首 turn 确认用例失败；冻结输入回归读到了重报期间变化的文本 | 私有持久日志保存完整输入绑定、阶段、真实收据和待确认载荷；先绑定身份，再一次性许可首 turn；回传重试/重启不新开线程；未确认副作用转 unknown 保留占用；首 turn 使用日志冻结文本/路径。持续运行失败、提交前失败、ACK 丢失重启、崩溃阶段及冻结输入用例通过。 |
| L3 | `second waiting` 复现 ledger idempotency_conflict | 持久单调观察序列 + 精确载荷重放；服务端保存原始事件，分离 begin/state key；同状态新轮使用新序列，迟到/改载荷拒绝，重复事件不再次 beginAttempt。该筛选、`replays exact durable observations` 和 Swift 重启/重复状态序列用例通过。 |
| L4 | `independent intent generations` 的 cancel、无收据失败、已有收据失败三分支均失败（stage_not_retryable 或 unique 冲突） | 独立持久分配 intent generation；attemptGeneration 仅来自真实 beginAttempt 回执；空代次取消不再复用序号，ready/failed 在安全释放后可重试。三个分支及后续报告/finish 全部通过。 |
| L5 | `frozen repository identity` 失败：no-op 保存随机换 ID | 保留相同映射身份，占用时拒绝真实改删；独立冻结启动映射，后续 jobs/report 仍校验当前 Node/account/product 权限。no-op、占用改删、映射消失后真实回报及跨账号/撤权断言通过。 |
| L1 | `registered Node instead` 被他账号历史阻塞；`reacquire a new execution` 被永久封禁；`explicit single-Node` 未注册仍可启动；`serializes manual continuation`、`queued manual controls`、`restoring a reconciled`、`late manual launch receipt` 分别复现域内重叠/投递/代次问题 | 显式注册可信 installation，域内所有路径和别名共用所有权条件；跨独立 installation 不互锁。manual 派单、恢复、设置、输入和 queued 确认共用检查；审计按 delivery + execution generation 不可变，新控制取得新代次，旧启动回执不重获所有权。以上筛选均转绿。 |

每项先执行目标红测试，再作修复并执行绿测试；相邻路径发现的缺陷也单独追加红绿。没有删除 Hermes 测试或削弱占用、权限、真实身份断言。原“reconcile 后永远不能输入”的用例改为在 managed 持有所有权期间继续断言拒绝，另外验证安全释放后新代次的正常 manual 行为。

## 实际命令与结果

```sh
# S1 原始红→绿
npm run test --workspace @missiongo/server -- src/managed-execution-store.test.ts -t 'actual Node session projection'

# 真实 HTTP wire；无真实监听端口和外部请求
MANAGED_WIRE_FIXTURE="$TMPDIR/managed-node-wire.json" npm run test --workspace @missiongo/server -- src/managed-execution.test.ts

# 最终 managed + migration 定向：4 文件，47 项通过
npm run test --workspace @missiongo/server -- src/managed-execution-store.test.ts src/managed-execution.test.ts src/storage/managed-run-migration.test.ts src/storage/database.test.ts

# 最终相邻 manual/dispatch 回归：3 文件，121 项通过（与上面重叠，不相加）
npm run test --workspace @missiongo/server -- src/dispatch.test.ts src/managed-execution-store.test.ts src/managed-execution.test.ts

# 最终 Swift：17 managed + 25 NodeLoop，共 42 项通过
MANAGED_WIRE_FIXTURE="$TMPDIR/managed-node-wire.json" sh scripts/test-managed-native-fixtures.sh

npm run lint
npm run typecheck
npm run build
npm run check:migrations
npm run check:macos-contract
git diff --check
```

上述 lint、类型、构建、迁移、macOS 契约和空白检查均通过。OpenAPI YAML 使用系统 Ruby/Psych（`ruby --disable-gems -r yaml`）成功解析，未安装解析器。迁移仍为候选 UTC 编号 202609270536，没有修改已合并历史迁移；旧数据库 fixture 已同步移除候选附加表、触发器和列。

`npm run check` 实际运行过两次，**未通过**：第一次已有 macOS 签名 fixture 失败，随后 Git/Xcode 缓存持续遭沙箱拒绝，主动中止；第二次仅为该命令的 PATH 优先选择已存在的 Xcode Git 可执行文件，未修改配置。其 lint、身份、macOS 契约、迁移、样式通过，脚本测试 34/35 通过，唯一失败为 `scripts/macos-permissions.test.mjs` 的签名顺序 fixture：`mktemp` 写入沙箱外系统临时目录被拒绝。没有改动这条无关测试来变绿。该次 check 在脚本测试阶段退出，后续阶段不能冒充已经由 check 执行。

为覆盖被提前退出遮住的阶段，另运行 `npm run test --workspaces --if-present`：当时 Web 356、contracts 9、domain 39、server 406 均通过。此后又补了分页、迟到 manual 回执及冻结首 turn 输入修复；最终受影响路径以上述 47/121/42 定向结果为准，不将中间 workspace 数量当作最终候选全量结果。

标准 `swift test --package-path apps/macos --filter ManagedExecutionTests` 尝试失败：默认缓存不可写；将缓存放到许可临时目录后仍被 SwiftPM 嵌套 manifest 沙箱的 `system.sb` 读取限制阻断。未使用 disable-sandbox。新增测试脚本直接编译同一 NodeCore 源码和 XCTest，读真实 HTTP fixture 并运行 managed/NodeLoop 测试；它不证明 SwiftPM 全套或真实 socket 协议已经通过。依赖 Unix socket 和系统短临时路径的原生协议回归仍留给 Hermes。

## 留给 Hermes 的独立验证

- S2 版本头、threadId 对 runtime 的真实作用域、disabled/tools 字段语义及线程配置合并行为，仍只有合成 fixture。必须用本机 Codex 0.155.0-alpha.16.3 的无凭据协议核对；不能据此宣称本机原生策略已经验收。未知回包/版本拒绝，不改 manual 或全局配置。
- L2 原生 thread/start 返回与私有收据落盘不能组成跨进程原子事务。这个窗口只能保留 unknown 占用；不能发明 session/model，不能宣称 native side effects exactly-once。真实进程崩溃、断网和 UI 停止效果尚需独立验证。
- L1 是监督注册的单 Node 本地执行器模型。installation 身份和无共享拓扑由可信注册核对，不是服务器的物理隔离证明。跨 Node 共享物理工作区不支持，不可将 shared 拓扑注册为 single_node_local；没有 VM、whole-client 网络限制或多机调度平台。
- 最终完整 diff、完整 npm check、标准 Swift 全套和真实原生协议由 Hermes 独立执行。本次没有 AND-229/232 全链路试运行，没有业务状态完成动作。
