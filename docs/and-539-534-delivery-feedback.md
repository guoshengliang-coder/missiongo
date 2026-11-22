# 交付身份承接与验收反馈

AND-539 的发布范围保持原冻结候选与人工决定。`selection:<deliveryId>` 在本批次核实合并后可以承接每个原条目的开发完成事件；这是一对多的条目覆盖关系，不是新增交付授权。

同一 PR 已有部分条目事件时，精确事件行保持原依据，剩余条目逐个冻结在 `pendingItemKeys` 中，不因已有一个事件就省略其他条目的待承接范围。

承接需同时满足原选择与交付修订、原 PR、实际执行 head/merge commit、原条目内容/Builder/轮次、唯一开发事件及相同完整产物集合。已有转换审计绑定具体事件，不能用另一个事件替换。新增、移除、缺失、歧义或产物/轮次变化继续阻止发布。无条目交付只承接其自身 delivery 身份。

`publicationSuccessors` 每次从真实记录重新核验，不能把审计本身当作新授权或发布凭据。授权写入时追加 `publicationTransitions`，同内容不重复；只读预览不追加审计。预览的 `publicationIdentity.unchanged` 表示原范围仍适用，正常记录转换不再提供不必要的 `publicationRefresh`；确实变化或缺证时保留原受限恢复入口。原冻结范围、摘要与人工批准不被覆盖。实际制品仍需通过现有来源提交覆盖门禁。

AND-534 保留服务端未完整发布时的验收拦截。列表、普通详情及消息中心复用详情的状态失败使用同一 `NoticeHandler` / `AppNotice` 错误语义：错误图标、主题错误令牌、`role=alert`，错误不套用成功通知的四秒计时。操作区还保留本地化错误，重试成功清除；切换详情不继承上一条目的操作失败。带说明弹窗继续复用原内联错误；批量验收失败通过同一持续错误通知列出逐项原因，保留失败项选择。迟到响应按提交时条目快照标注，不冒充当前打开条目的结果。成功写入保持原成功通知和状态同步。

共用入口：`ItemRowActions`、`DetailPane`、`TransitionNoteDialog`、批量验证表单、`MergeReconciliation`。无新样式豁免，无自动重放验收或生产状态操作。

验证来源：`merge-deliveries.test.ts` 的 AND-539 专项（Android+Web、同 PR 多条目、重复读取/上报、范围变更与事件替换拒绝）；`error-text.test.ts`；`and-534-verification-feedback.audit.spec.ts`（列表/详情、320px 深色大字号、1440px 浅色、失败持续可读、状态不变、显式重试成功、批量失败逐项说明、切换条目后迟到失败归属）。原带说明与批量场景沿用 `transition-attachments.audit.spec.ts`。单测与浏览器模拟不替代真实原批次、Android WebView 或生产验收。
