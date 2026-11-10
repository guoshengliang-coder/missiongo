# 发布范围与覆盖检查

「制品与账本一致」只证明包没有串版本，不能证明包包含本次应交付的修复。
默认发布当前产品内所有已开发完成、且已核实合并/集成的候选条目；每项登记的必需产物都要包含它的集成提交。
例如两条记录均要求 `web + macosApp`，即使旧 macOS 包仍与账本一致，单独部署 Web 也不能通过默认覆盖门禁。

## 候选清单

由已授权的 MCP 客户端调用 `list_release_candidates`，指定当前产品 ID、`includeUnscoped: true`，跟随游标收齐所有页。
只获取发布元数据，不扫描其他产品或读取客户端 OAuth 凭据。保存到仓库外的 JSON：

```json
{
  "pages": [
    {
      "requestedBeforeSequence": null,
      "productId": "product-id",
      "coverageVersion": 2,
      "generatedAt": "<保留服务端实际返回时间>",
      "candidates": [],
      "noReleaseItems": [],
      "noReleaseDeliveries": []
    }
  ]
}
```

以上为空清单格式示意，实际文件必须保留接口返回的全部候选和无需发布的记录。
第一页请求游标为 `null`，后续 `requestedBeforeSequence` 为实际传入值；有 `nextBeforeSequence` 时必须继续，空页也不例外。
范围未知或缺少集成依据的记录不会静默消失；显式无需发布的记录单独列出原因。

同一处理轮次允许多次集成，候选以 `itemKey + developmentEventId` 唯一，不能按条目去重。开发完成及待验证条目中所有尚未完整发布的交付都须收齐；部分发布不移除候选。候选修订、轮次、内容版本和各交付的产物范围保持独立，批量回写使用原始快照，不能把最后一份交付的范围套给其他交付。

升级连续交付服务端时，也须从新主线重新运行下文安装器以更新本机共享 `release-candidates.mjs`。旧解析器会拒绝同一条目的多个候选；不能通过删行绕过。安装器的备份、未知改动保护与发布锁保持生效，升级工具不等于获得发布授权。

## 首次启用

1. 先升级支持 `includeUnscoped` 的服务端和 Skill（5.31.2 起）。本机安装器要求一份新服务返回的完整清单，旧版结果不会被当作完整。
2. 迁移这次服务端时，先人工逐条检查当前产品的开发完成记录、集成依据和所有必需产物；不能把旧入口的制品一致性检查宣称为覆盖率已通过。发布授权仍沿用原规则。
3. 从新服务取得清单后，在最新仓库运行：

```sh
node scripts/enable-release-coverage.mjs --product-id <当前产品ID> --candidates /path/to/candidates.json --dry-run
node scripts/enable-release-coverage.mjs --product-id <当前产品ID> --candidates /path/to/candidates.json
```

安装器把当前仓库 origin 与该产品 ID 绑定在本机私有配置中，不包含登录令牌。
安装命令复用现有发布互斥锁，发布占用时立即退出；它只给现有统一入口、制品检查和部署脚本增加覆盖检查，保留原有签名、锁、备份、CI 和目标配置。
原文件有备份；未知入口版本、符号链接、产品绑定冲突或覆盖助手有未知修改时拒绝安装，不强行覆盖。
安装后的共享助手独立于 worktree，旧 checkout 也不能利用旧部署脚本绕过门禁。

## 规划与部署

```sh
missiongo-release plan --candidates /path/to/candidates.json
```

`plan` 只读线上元数据和本机制品，核实当前仓库的 PR/提交，列出每条记录缺少的产物和完整必需产物并集。
它不要求 CI 已结束，也不启动构建；`ready: false` 是需要补齐制品的计划结果。
认证失败、清单不完整或过期等输入错误仍会失败。
构建、版本提交、发布账本提交及合并保持原流程，所有相关制品在同一 worktree 保留到部署。

部署前刷新全量清单（所有页须在 15 分钟内），然后：

```sh
missiongo-release check --candidates /path/to/refreshed-candidates.json
missiongo-release deploy --candidates /path/to/refreshed-candidates.json
```

`check` 和 `deploy` 均要求目录干净、主线同步、CI 全绿及原制品校验通过。
部署脚本在任何生产写入前，用实际线上快照再次核对覆盖率。
每个必需安装包的实际来源必须包含对应集成提交；缺少来源或 Git 对象、范围未知、产品/仓库不符时阻断。
本机账本中写着某版本，不代表线上已有该包。

## 用户明确限定产物

只有用户明确要求局部发布时，使用以下两个参数，并沿用已有明确授权：

```sh
missiongo-release plan --candidates /path/to/candidates.json --only-artifacts web,linuxCli --scope-reason '用户明确要求本次只发布 Web 和 Linux'
missiongo-release deploy --candidates /path/to/refreshed-candidates.json --only-artifacts web,linuxCli --scope-reason '用户明确要求本次只发布 Web 和 Linux'
```

产物列表用逗号分隔。范围与理由同时必填，不接受隐式排除；它们会进入规划和最终对账输出。
仍使用全量候选文件，不能先删掉其他条目。混合产物条目会列出未覆盖部分，未满足全部必需产物时不进入待验证。
局部范围也约束实际产物变化。统一部署会部署当前主线 Web/Server；若用户只选 Linux、而 Web 来源或版本将变化，门禁会阻断，要求先取得包含 Web 的明确范围或使用已有的独立制品发布方式，不能暗中扩大范围。其他未选产物若将被新包替换，也同样阻断。

## 发布后对账

统一部署保留公开发布凭据和共享上报，随后基于实际公开产物重新输出逐条覆盖结果。
全量结果与用户选定范围分开报告，不能用局部范围掩盖其他产物未发布。
部署完成后覆盖不足会明确报错并保留真实发布事实，不伪造凭据、不盲目重发或回滚。
随后用 `get_item_context` 核对相关候选的实际状态；独立状态检查和共享自动交接已取消，发布观察上传不再推进条目。需要回写时由获授权的发布会话核实依据后调用 `submit_release_batch`：同产品、每批最多 100 条，绑定候选版本、开发完成事件和处理轮次，不要求其他开发会话的领取凭据。`scripts/release-notices.mjs` 输出稳定批次参数；先完整读条目和写发布评论，再提交批次。成功、已提交和跳过分别对账；相同参数与幂等键可重试，候选变化须重新核验并生成新批次。旧服务缺少能力或候选快照时不伪造参数，也不借用其他会话身份。
部署成功、待验证、通知送达各自报告，最终验收仍由人工决定。

## 已发布历史条目补证据

优先用 `supplement_release_evidence` 补齐后刷新服务端清单。旧客户端工具列表未更新但服务端已支持 5.54 时，可在已独立核实全部发布前置后给 `release-notices.mjs` 传 `--verified-evidence <JSON>`：对象含 productId、items，每项含 itemKey、原清单 expectedRevision/developmentEventId/roundKey、completion（GitHub PR）、完整 requiredArtifacts、verification 核验记录。原始 MCP 分页文件不得改写；脚本输出单列 verifiedEvidence，继续查询真实 PR 合并及公开产物来源覆盖，并生成原子补证据/交接请求。此文件仅用于已发布交接，不供部署覆盖门禁使用；不能将本地声明冒充服务端返回值或仅列已发布的子集。

## 无条目交付的覆盖（协议 2）

已合并的无条目改动与条目候选共用分页和产物覆盖门禁，以 `kind: "delivery"`、`deliveryId`、`expectedRevision` 标识；摘要、真实 PR 和完整 requiredArtifacts 供核验。不得为适配旧客户端过滤无条目记录。显式无需发布的交付独立列入 noReleaseDeliveries，保留原因。游标是服务端不透明值，空候选页也必须按 nextBeforeSequence 续读。

升级服务端后，从本主线重新运行共享覆盖安装器；旧解析器拒绝协议 2，保持阻断直到安装器验证并升级完成。本轮开发不自动安装共享工具或发布服务端。新解析器继续接受协议 1 的旧服务页，但协议 1 不允许携带无条目候选，不用旧格式冒充完整的新清单。

合并批次结束后，无条目交付仍参与后续产品发布：同样核验 PR 集成、构建来源、全部必需产物与用户明确的局部范围。部署后 `release-notices.mjs` 为这些候选生成 `submit_release_batch` 的 deliveries 请求（原 ID、revision、已核实 releases），而非条目评论或状态流转。部分发布继续留在候选，完整发布后才移出；正式发布凭据保留在原交付记录中，并供集成详情和批次收尾核对。条目候选仍按原流程完整读取、评论并交接，最终验收由人工执行。


## 部署前性能冒烟（AND-489）

合并本功能后仍须在已授权的本机执行安装器，正式入口才会生效。本任务不自动安装或发布。
统一安装器安装的版本化入口已自带性能钩子，后续升级不会抹掉它；首次仍需以下步骤配置私有备份目录。
安装器只给统一入口的 check/deploy 既有 preflight 后增加门禁，生产部署和回滚脚本不变。
它复用全机发布锁，保留 CI、干净主线和完整候选覆盖检查；锁忙、未知入口或部分安装直接拒绝。

```sh
node scripts/enable-release-performance.mjs --backups-dir <本机私有配置中的远端既有备份目录> --dry-run
node scripts/enable-release-performance.mjs --backups-dir <同一目录> --install
```

安装器把备份目录记录在私有 release-local.json，原入口和配置有备份；不将真实目标写进 Git。
候选 checkout 必须含本版本脚本和预算配置，缺少时阻断，不允许旧 checkout 静默跳过。
check/deploy 继续要求完整的 --candidates 清单；plan 与构建动作不运行数据库冒烟。

冒烟在开发机执行：只读选择远端最近完整备份，取得 manifest 和 SQLite，不取附件、不新建备份、
不打开生产在线数据库。传输、哈希校验、当前源码编译、应用初始化、测量和清理都计入 120 秒。
没有持久数据库缓存；超时、坏备份、权限或数据覆盖错误、校准失效及任何目标超预算都拒绝发布。
工作阶段预留 5 秒用于终止所属进程组和删除私有临时副本；清理失败不能返回成功。

临时库目录私有，应用只写工作副本，仅监听 loopback，使用临时签名材料和本地节点。
有历史交付的账号身份只在副本中用于覆盖真实关联读取，不使用其生产登录凭据；不消费生产节点队列。
通知 worker、AI 和推送均关闭，测量进程阻止非 loopback 网络连接。
报告只含代码/配置/备份摘要、聚合数量和计时，不含业务正文、账号或 token；备份不能上传到 CI 或条目。

共享 CPU 预算沿用 tests/performance/server-budgets.json，与 AND-488 同值、同算法；
HTTP wall 预算在同一配置显式区分单位。merge/列表沿用 CPU 校准；空闲 claim 使用独立 /health HTTP 基线，
有任务 claim 的尺度为 1/3 CPU 与 2/3 HTTP 混合。两份校准任一无效均阻断；报告列明各目标尺度及来源。
报告含实测值、有效与建议预算，建议不能自动放宽门禁。
claim-next 分别检查立即空闲、有受控任务和 2 秒长轮询；主动等待单独断言，不误判成处理耗时。
诊断 5 倍实验只在本机授权范围运行，不计为正常通过证据。配置变化需重新积累 CI 观察证据，CI advisory 不变。

本地 runner 通过、全机安装、正式 check 通过、实际部署及人工验收是独立事实；
未经实际入口和完整 CI/候选条件验证，不声称生产发布已被保护或正常生产发布已通过。
