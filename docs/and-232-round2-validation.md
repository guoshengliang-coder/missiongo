# AND-232 第二轮修复交接

本记录只描述第二轮增量，不替代原候选记录或 Hermes 的独立验收。保留进入会话时已有的全部候选修改；没有提交、push、PR、merge、release、deploy、业务 MCP、凭据访问、全局配置修改、沙箱关闭或外部证据修改。

## RED → GREEN

下列命令在专用工作区执行。`TMPDIR` 指执行环境已许可的可写临时目录；Xcode Git/Swift 使用已安装工具的直接路径，未安装工具或扩大权限。

| 项 | 修改前实际业务失败 | 修改后验证 |
| --- | --- | --- |
| A | `npm exec -- vitest run services/server/src/managed-execution.test.ts -t 'operate\|ai permission'`：两用例失败；撤权后的 Node 轮询仍返回 queued 文本，delivering ACK 返回 204 而非 404。 | 包含上述用例的完整 HTTP 文件转绿，最终 8 项通过。测试从真实 HTTP 创建 run、批准、请求、permit、report、排队，到产品权限撤销、轮询及回调，没有只手动设置投递状态。 |
| B | `sh scripts/test-managed-native-fixtures.sh`：`testManagedResumeRejectsIdentityAndScopeDrift` 有 7 个业务断言失败，thread/cwd/model 漂移和缺失、额外 writableRoot 未被拒绝。 | 相同脚本最终 47 项通过；冻结 receipt 带规范化 cwd，首 turn 和后续输入传入同一身份上下文，resume 检查实际 thread.id/model/cwd/策略/写根。上下文缺失拒绝继续，不从请求模型或新观察猜测。 |
| C | 同一 Swift 脚本：`testLocalDisableBlocksExistingManagedInputsButPreservesManual` 中 queued/delivering 命令仍被送给 adapter，stopRequested 仍为 false。 | running/waiting 绑定的四种组合均通过；本地关闭过滤托管输入并送停止观察，manual 不变；持久 outbox 仍可原载荷重报，没有许可或新增 turn。 |
| D | `TMPDIR="$TMPDIR" npm exec -- vitest run services/server/src/managed-execution-store.test.ts -t 'late bound'`：提交前断线、时间前移 121000ms、get 转 unknown、关闭重开 SQLite 后，bound 被 binding_not_expected 拒绝；冲突校验也被该条件遮蔽。 | 包含上述用例的完整 store 文件转绿，最终 32 项通过。精确绑定的迟到身份在 unknown 下补记，状态及占用保持；首 turn 禁止。同序列原载荷、丢 ACK、重启、错 generation/session/model 均覆盖。另有真实 HTTP 的 late-before/late-ack 用例，含超时后关闭、失去 view、原样重报及恢复权限后仍拒绝许可。 |
| E | `npm exec -- vitest run services/server/src/managed-execution.test.ts -t 'view-'`：关闭且失去 view 的会话轮询返回 404；managed jobs 和观察回传在开/关两种情况下均返回 404。 | 包含上述用例的完整 HTTP 文件转绿。只允许经过认证且与冻结 Node/account/product 绑定相符的最小观察/停止，jobs 返回空任务列表及 id/generation stops；会话返回无输入的停止投影；report 只返回 accepted。历史 manual 观察会话不被阻塞。账号停用或 Node 撤销仍是 401，另一 Node 是 404。HTTP 最小 wire 经 Swift 解码、交给 launcher，并断言 interrupt 调用。 |

环境错误不计为 RED：首次未构建 domain 的包解析失败；Swift 默认缓存写入失败；一次编译期间测试文件发生修改；两条新增 Swift 用例初次误用系统临时目录。业务 RED 及最终 GREEN 如表所列，未降低断言或门禁。

## 最终命令及实际结果

```sh
# 真实 app.inject 响应写到临时目录，包括 minimal-jobs/minimal-sessions 两个旁文件
MANAGED_WIRE_FIXTURE="$TMPDIR/managed-node-wire.json" \
  npm exec -- vitest run services/server/src/managed-execution.test.ts \
  services/server/src/managed-execution-store.test.ts

# 初次组合最终 40 项通过；增加历史 manual 观察检查后，HTTP 文件再跑 8 项通过。
# 随后的 Swift 执行消费的是重新生成的最后一版 wire。
MANAGED_WIRE_FIXTURE="$TMPDIR/managed-node-wire.json" \
MANAGED_NATIVE_RESUME_EVIDENCE="$HOME/independent-evidence/resume-results.json" \
DEVELOPER_DIR="$(xcode-select -p)" sh scripts/test-managed-native-fixtures.sh
# 22 managed + 25 NodeLoop = 47 项通过，0 跳过、0 失败。

npm run check
# lint、身份、macOS 契约、迁移、样式通过；scripts 34/35，签名 fixture 环境失败后退出。

npm run test --workspaces --if-present
# Web 356、contracts 9、domain 39、server 416 均通过。
# 此后只增加上述 HTTP 历史观察用例的检查并定向重跑，没有继续修改业务实现。

npm run typecheck
npm run build
npm run lint
git diff --check
# 均通过。
```

`npm run check` 未通过的实际错误来自 `scripts/macos-permissions.test.mjs` 的签名顺序 fixture：`mktemp: mkstemp failed on …/T/tmp.…: Operation not permitted`，随后断言 `1 !== 0`。该 fixture 自己选择系统临时目录，外层设置可写 TMPDIR 仍不能消除限制；没有改无关测试。此结果不是完整 check 通过。

标准 Swift 全量实际尝试：

```sh
CLANG_MODULE_CACHE_PATH="$TMPDIR/clang-cache" \
SWIFTPM_MODULECACHE_OVERRIDE="$TMPDIR/swift-cache" \
swift test --package-path apps/macos \
  --cache-path "$TMPDIR/swiftpm-cache" \
  --config-path "$TMPDIR/swiftpm-config" \
  --security-path "$TMPDIR/swiftpm-security" \
  --scratch-path "$TMPDIR/swiftpm-build"
```

manifest 阶段失败：`sandbox-exec: unable to open "system.sb": not found`。默认缓存的前一次尝试还出现 `error opening …/C/clang/ModuleCache/Swift-….swiftmodule … Operation not permitted`。未使用 disable-sandbox。直接 XCTest 脚本只证明上述 47 项，不代表 SwiftPM 全量或真实 socket 链路已通过。完整 check 和标准 Swift 全量留给 Hermes 正常环境复跑。

## 修改范围与证据边界

- 服务端增量：`app.ts`、`managed-execution-routes.ts`、`managed-execution-store.ts` 及两个 managed 测试文件；同步 OpenAPI 的最小 jobs/report 响应。
- Swift 增量：`ManagedExecution.swift`、`ManagedExecutionRuntime.swift`、`CodexControl.swift`、`CodexLauncher.swift`、`NodeLoop.swift` 和 `ManagedExecutionTests.swift`。未改产品声明、迁移、manual 策略或原生 MCP 门禁。
- 原始协议测试直接读取 Hermes 许可的无凭据证据文件，实际通过两个 start 回包和四个成功 resume 回包，并构造缺失字段负例。源码 fixture 另覆盖身份、模型、目录及写根漂移。未将机器绝对路径或原始证据复制进 Git 文件。
- 未启动真实 app-server、未额外发送真实模型 turn。HTTP 是实际应用路由和真实临时 SQLite；Node runtime/adapter、interrupt 和传参测试是合成 fixture。继承的 `real-fixture-*` 标识只是 fixture 字符串，不代表真实模型执行。
- 没有重新执行 Hermes 的 SIGKILL 外部场景；旧工作区及未知执行清理记录未读取或操作。既有 SIGKILL 结果不能证明此次真实服务器 120 秒语义，D 已由本轮实际 store/HTTP 超时回归单独覆盖。

## 待独立验收的风险

- 标准 Swift 全量与完整 npm check 尚受上述环境阻断，不能据定向通过宣布批准或发布。
- 缺 cwd 的旧持久 receipt 无法满足新的 resume 身份要求，会拒绝新的托管输入/首 turn；只保留观察、停止和 unknown 保护，不猜测迁移旧 receipt。
- 漂移后的旧 receipt 只用于标识待核验的 unknown 执行，不授予新 turn。持久 outbox 与原生副作用仍不能组成原子事务；本轮没有宣称 exactly-once。
- 真实 native workspace-write resume 的完整生命周期、真实 socket 和真实模型执行未在本轮重跑；所读取的成功原生证据是无推理的 read-only 协议响应。写根校验保持严格，没有以 fixture 冒充实机授权证明。
