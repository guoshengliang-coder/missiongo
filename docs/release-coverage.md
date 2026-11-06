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
      "coverageVersion": 1,
      "generatedAt": "<保留服务端实际返回时间>",
      "candidates": [],
      "noReleaseItems": []
    }
  ]
}
```

以上为空清单格式示意，实际文件必须保留接口返回的全部候选和无需发布的记录。
第一页请求游标为 `null`，后续 `requestedBeforeSequence` 为实际传入值；有 `nextBeforeSequence` 时必须继续，空页也不例外。
范围未知或缺少集成依据的记录不会静默消失；显式无需发布的记录单独列出原因。

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
