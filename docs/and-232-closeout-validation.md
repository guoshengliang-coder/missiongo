# AND-232 本轮有限收尾验证

本轮仅处理获批的 A（HTTP 精确身份）、B（terminal ACK 后保存前退出恢复回归）、C（两处文档事实矛盾）。保留进入本轮时的第四候选改动，在原独立 worktree 内修改；未提交、改写 Git 历史、push、创建 PR、merge、deploy 或调用外部业务服务。Hermes 仍是唯一业务 writer。

已读取指定的 `trim-reproduction-result.json`、`final-review-verdict.json` 和 `reproduce-trim.mjs`，只将其作为证据。报告中的外部路径未被追踪访问。父代理原有 8 例真实回环 HTTP 复现是输入证据，不算本轮 GREEN。

## 本轮变更文件

| 文件 | 变更 |
| --- | --- |
| `services/server/src/managed-execution-routes.ts` | report 的 sessionRef/resolvedModel 使用独立无变换校验，首尾空白返回 400；其余入口仍使用原 text 校验。 |
| `services/server/src/managed-execution-closeout.test.ts` | 新增 8 例 HTTP 路由身份回归、真实 Swift 子进程拒绝重放及 ACK 后退出/重启回归；可显式选择真实 socket 模式。 |
| `scripts/fixtures/managed-terminal-process.swift` | 测试专用进程，复用 APIClient、StubURLProtocol、NodeAPI 和 ManagedExecutionRuntime；合法 ACK 解码并核对后 `_exit(73)`，产品代码无崩溃开关。 |
| `scripts/test-managed-native-fixtures.sh` | 可选编译并运行上述进程回归；原 XCTest runner 保留失败或零测试时非 0 退出。修改时脚本未运行。 |
| `docs/managed-execution.md` | 校正默认关闭仍回放/轮询但禁止新执行，以及精确身份的终态新序列观察可归档的描述。 |
| `docs/and-232-closeout-validation.md` | 本交接记录。 |

没有修改 Store 精确身份比较、摘要、终态、ownership 或 Node pending 规则；没有新增产品功能、生产运行控制或权限放宽。

## A：RED → GREEN

先添加测试，再修改产品校验。两个字段各覆盖前空格、后空格、前换行、后换行。每例同时覆盖终态仍持有占用、旧占用已清理且新意图持有占用两种情况，并验证：

- 首次迟到新 sequence 的坏身份拒绝；所有意图快照、观察记录和事件记录完全不变。
- 规范身份成功归档一个观察及一个事件，原终态和新旧所有权不变，保存的载荷等于提交值。
- 已提交 sequence 的空白异载荷拒绝；同 sequence 改 state 仍为 409；规范原载荷幂等重放成功且不增加记录。
- 原始坏身份直接调用 Store 仍拒绝，未放宽 Store。

最初命令因 domain 构建产物缺失退出 1，未执行测试；完成必要构建后，真实 socket 尝试被沙箱以 `listen EPERM` 拒绝，退出 1。这两次均不是有效 RED，未扩大权限或反复尝试监听。

改用 Fastify `app.inject` 完整经过 HTTP 解析、路由校验和 Store：修复前 8 例全部实际失败（预期 400，实际 200），退出 1；最小修复后连同相邻 Store/HTTP 回归，52 项通过，退出 0。没有把路由注入称为真实 socket HTTP。

## B：进程及验证边界

测试父进程保留同一个真实服务端 Store。Swift 子进程通过现有 URLProtocol seam 发出 APIClient 编码请求，测试管道把请求送入 Fastify 路由，原始响应交回 APIClient 解码。此管道仅为受限环境中的测试传输，不是产品控制通道。

退出位置是 APIClient 已返回并校验合法 terminal ACK、NodeAPI 包装尚未返回给 Runtime.flush 之间：服务端已归档观察，进程退出码为 73，本地原 pending 日志必须逐字节不变。随后启动全新进程，读取同一日志并重放同一观察，服务端幂等确认后 Runtime 持久保存 terminalReceipt/terminalObservation、清空 pending、递增 sequence。再次启动全新进程不得重复报告；claim/permit/launch/turn 一旦发生，测试进程会以专用非 0 码失败。

同目录加入损坏 JSON；回放批次必须报告其错误并继续封存合法记录，后续重启仍保留损坏文件原字节。另一个进程回归对全部 8 种空白身份各启动两次进程，要求服务端每次返回 400、pending 文件逐字节不变、服务端意图/观察/事件不变。

第一轮进程回归确实执行了子进程退出/重放，但两项测试因测试断言假设错误失败：APIClient 对错误响应抛解码错误；Swift 重编码省略 nil 字段及不声明的服务端时间字段。仅校正测试对这两种既有编码行为的断言，未改产品代码。最终结果见下表。

## 实际执行命令与退出码

命令均从仓库根目录运行。临时文件位于已忽略的当前工作树临时目录。下表不含本机绝对路径、真实服务端地址、实际监听端口或凭据。

| 命令 | 实际结果 |
| --- | --- |
| `npm run build:types` | 0；首次补齐缺失依赖产物，产品校验修改后再运行一次也为 0。 |
| `npm run test --workspace @missiongo/server -- src/managed-execution-closeout.test.ts` | 依次为：产物缺失退出 1；初始真实 socket 版本 EPERM 退出 1；路由注入版本有效 RED，8 例失败，退出 1。 |
| `TMPDIR="$PWD/.tmp-and232/closeout" MANAGED_WIRE_FIXTURE="$PWD/.tmp-and232/closeout/wire.json" npm run test --workspace @missiongo/server -- src/managed-execution-closeout.test.ts src/managed-execution.test.ts src/managed-execution-store.test.ts` | 0，52 项通过；同时生成现有 Swift wire fixtures。当时尚未加入两项子进程测试。 |
| `TMPDIR="$PWD/.tmp-and232/closeout" MANAGED_WIRE_FIXTURE="$PWD/.tmp-and232/closeout/wire.json" MANAGED_TEST_FILTER=Managed MANAGED_PROCESS_FIXTURES=1 sh scripts/test-managed-native-fixtures.sh` | 1；Swift XCTest 执行 27 项，26 通过、1 跳过、0 失败；随后两项新增进程回归因上述测试断言假设失败。 |
| `TMPDIR="$PWD/.tmp-and232/closeout" MANAGED_WIRE_FIXTURE="$PWD/.tmp-and232/closeout/wire.json" MANAGED_TEST_FILTER=ManagedTerminalHTTP MANAGED_PROCESS_FIXTURES=1 sh scripts/test-managed-native-fixtures.sh` | 0；选中的 1 项相邻 XCTest 通过；2 项真实子进程回归通过，其余 8 项因名称过滤跳过。拒绝场景共 16 次子进程启动；ACK 场景实际退出 73，后续两个新进程均退出 0。 |
| `node_modules/.bin/oxlint services/server/src/managed-execution-closeout.test.ts services/server/src/managed-execution-routes.ts` | 0。 |
| `sh -n scripts/test-managed-native-fixtures.sh` | 0。 |

最终通过 `task_git="$(xcode-select -p)/usr/bin/git"` 选择 Xcode 内置 Git，执行 `"$task_git" diff --check`，退出 0；另用 Node 对上述六个文件检查行尾空白及本机用户绝对路径，退出 0。未执行任何 Git 写入操作。

## 交给 Hermes 的未覆盖项

- 本轮沙箱不能监听回环 socket。Hermes 可用 `MANAGED_REAL_HTTP=1 npm run test --workspace @missiongo/server -- src/managed-execution-closeout.test.ts` 验证 8 例真实 HTTP；两项进程回归需要由上述 Swift 编译脚本设置可执行文件，否则明确 skip。
- 子进程回归使用真实进程、真实 Runtime/APIClient、真实路由与 Store，但传输是测试管道及 URLProtocol；没有声称验证了原生 URLSession socket 网络、OS 突然断电、fsync/rename 中途断电、原生 Agent 启动或完整后代进程清理。
- `testInstalledNativeStartAndResumeEvidence` 缺少独立真实原生协议证据而跳过；本轮不读取凭据、不启用真实 Agent。
- 未重跑已知受限的 SwiftPM/cache、签名系统临时目录检查及标准全量；标准全量由 Hermes 负责。
- 合成人工批准、合成 session/model 和测试账号只验证协议与恢复，不代表真实业务验收、工作条目完成或 AND-229 试运行。

本轮不继续扩展产品修复。
