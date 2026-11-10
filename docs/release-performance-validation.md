# AND-489 本地验证记录

范围：发布前性能门禁、共享预算与安装器。按照获批 v1 固定方案实施；CI 性能模式保持 advisory。
本记录不表示 PR 已合并、全机工具已安装或生产已发布。

## 正常与回归实验

2026-11-10 在开发机只读获取最近完整 SQLite 备份，约 110 MiB；不取附件。
备份创建时间为 2026-11-09T16:38:44Z。目标产品覆盖 496 个条目、10 个批次、44 个会话进展。
每次下载后验证摘要，再创建工作副本；临时应用仅监听 loopback，禁用外部调用。
每次实验都完成进程组收尾与临时副本删除。原始数据库不保留或作为附件交付。

| 实验 | 结果 | 总增量（含传输与清理） |
|---|---|---:|
| 正常备份冒烟 | 全目标通过，校准有效 | 22.0 秒 |
| 仅 merge-deliveries 5 倍 | merge CPU 和 HTTP 超预算，其他目标通过 | 26.4 秒 |
| 仅 item-list 5 倍 | 列表 CPU 和 HTTP 超预算，其他目标通过 | 37.8 秒 |
| 仅 claim-next 5 倍 | claim-next HTTP 超预算，其他目标通过 | 24.0 秒 |

正常实验归一化 CPU 中位数约为 merge 0.533ms、完整列表 1.321ms、summary 0.028ms；
归一化 HTTP 中位数约为 merge 2.622ms、轻量列表加 summary 16.147ms、空闲 claim 1.003ms、有任务 claim 1.667ms。
主动等待的 2 秒另行验证，没有算进处理延迟预算。

当前共享 CPU 预算为 0.8/2/0.09ms；HTTP 预算为 4/25/3ms。
这些是不同单位的显式配置，不是生产延迟 SLA；使用同一独立校准与目标判定实现。
初始配置在真实备份上测得 merge CPU 约 0.52ms、列表 HTTP 约 15.4ms，
因此不能沿用调查阶段临时的 0.5ms / 8ms 建议。增加的余量依据多次正常实测，
并通过逐目标回归隔离检验；没有在失败时自动放宽预算。
有任务 claim 比空队列更重，3ms allowance 覆盖其分组采样；单次冷请求另记，不冒充稳定中位数。

合成 fixture 保留 200 个条目、40,000 个历史事件和 20 个交付，将交付分布在 10 个批次，
并补足约 4KiB 的条目正文展示负载。调整是为覆盖物化展示数据的体积和关联，
不把旧的 1250/140ms 阈值当成当前开销。配置摘要变化，CI 观察证据按新摘要重新积累。

## 自动化覆盖

- 预算单位、范围与错误配置；校准、原始样本、建议预算和观察窗口契约。
- manifest 路径、格式、大小和摘要校验；相同体积但错误内容也必须拒绝。
- 超时终止 worker 及其后代；成功、错误、超时的临时文件清理。
- 远程 fetch、TCP、TLS、UDP 拒绝；真实 loopback HTTP 使用正常鉴权和业务路由。
- 合成备份运行真实 worker，覆盖列表、merge 历史、空闲/有任务 claim 与长轮询。
- 隔离安装器幂等、忙锁拒绝、未知/部分入口拒绝、备份及私有目标配置。
- 隔离 coordinator：失败的 check/deploy 都不能触发代表生产写入的 marker；通过的 check 也不写 marker。

安装器已对本机当前统一入口做只读兼容校验，未执行全机安装。
在主线 aff41bef 基线上，完整 npm run check 通过：199 项脚本测试通过，服务端 1439 项通过、2 项既有跳过；其他工作区测试、静态契约、类型检查及构建通过。最后串行性能进程通过，耗时约 19.4 秒。
最终提交以条目结果评论为准；报告不含业务正文、账号、真实目标或凭据。

## 剩余边界

这是一份备份快照和本机上的结果，不代表所有数据规模、机器或网络都可在 120 秒通过。
样本无效或耗时过长会拒绝发布；不能把失败直接归因为生产缺陷，也不能自动提升预算。

没有复现历史生产事故，没有对生产流量压测，也没有实际执行正常生产 deploy。
正式入口的效果还取决于合入后获授权的本机安装，以及完整 CI/候选覆盖条件下的 check。
本轮只有本地代码、测试和提交，不改变部署与回滚实现，不改变人工验收权限。

## 本轮审计与补修

对首版本地提交做故障审计，复现并修复以下三处缺口，沿用原批准范围：

| 级别 | 已复现问题 | 修复与验证 |
|---|---|---|
| P1 | 增量 TypeScript 构建保留被改写的旧 JS，可能测错候选代码 | worker 使用强制编译；微型工程先证明增量保留污染，再证明强制编译恢复源码产物，编译错误继续阻断 |
| P2 | 安装器覆写配置时中断，可损坏既有 JSON | 私有配置、入口和元数据改为完整写入、fsync 后原子替换；备份用无覆盖发布；部分写入/rename 失败保留旧内容并清理临时文件 |
| P2 | 声明 1 字节的样本仍会先传输实际 128 字节 | 远端打开后先校验 regular file 与体积，再按预期体积分块发送；错误体积在输出前拒绝，本地摘要校验保留 |

实际 Python 传输程序已在本地临时备份目录执行：正常内容一致；错误体积、符号链接均拒绝且不输出 payload；
FIFO 使用非阻塞打开，类型检查立即拒绝，不依赖全局 120 秒超时才收尾。

完整 `npm run check` 通过：202 个脚本测试、服务端 1439 项通过与 2 项既有跳过，以及其他工作区测试、
契约、类型、构建和最后串行性能测量均通过。最后扩展的备份无覆盖保护又随全部 202 项脚本回归通过；lint、diff 检查通过。

为防止并行脚本测试互相重写共享 dist，HTTP/备份集成子进程使用测试前已构建的代码，
仅该测试进程替换编译步骤；实际强制编译在独立临时 TypeScript 工程验证，真实备份实测仍执行完整强制编译。
没有新增生产运行时跳过编译开关，没有放宽任何预算或期限。

本轮补修后的精确提交、强制编译实际耗时和真实备份清理结果以原会话结果评论及独立审计报告为准；
首版 23.4 秒实测不充当补修提交的实测。仍未安装全机工具、未推送/合并/发布，也未验证实际生产 deploy。

### CI Node 22.13 兼容复核

审计补修中新增的预构建隔离测试，以及既有可选诊断 loader，使用过 `module.registerHooks`。
该同步 API 从 Node 22.15 才提供，而 CI 固定 22.13.0；本机 22.23.2 的通过不能替代最低版本证据。
已统一改用兼容的 `module.register` 异步 loader，诊断转换逻辑独立保留且仍仅显式启用。
版本依据：[Node 官方 API 历史](https://nodejs.org/api/module.html#moduleregisterhooksoptions)。

使用官方归档与 SHASUMS256 校验的临时 Node 22.13.0，未替换系统运行时：
13 项定向测试通过，随后完整 `npm run check` 通过（203 个脚本测试，服务端 1439 通过、2 项既有跳过，
其他工作区、契约、类型和构建通过，最后串行性能测量约 16.2 秒）。诊断 loader 行为回归证明普通运行调用 1 次、
显式诊断进程调用 5 次。报告新增 node/platform/arch，以记录实际运行时。

三处运行时补修提交 9d14ea0e 的真实备份复测通过：22.9 秒，强制编译准备约 0.9 秒，所有目标通过并删除临时副本。
最终兼容提交和旧版本运行时下的真实备份结果继续单独记录，不改写上述历史证据。

### HTTP 校准漏检及最终审计

新增 P1：在 CI 的 Node 22.13 上，CPU 校准不能反映更快的 HTTP 传输，五倍空闲 claim 回归仍落在旧有效预算内。
该次诊断虽非零退出，但只是诊断禁止发布保护，不能算检测到目标回归，历史报告保留为漏检证据。

release 配置升至版本 2，新增独立 `/health` HTTP 基线。空闲 claim 使用 HTTP 尺度；有任务 claim 使用
三分之一 CPU、三分之二 HTTP 尺度，两种校准均须有效。其余目标继续使用原 CPU 尺度。
所有目标数值预算保持不变；配置摘要改变，旧摘要下的观察窗口不能冒充新配置证据。
诊断报告仅在校准有效且指定目标实际超预算时记录 detected，保护性退出或无效校准记录 not_detected。

Node 22.13 / 22.23 串行真实备份验证分别得到：正常通过 23.5 / 22.8 秒；五倍空闲 claim 在
22.6 / 25.5 秒由该目标实际超预算检出。两种基线有效，其他目标通过，临时副本均清理。
这些结果来自提交前代码，最终精确提交复测另记在固定审计文档和结果评论。

最终完整 Node 22.13 `npm run check` 通过：204 项脚本测试、1439 项服务端通过、2 项既有跳过，
其他工作区、契约、类型、构建与串行性能检查通过；lint 与 diff 检查通过。
本轮共修复 2 项 P1、3 项 P2；未推送、合并、安装全机入口或发布，条目继续处理中。

## 第二轮审计：统一安装器集成

刷新主线至 bc01562f 后，本地纳入最新统一发布工具实现，在任务隔离分支核对兼容性。
主线新增版本化 missiongo-release.py 与 install-release-tools.mjs，而首版性能钩子只升级机器上的入口：
统一安装/升级可能把它替换成没有性能检查的入口（P1）。已把同一受审钩子纳入版本化入口，
升级器对该入口保持幂等；真实入口的隔离测试证明 check/deploy 失败均到不了生产动作 marker。
备份目录仍须在私有配置中显式配置，缺少时拒绝；plan 和构建不受影响，没有实际全机安装。

另复现 P1：安装器比较磁盘文件与旧清单摘要，而未比较新源码。安装旧版本后仅更新源入口，
dry-run 错报无变化，实际安装可留下旧入口却记录新摘要。新增回归先复现失败，修复后比较当前源文件
与已安装内容；覆盖 dry-run 不写、实际升级、重复幂等及原有人工回退重装。

本轮不改变性能配置、目标预算、120 秒、数据限制或生产部署与回滚实现。
复核该新增统一安装路径还发现 P2：写入未取得发布锁，且仍直接覆写入口和清单。
CLI 已先取得同一 OS 锁，实际持锁子进程实验验证忙锁退出 75、没有进入安装；写入复用已验证的
原子写入和备份无覆盖 helper。保护是单文件原子替换，不是多文件事务；失败后需重试完成安装。
完整检查与精确提交真实备份复测结果另记于固定文档和条目评论；未推送、合并到主线或发布。

## 第三轮审计收尾（最多三轮）

本轮按已有两轮计数，为第三轮，不自动新增第四轮。主线仍为 bc01562f。
三项行为回归先复现失败：自定义配置目录被忽略、未知参数被当作安装、导出函数的默认工具映射失效。
已统一安装配置与共享锁的 XDG 根目录，要求绝对路径；CLI 仅接受无参数安装或单个 --dry-run，
其他参数在取锁/写入前拒绝；CLI 和导出函数共用同一默认文件映射。
预算、120 秒、生产部署/回滚逻辑和前两轮补修保持；结果及本地提交详见最终固定审计记录。

## Integration repair: installed module dependencies

The batch integration reproduced a real `missiongo-release plan` startup failure:
`release-receipt.mjs` could not load its installed Linux helper. An isolated
installation also failed to load preflight/receipt because their transitive
modules were omitted, and installing the repository handover forwarding module
would still point outside the installed tools directory.

The installer now includes Linux, coverage, candidate and handover dependencies,
using the self-contained public handover implementation under its installed name.
Guard reachability follows references from the coordinator/deploy through installed
modules; the original lock and guard rejection tests remain. All source files,
including the public implementation, must be tracked and clean at installation.
The new isolated-install test imports both actual installed modules and failed
before the repair; all 14 installer tests pass afterward. This does not constitute
production deployment or formal installation evidence; final batch checks and the
actual installation remain separate.
