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
不打开生产在线数据库。AND-505 的 release v3 合同分别限制准备120秒（发现、传输、校验、强制编译）、
测量120秒（含应用初始化）及清理5秒，总上限245秒；CPU/HTTP目标阈值和校准不变。
压缩传输为单路流式gzip，远端只读现有文件，本地解压同时计算原始长度与SHA-256，校验一致才复制工作库。
报告保留备份目录/文件身份、创建时间、原始长度/摘要及传输字节数，不保留压缩包。
没有持久数据库缓存；超时、坏备份、权限或数据覆盖错误、校准失效及任何目标超预算都拒绝发布。
阶段进度由worker原子落盘，父进程监督准备、测量和总期限；即使同步操作卡死，也能记录最后阶段并杀完整进程组。
清理使用独立受管进程，超过5秒、无法删除或被取消均不能返回成功，cleaned字段按实际目录是否消失核对。
不可捕获的断电或整个父进程被SIGKILL不保证自动收尾；残留私有目录不得作为下次运行的缓存。
单份备份上限512MiB；解压输出不能超过manifest长度，压缩输入也有显式上限。
临时数据总量限2GiB：工作库限制SQLite页数并为原始库/日志留余量，父进程每25ms检查整个临时树。
超限即终止，不等工作完成才检查；目录采样存在一个检查间隔的发现延迟，不宣称是操作系统磁盘配额。
编译产物和已安装依赖不属于临时数据库额度。

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


## 逐交付冻结范围（AND-503）

全量发现与本次交付承诺分开；原始 MCP 分页文件不得过滤或改写。未提供范围文件时继续原有严格全量检查。
使用当前 checkout 的工具生成默认全部纳入的独立文件（仓库地址和 HEAD 使用本机已核实值）：

```sh
node scripts/release-candidates.mjs --create-selection --candidates /path/to/full-pages.json --repository <GitHub-repository-URL> --head <full-planned-SHA> --output /path/to/new-selection.json
missiongo-release plan --candidates /path/to/full-pages.json --selection /path/to/new-selection.json
```

生成命令使用独占创建，不覆盖既有文件；文件存放在工作区外。人工或获授权执行会话审阅全量候选后逐项记录：

| disposition | 行为与约束 |
|---|---|
| include | 默认纳入，来源、HEAD祖先、必需产物、制品来源仍严格校验 |
| unmerged | reason 记录实时未合并依据；运行时再次核实，已合并或读取失败不能跳过 |
| historical_gap | 仅缺少集成引用或发布范围的历史记录；reason 说明为什么不属于当前交付及待补证事项；保留可见告警 |
| deferred | 暂不交付须非空 reason 和 authorization（用户明确决定原文），不能由执行者自行排除已知更新 |

条目 identity 为 itemKey:developmentEventId，旧缺事件记录为 itemKey:legacy，无条目为 delivery:deliveryId。
全部候选恰好出现一次；产品、仓库、计划提交、完整候选内容摘要必须匹配。新候选、删除、版本或范围变化均拒绝旧文件；刷新 generatedAt 不改变同内容摘要，但部署全部分页仍不得过期。
逻辑排除不能从构建中移除已合并代码；它只限制本次交付承诺和交接，不证明该功能没有上线。选中产物的质量、来源、CI、迁移、备份、健康和恢复门禁均不变。

check、deploy 使用同一 `--selection`，并必须携带 plan 输出中 `coverage.selection.digest` 对应的 `--selection-digest <SHA-256>`；发布后 release-notices 同样必须带原摘要。摘要绑定全部处置、理由与用户决定，变更后须重新规划，不能沿用旧摘要。显式 null、false 或非对象清单拒绝，不退回默认全量发布。部署前真实快照和部署后对账继续校验。已安装旧工具不会因 Git 合并而自动升级：后续获授权安装需运行版本化 install-release-tools 或 coverage 安装器，未知修改保护和发布锁保持。
部署日志需完整落盘；JSON 对账保留完整 selection 与 digest，并关联 receiptDigest。随后执行 `release-notices.mjs --receipt <receipt> --candidates <same-full-pages> --selection <same-selection> --selection-digest <reviewed-digest>`，只为 include 且实际公开产物满足全部要求的交付生成交接；排除理由仍在 selection 中。
HEAD 改变（包括版本或账本提交）后重新生成并审阅范围，不能通过改旧文件的 plannedCommit 来伪装已核查；旧原始页与范围文件连同发布回执保留为工作区外审计资料，不提交动态业务数据。


范围摘要是内容一致性检查，不是人工批准或新的发布授权。仅 plan 允许首次传入范围文件而不带摘要以供审阅；执行与交接缺摘要、摘要改变或摘要无对应文件均拒绝。摘要原样穿过 coordinator 和 deploy guard，避免检查后改写处置被后续阶段静默采用。

## 集成启动就绪报告（AND-507）

先在原集成会话核对账号、批次和最新主线，取得当前产品完整候选页（包括无需发布项），
将完整 `get_merge_batch` 返回值和完整分页分别保存到仓库外。调查开始、编排计划之前运行：

```sh
missiongo-release readiness --candidates <full-pages.json> --batch <batch.json>
```

`--batch` 接受 `{ "batch": ... }` 或完整 batch 本身，不接受挑选后的 entries；
productId、repository、deliveries 与每个 executionHead 必须相符。多条目、多份交付不能丢失。
旧正式入口尚无该动作时，允许从当前 checkout 运行
`node scripts/release-readiness.mjs --candidates <full-pages.json> --batch <batch.json>` 做只读调查，
不能据此自动安装或绕过正式 plan/check/deploy。没有发布授权也能调查，但不构建、安装、部署。

报告分别收集主线新鲜度、正式工具实际文件/安装清单/主线摘要、线上元数据、
各产物可用来源、全量覆盖、历史缺证、版本缺口、patch建议、两个客户端发布说明缺口，
以及本批冻结head的预计影响。独立检查失败不遮蔽其他检查；错产品/仓库、不完整分页及批次拒绝。
`checks[].status=unverified` 保留原因与下一步责任；`observed` 仅表示已得到检查结果，
其中仍可包含 `ready:false`、版本阻碍、工具差异或缺失说明，绝不代表发布就绪。
`needsFollowUp`汇总需继续处理的事实，退出非零也须读完整JSON；退出0同样不是发布许可。工具差异是待核查事实，不能仅按提交先后推断兼容。

报告固定本次checkedAt、实际head/originMain、批次修订与内容摘要、完整候选摘要；
不会写版本、账本、selection、业务数据、全机工具或生产环境。候选之外的冻结PR仅用于前瞻，
不算已集成候选，不提供正式产物来源。未知Git对象/缺工具保留缺口，不自动fetch任意PR或猜测。
只读Git/SSH/GitHub查询沿用户现有权限，原始JSON应留在仓库外，不提交动态业务正文。

前瞻报告后在原批次记录依赖、顺序和组合验证。实际全部合并后刷新主线、候选及release:state，
一次用既有release:bump-patch准备当时已知必要patch，并为实际改动补齐发布说明。
首份版本PR应包含这些已知要求；后来新候选或主线变化仍需重新对账，不能承诺永无后续PR。
部署前仍取得实时候选、CI、精确head、selection摘要并通过全部原门禁，不能跨head复用调查快照。

## 原会话逐项交付报告（AND-508）

```sh
missiongo-release report --input <bounded-evidence.json> --format markdown
```

默认输出JSON；format仅接受json或markdown。报告checkout的HEAD须等于已刷新且与远端实测一致的origin/main，不能把未集成工作分支当目标主线。旧安装可从当前checkout运行
`node scripts/delivery-report.mjs` 同名参数。只读脚本不调用MissionGo写工具，不获取MCP令牌，
不执行输入中的命令或读取输入指定的目标文件；不会自行安装或作验收决定。
调用方必须先按Skill读取、核实原始证据，不能把AI文字或布尔“完成”字段当作凭据。

输入为schemaVersion=1、productId、repository、实际head、完整scope身份数组及items数组。
scope由原授权范围与本次授权候选逐份列齐，不能只选择成功项；每个身份恰有一行，不同开发事件不能去重。
脚本验证scope/items一一对应，不能替调用者证明其给出的scope已经涵盖全部原授权对象。
每行含identity、productId、completion、requiredArtifacts（未知用null）、itemStatus、remainingVerification；
明确无需发布用requiredArtifacts=[]与noReleaseReason。未包含项另有included=false和exclusionReason，
保留可见，不从产物中移除已合并代码。itemStatus沿读取到的实际业务状态，不按发布结果生成。

产品发布输入可附原始 `release-receipt.mjs` receipt。报告独立核查当前仓库PR/提交集成及祖先关系，
仅使用receipt公开校验通过的产物、版本与来源；Web提交须与deployedCommit相符，
每个必需产物来源包含集成提交才计完整发布。输出计算receiptDigest，不要求调用方给原始回执添加字段。
脚本沿用原回执的公开核验结果，不重新下载所有公开包；执行者仍负责在当前交付阶段核实原回执真实适用。
人工移待验证/已完成、过程“发布成功”文字和批次结束不能替代凭据。

本机行completion.kind=local_change，evidence沿原领域证据（version=1、target、files、validation等）。
如实际完成限定环境安装检查，另提供localVerification：同一target、checkedAt、files[{name,sha256}]，
以及entryCheck{result,method,evidence}。摘要必须逐文件匹配原afterSha256（删除为null），
原检查全部通过且实际入口成功，核验时间15分钟内，才标“本机已生效（执行端核实）”。
缺证、文件不符、失败/未运行、过期或仅有通用测试，一律生效待核实；不读取任意本机路径来补造证明。
这份localVerification是执行端核查声明，不是脚本独立安装或操作系统证明；必须保留环境、时间与限制。

输出“对象/结果/证据与验证缺口/下一步责任”四列，并分别保留代码合并、产品完整/部分发布、
本机效果、未包含、人工状态及通知未核实。local_change的Git合并标为不适用，不误报代码漏合并。
全部必需产物缺口、remainingVerification与limitations不因成功摘要消失；最终验收始终由人工决定。
等待CI汇报阶段变化、失败与待决事项，无变化降低轮询，仅必要时简短保活；
不反复输出任务计数和全量日志，不改写或隐藏原生历史消息。

AND-507/508审计补修：readiness的所有版本来源告警都要求后续核查，包含非阻断性告警；空批次、重复产物、
缺少原因的无需发布范围拒绝。报告绑定本机release-coverage配置的产品/仓库，GitHub读取前后均核对
HEAD、本地main与远端main；期间变化不能输出成功结果。同PR多份交付复用一次集成事实，避免重复查询。
Markdown证据对反斜线、竖线与格式字符作安全编码，不能把证据挤入下一步责任列；裸URL仍按公共Markdown阅读器处理。
统一入口原样传递只读助手输出，同时拒绝提前exit(0)导致的空/无效JSON或缺失Markdown结构；
有完整报告但退出非零时仍保留原报告和失败状态，不将调查失败改为成功。
