# CI 性能与耗时报告

## macOS 编译缓存

`macos-build` 使用 `actions/cache` 保存 `apps/macos/.build`。测试和通用架构打包仍每次执行，
不缓存签名后的 App、ZIP、发布元数据或凭据，也不把 CI 包当作正式发布制品。

缓存前缀按 Swift、Xcode、SDK、macOS 版本、架构、开发工具目录、checkout 目录和构建配置隔离。
完整键还包含所有受 Git 跟踪的 macOS 文件、产品声明和打包/签名脚本的内容与权限。
同一工具链允许恢复旧输入的编译中间文件，由 SwiftPM 决定增量重建；工具链变化则冷构建。
PR 只恢复缓存；仅成功的主分支/手动构建在完整键未命中时保存缓存。

`macos-ci-cache.mjs restore` 在构建前准备输入时间戳：内容摘要及权限完全相同的当前受跟踪文件
可恢复缓存记录的时间；新增或变化的文件使用当前时间。冷构建也把时间规范到整秒，避免归档、
文件系统和 Node 往返造成精度漂移。缓存记录中的其他路径不能写入 checkout。
损坏或缺失时间戳记录退回冷输入。每次成功编译后、保存缓存前记录输入快照。

首次主分支运行会填充缓存。确认效果时，应在相同工具链和相同构建输入下再次运行 CI，查看
`Restore Swift build cache` 的命中信息，并对比测试、打包、恢复与保存步骤的总耗时。
命中缓存不代表测试通过，也不保证 runner 工具链更新后仍命中。

## 自动耗时报告

每次 CI 结束后，`ci-timing-report` 在自己的 Job Summary 输出：

- 各 job 的结果与运行时长，包含原生平台检查；
- 各 UI 分片的测试数量与整组耗时；
- 最慢的 UI 文件及测试尝试总耗时。

下载 `ci-timing-summary-<attempt>` 制品可取得 `summary.md`、`summary.json` 和各分片原始 JSON。
JSON 也包含各 job 的步骤耗时，可比较 macOS 编译、容器启动与实际测试时间。
Job 时长包括 setup/teardown；文件时长只累加测试尝试，不能直接与 job 时长相减来推断全部构建开销。
制品保留 14 天；现有行为报告和截图制品保持原位置。

汇总通过只读 Actions API 获取当前运行尝试的 job 数据，不增加仓库写权限。
UI reporter 只记录仓库相对文件位置、测试 ID、时长、状态和重试次数，不复制测试输出、
附件、账号夹具或环境内容。报告不更改原有构建/UI 门禁，也不自动写回权重。

只有全量 UI、当前提交/运行尝试、所有分片和视觉报告齐全、文件分配匹配、无失败/重试/跳过，
且已收集的 CI jobs 均成功或按计划跳过时，`eligibleForWeights` 才为 `true`。
失败、取消、只重跑失败任务、API/制品缺失及定向测试均明确标为不可用样本。
刷新 `tests/ui/audit-durations.json` 时仍需审阅多次完整成功样本，保留来源运行 ID。

本机可用 `MISSIONGO_UI_TIMING=1` 运行既有 Playwright 命令，在被忽略的 `ci-timings/` 下生成原始文件；
本机独立运行没有 CI 身份与完整计划，不会成为权重样本。

## 发布分阶段计时

发布脚本会把预检、上传、制品继承、备份、构建并重启、切换版本、下载制品发布、清理、
可选安全验证和公开回执验证分别计时。跳过的备份、清理与验证明确记为 `skipped`；
没有执行的下载制品发布不产生阶段记录。失败或中断时记录当前阶段及原退出码，后续步骤仍停止。
`build_and_restart` 对应现有的一次 Docker Compose 调用，包含构建和重启，不能拆成两项推算。

默认 JSON 写入 `${XDG_STATE_HOME:-$HOME/.local/state}/missiongo/release-timings/`，文件权限为 600；
可用 `MISSIONGO_RELEASE_TIMING_DIR` 指定其他目录。报告仅含提交、秒级时长、阶段和结果，
不包含命令、输出、主机、凭据或目标路径。人可读摘要和报告位置输出到 stderr，原有回执 stdout 不变。
目录不可用或写入失败只警告，不改变发布结果。SIGKILL 或整机断电无法保证最终报告完整。

本机统一入口使用独立安装的发布脚本，仓库改动需要通过以下局部升级激活：

```sh
node scripts/enable-release-timing.mjs --dry-run
node scripts/enable-release-timing.mjs --install
```

安装器共用现有 OS 发布锁；锁忙返回 75，不修改安装文件。首次修改前备份原脚本，
只插入计时标记并安装计时 helper；保留锁、CI、候选覆盖、制品继承、签名和公开回执规则。
未知脚本版本、已有 trap、部分安装或未知 helper 修改均停止，要求先审阅；重复安装不重复插入。
安装不会构建或发布。计时从 deploy 脚本内部预检开始，不包括外层协调器的取锁与预检耗时，
也不包括事先独立执行的 Android/macOS/Linux 制品构建。真实耗时需在下一次获准发布后读取。

## 更新 UI 分片权重

从 GitHub 下载至少两次独立、完整成功 CI 的 `ci-timing-summary-<attempt>`，分别保存到独立目录。
只使用可信 Actions 制品；汇总 JSON 本身不是签名证明。工具再次核对全量模式、成功门禁、
八个分片、测试计数、正数耗时和当前受跟踪测试目录。缺失/新增/删除测试导致目录不一致时拒绝，
需重新采集完整样本；同一 run 的多次 attempt 不能充当独立样本。

```sh
# 默认只预览：候选权重在 stdout，来源和分片对比在 stderr
node scripts/update-ui-weights.mjs \
  --report ci-timings/run-a/summary.json --report ci-timings/run-b/summary.json

# 可先生成不覆盖已有文件的候选 JSON
node scripts/update-ui-weights.mjs \
  --report ci-timings/run-a/summary.json --report ci-timings/run-b/summary.json \
  --output "$TMPDIR/ui-weights-candidate.json"

# 审阅后显式更新唯一的跟踪文件，再查看 git diff
node scripts/update-ui-weights.mjs \
  --report ci-timings/run-a/summary.json --report ci-timings/run-b/summary.json --write
git diff -- tests/ui/audit-durations.json
```

`--write` 仅更新 `tests/ui/audit-durations.json`，拒绝覆盖该文件已有的暂存或未暂存修改。
工具不提交、不推送、不合并；其他跟踪文件和符号链接不能作为候选输出。权重取多次文件耗时均值，
保留到 0.1 秒及来源 run ID。分片前后对比都使用这批新估计，表示分配模拟，不承诺 runner 排队、
容器准备或整个 CI 的同等缩短。更新后仍需完整 CI 验证，不能减掉测试或放宽门禁。

本次刷新采用运行 `42001907428` 与 `42003185229` 的完整成功报告，补齐 4 个新增文件。
按该批文件时长模拟，最重分片从 412.6 秒变为 339.2 秒；后续实际运行可能不同。
