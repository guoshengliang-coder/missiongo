# AND-232 限定修复记录

本记录仅描述冻结第三候选上的两个批准修复点。保留其他候选改动；没有提交、修改 Git 历史、push、PR、merge、部署、业务写入、读取凭据或修改全局配置。测试使用隔离数据；文件中的历史证据路径没有被当作访问目标。

## 终态迟到观察

服务端沿用 report 和现有不可变 observation/event 表。终态的新观察必须通过冻结 Node/account、intent、generation、既有 native session 和 attempt 实际 model 校验；保存原始观察并记录 `terminal_observation_archived`，不更改终态、结果、权限或占用。不完整或不匹配的身份仍拒绝。同 sequence 的相同载荷幂等，不同载荷冲突。已提交后丢 ACK 的重报与终态后首次提交分别测试，前者不新增封存事件。

响应保留 `accepted:true`，可附带绑定 intent/generation/sequence/session/model 的 `terminal` 确认。Node 校验确认后原子保存原观察、确认回执及 terminal 阶段；重启不启动旧 worker，也不继续旧观察。普通 `accepted:true` 兼容旧服务端，但不构成终态证明。HTTP 错误、网络失败或不匹配的确认不得清空 pending。

批量回放和普通任务处理分别隔离每个意图的错误；日志报告失败，待提交证据留存，后续观察、发现和领取继续。没有增加 delivery_unknown 对账接口或自动释放占用。

## 启动与恢复的有效范围

启动和恢复共用范围校验。workspace-write 的有效写根为隐式 cwd 加显式 writableRoots；原生空数组和显式同 cwd 都接受，额外根拒绝。runtimeWorkspaceRoots 必须存在且精确指向冻结目录；缺失、错误类型、相对路径及词法 `.`/`..` 均拒绝。恢复仍绑定原 threadId、实际 model、cwd、approval 和 sandbox；冻结的规范目录被替换为外部符号链接也拒绝。read-only 仍不接受写根。

这里验证的是校验器与持久日志语义，没有启动原生模型或执行真正的 native workspace-write resume。隔离 HOME 的 native metadata 和旧协议证据只作为只读数据；没有访问其记录的源路径，没有用旧 inventory 或 start 回包冒充恢复成功。

## 命令与证据

所有命令从专用 worktree 执行，`TMPDIR` 指许可的临时目录。Swift 直接编译脚本使用已安装 Xcode，并将模块缓存放在 TMPDIR；没有关闭沙箱。`MANAGED_WIRE_FIXTURE="$TMPDIR/and232-wire.json"` 来自真实 app.inject/Store fixture，非真实业务服务。

| 阶段 | 命令 | 实际退出码与结果 |
| --- | --- | --- |
| Store 环境准备 | `npm run test --workspace @missiongo/server -- src/managed-execution-store.test.ts -t 'archives a first late terminal'` | 1；domain 尚未构建，未运行测试，不计 RED |
| 构建 | `npm run build:types` | 0 |
| Store RED | 同上述 Store 命令 | 1；目标 409 `observation_not_expected` |
| Store GREEN | 同上述 Store 命令 | 0；1 项通过 |
| 原 HTTP fixture | `npm run test --workspace @missiongo/server -- src/managed-execution.test.ts` | 0；8 项通过 |
| HTTP RED / GREEN | `npm run test --workspace @missiongo/server -- src/managed-execution.test.ts -t 'terminal-'` | 1 → 0；2 项，RED 缺少绑定终态确认 |
| SwiftPM 定向 | `swift test --package-path apps/macos --filter ManagedExecutionTests.testPermanentObservationRejectionIsolatesBatchAndOrdinaryJobsAcrossRestarts` | 1；系统缓存目录拒绝写入，不计 RED |
| Node 隔离 RED | `sh scripts/test-managed-native-fixtures.sh` | 1；永久拒绝后两次恢复均未轮询/领取，5 个目标断言失败 |
| Node 重跑故障 | 同上述脚本 | 127；执行期间修改了脚本，命令截断，不计 GREEN |
| Node 隔离 GREEN | `MANAGED_TEST_FILTER=testPermanentObservation sh scripts/test-managed-native-fixtures.sh` | 0；1 项通过 |
| Node 终态封存 RED / GREEN | `MANAGED_TEST_FILTER=testManagedTerminalHTTPReceipt sh scripts/test-managed-native-fixtures.sh` | 1 → 0；RED 为 bound 未封存及原观察/确认缺失，两个 HTTP 场景共 6 个断言失败 |
| 协议构建 | `npm run build:types` | 0 |
| Store + HTTP | `npm run test --workspace @missiongo/server -- src/managed-execution-store.test.ts src/managed-execution.test.ts` | 0；44 项通过 |
| 有效根 RED / GREEN | `MANAGED_TEST_FILTER=testManagedWorkspaceStartAndResumeShare sh scripts/test-managed-native-fixtures.sh` | 1 → 0；RED 仅隐式 cwd 被 resume writable roots 拒绝，显式同 cwd 通过 |
| 最终 Swift 直接编译 | `sh scripts/test-managed-native-fixtures.sh` | 0；90 项，1 项跳过，0 失败；包含 ManagedExecution、NodeLoop、APIClient 三组 |
| 全部 workspace | `npm run test --workspaces --if-present` | 0；Web 356、contracts 9、domain 39、server 420 项通过 |
| 完整 SwiftPM | `swift test --package-path apps/macos` | 1；manifest/Clang 系统缓存目录权限拒绝，未运行完整测试 |
| 综合检查（两次） | `npm run check` | 均为 1；lint、身份、macOS 契约、迁移、样式和类型构建通过，scripts 34/35，签名 fixture 的 mktemp 系统目录权限错误导致中断 |
| 类型检查 | `npm run typecheck` | 0 |
| 构建 | `npm run build` | 0 |
| 空白检查 | `git diff --check` | 0 |

日志保留于 TMPDIR 的 `and232-*.log`，不加入 Git 候选。

最终 Swift 脚本明确使用 `MANAGED_WIRE_FIXTURE="$TMPDIR/and232-wire.json"`，未设置 `MANAGED_TEST_FILTER`；唯一跳过项是 `testInstalledNativeStartAndResumeEvidence`，因为未设置旧原生证据输入。新增测试均实际运行。负例包含确认 intent/generation/sequence/终态/session/model 漂移、缺失字段、HTTP 409/503、网络断开；这些情况下 journal 原始字节保持。旧 `accepted:true` ACK 仅确认普通观察，不封存。终态封存测试使用尚未获知终态的旧 job，两次 Runtime 实例及后续观察均无旧 worker 启动或 turn。未跟踪且本轮修改的文件另做空白与本机路径检查，退出码 0。

## 本轮改动文件

- `apps/macos/Sources/MissionGoNodeCore/APIClient.swift`
- `apps/macos/Sources/MissionGoNodeCore/NodeLoop.swift`
- `apps/macos/Sources/MissionGoNodeCore/ManagedExecution.swift`
- `apps/macos/Sources/MissionGoNodeCore/ManagedExecutionRuntime.swift`
- `apps/macos/Tests/MissionGoNodeCoreTests/APIClientTests.swift`
- `apps/macos/Tests/MissionGoNodeCoreTests/ManagedExecutionTests.swift`
- `packages/domain/src/managed-execution.ts`
- `services/server/src/managed-execution-store.ts`
- `services/server/src/managed-execution-routes.ts`
- `services/server/src/managed-execution-store.test.ts`
- `services/server/src/managed-execution.test.ts`
- `scripts/test-managed-native-fixtures.sh`
- `docs/openapi.yaml`
- `docs/and-232-limited-repair-validation.md`

## 限制与交接

Hermes 仍需在独立副本补跑完整 SwiftPM 与综合检查，并负责真实成功 native workspace-write resume、原 threadId/模型回合核验和业务验收。HTTP 测试使用 Fastify app.inject；Node 消费其实际响应 fixture，未测试真实 TCP 传输、生产账号或业务服务。未知终态身份保留日志并拒绝确认；旧服务端未提供 terminal 确认时不会本地封存。目录校验是本机策略核对，不是文件系统竞态隔离证明；没有放松原生沙箱或 MCP 门禁。
