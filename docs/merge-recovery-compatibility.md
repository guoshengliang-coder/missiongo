# 工具目录未刷新的原批次恢复

服务端新增恢复工具后，运行中的客户端可能仍持有旧工具目录。兼容入口不要求重建会话、复制 OAuth 凭据或重建批次。新增工具可用时仍优先使用新增工具。

`get_merge_batch` 原参数不变，新增只读 `recovery`（与 `get_merge_reconciliation` 相同的预览）和 `recoveryTransport`。先读取原批次、修复预留、历史结果，再核实实时 Git 与实际目标分支的本地组合检查。

兼容传输使用已有 `record_merge_integration` 的 `progress` 参数形状，仅适用于具有集成授权的批次：

```json
{
  "kind": "progress",
  "deliveryId": "原批次交付 ID",
  "expectedHead": "该交付当前 executionHead",
  "phase": "investigating",
  "detail": "missiongo.merge-recovery.v1\n{\"operation\":\"request\",\"snapshot\":\"预览快照\",\"action\":{\"kind\":\"retry_handover\",\"deliveryId\":\"原批次交付 ID\"}}"
}
```

外层仍提供原 `batchId`、原 `dispatchId`、当前 `expectedRevision` 和稳定 `idempotencyKey`。detail 必须以完整协议标记开头，后接严格 JSON；普通进度文字不解释为命令，错误协议内容直接拒绝。

| operation | 参数 | 行为 |
| --- | --- | --- |
| `request` | `snapshot`、现有恢复协议的 `action` | 保存待人工审阅请求；请求 ID 为外层幂等键 |
| `apply` | `requestId` | 执行该原批次已获人工批准且仍有效的请求 |

request.action 复用现有动作及完整证据结构，包括 accept_merge、retry_handover、retry_blocked 和发布取舍。涉及交付的动作必须与外层 deliveryId 相同。没有 approve 动作，不执行 Git，也不提供任意字段写入。

人工仍在“查看对账与恢复”核对具体快照并批准。兼容调用复用相同的账号、产品操作/AI 权限、原派单身份、证据时效、快照、交接和审批检查。批准前 apply 必须失败。响应包含更新后的预览；原样重试使用原幂等键，同键换内容拒绝，成功重试不重复写入或恢复被人工改变的状态。

恢复后重新核验真实目标分支，使用已有 final_validation 动作保存实际 head、时间、来源和本地组合检查结果；同时登记匹配当前结果的恢复组合验证。最后原 finish_merge_batch 仍检查修复预留、逐条交接和完整发布凭据，不得跳过门禁。

兼容传输不自动接纳外部 head、不缩小发布范围、不改变人工验收，原始确认和历史结果保留。
