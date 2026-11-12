# 从仓库安装本机发布工具

本机统一发布入口 `missiongo-release` 和共享锁、CI、预检、覆盖率守卫以前只在某一台机器上维护，
与仓库里的 `scripts/` 会各自演进。现在这些工具全部位于仓库 `scripts/`，由下面的命令安装到本机，
两者不再分叉。

```sh
node scripts/install-release-tools.mjs --dry-run   # 只列出会写入哪些文件
node scripts/install-release-tools.mjs             # 实际安装
```

安装位置与本机手册（`~/.config/missiongo/AGENT-RELEASE.md`）一致，不改动调用方式：

| 来源 `scripts/` | 目标 |
| --- | --- |
| `missiongo-release.py` | `~/.local/bin/missiongo-release` |
| `deploy.sh`、`release-timing.sh`、`release-coverage-guard.sh`、`release-status.sh` | `~/.config/missiongo/release-tools/` |
| `release-lock.py`、`release_coverage_options.py` | 同上 |
| `release-preflight.mjs`、`release-receipt.mjs` | 同上 |
| `release-ci.mjs`、`release-ci-wait.mjs` | 同上 |

规则：

- 只在 `HEAD` 包含 `origin/main` 且 `scripts/` 无未提交改动时运行；每个文件都必须在 `HEAD` 中存在。
- 参数只接受无参数（安装）或单个 `--dry-run`；拼写错误、重复或未知选项在取锁及写入前拒绝。
- 配置与锁统一使用绝对 `XDG_CONFIG_HOME`，未设置时使用 `~/.config`；入口仍位于 `~/.local/bin`。
- CLI 在读取安装状态前取得同一共享发布锁，锁忙退出 75；不得与发布或其他安装同时写入。
- 目标位置若已有非常规文件或符号链接则拒绝，不覆盖。
- `deploy.sh` 与入口合起来必须仍引用全部共享守卫，入口必须仍经过 `release-lock.py` 加锁，否则拒绝安装。
  安装后的 `deploy.sh` 从 `$MISSIONGO_RELEASE_TOOLS` 调用收据与状态守卫，不读仓库工作区里的副本。
- 安装前检查 Python 与 bash 语法；旧版清单里的 `globalRulesIdentical` 字段会被忽略，其他未知字段仍然拒绝；写入前比较仓库源文件与磁盘上的实际内容，
  只替换内容变化的文件，每个被替换的文件首次备份为 `<文件>.before-release-tools-in-repo`。
  单文件完整写入并 fsync 后原子替换，备份发布不覆盖已有文件；中途失败可重试，不宣称多文件事务回滚。
- 私有目标参数（`release-local.json`、`release-coverage.json`、凭据与签名文件）不在仓库中，
  安装脚本不会创建或修改它们。

仓库 `scripts/deploy.sh` 直接运行会要求 `MISSIONGO_RELEASE_TOOLS`，避免绕过统一入口；
发布一律通过 `missiongo-release check|deploy --candidates ...` 执行。

版本化入口自带阻断式性能冒烟，统一安装/升级不会移除它。首次安装后仍须按
`docs/release-coverage.md` 的性能安装步骤配置私有备份目录；未配置时 check/deploy 明确拒绝。
升级比较当前源码，而不是只与旧清单比较，避免新门禁未写入却更新了清单摘要。

The installation also carries the transitive Linux, coverage, candidate and
handover modules used by preflight/receipt. The public handover implementation is
installed as `handover-evidence.mjs`; its repository-relative forwarding module is
not copied. The public implementation must be tracked and clean alongside scripts.


## 安装后正式入口的安全演练（AND-506）

`npm run test:scripts` 先运行脚本单测，再串行运行
`node --test tests/release/installed-entry.e2e.mjs`。后者从临时Git仓库/worktree
执行真实安装CLI，安装完整工具集，再从含空格的worktree子目录调用安装后的
status、plan、check和deploy。真实编译和性能测量仅使用合成备份；不会改动全机安装。
串行是为避免性能计时及生成dist与其他脚本测试互相影响。

外部SSH、GitHub和rsync由受控代理提供响应，未知命令拒绝，不使用真实目标或凭据。
锁、CI、覆盖、版本和性能的正式代码均保留，不用替换模块来伪造通过。
演练检查完整规划输出以及版本/账本未写入、候选/选择摘要/局部范围参数传递、
真实忙锁和各门禁失败退出；向临时副本注入缺间接模块、导入提前退出及旧路径定位
缺陷，证明测试能抓住三类历史回归。

成功check不能触发生产动作。deploy演练在首次rsync写入边界由代理拒绝，
断言边界只到达一次、没有后续备份或容器更新。禁止跳过备份/CI及脏目录的参数仍拒绝。
这不是生产部署、真实备份或真实网络性能证据，也没有新增生产跳过门禁开关。
本地需要允许loopback监听；沙箱禁止监听时应明确报告环境限制。

演练还发现并修复私有路径传递缺口：协调入口将已配置的currentLink、downloadsDir和backupsDir
显式传给installed deploy，不再让后者使用不同默认值。命令行覆盖这些路径以及data-dir仍拒绝；
不允许通过参数跳过备份、CI或工作区检查。逐目标五倍退化实验使用20个历史批次、400个条目的
受控数据，目标须实际超预算才记detected；保护性非零退出不算检出。

AND-507/508：安装清单由 `scripts/release-tool-files.mjs` 统一声明；安装与只读就绪检查共用固定文件集合。
新增readiness、report及间接模块仍由同一版本化安装器、锁和摘要保护安装。
Git合并不等于正式入口更新；本轮开发不自动安装。新旧工具差异可先用checkout内readiness只读核对，
获授权安装后再核实正式入口和清单摘要。调用与证据边界见 [发布范围与覆盖检查](release-coverage.md#集成启动就绪报告and-507)。

只读readiness/report的协调入口也核对助手输出完整性；子进程exit(0)但没有报告不再算成功。
校验不转换或重新生成正文，非零退出时原stdout/stderr继续保留；正式部署、CI、备份和性能门禁不变。
