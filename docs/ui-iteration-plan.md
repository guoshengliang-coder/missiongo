# 界面改版迭代计划

> 文档版本：v1.1
> 状态：17 项已全部实现，本文件保留为改动记录与验收依据
> 日期：2026-09-06
> 依据：main @ `0f003cf` 的代码通读 + 本地实例实测（12 条种子数据，视口 1440×900 与 375×812）

本文件只覆盖 Web/H5 管理端的功能暴露、任务流与视觉规范。长期产品方向见
[产品与技术路线图](product-and-technical-plan.md)；本文件中的每一项都对应当前代码里已存在的问题，不引入新的产品概念。

## 1. 这次迭代要解决什么

三句话概括当前状态：

1. **后端做了、界面没开。** 取消/作废、SDK Token 管理、多模块影响标注在领域层和 REST 面都已实现，Web 端没有入口。
2. **一张 Bug 表单套五种类型。** 录一条灵感要选必填平台、面对一整块诊断日志区，表单高度 1002px。
3. **密度与可读性同时不达标。** 桌面行高 126px（一屏 5.3 条），同时最小字号 7px、正文级中性色最低 2.88:1。

界面文案还承诺了当前构建做不到的事（AI 回写），这条单独处理。

## 2. 非目标

本次迭代明确不做，避免范围蔓延：

- 全文检索 / FTS5。当前 `LIKE` 覆盖 key、title、description、report_json，个人使用量级下够用。
- 多用户、角色与权限。与单管理员自托管定位冲突。
- 自定义字段、看板视图、工作流编辑器。会稀释「快速记录 + AI 读完整上下文」这个差异点。
- 自动崩溃上报、定时调度。路线图已排除在首版之外，保持不动。
- 任何新的领域概念。本次只暴露和收敛已有能力。

## 3. 批次总览

| 批次 | 主题 | 条目 | 服务端改动 | 状态 |
|---|---|---|---|---|
| P0 | 接出已有能力，把话说对 | UI-01 … UI-06 | 无 | 已完成 |
| P1 | 列表与表单重构 | UI-07 … UI-12 | 仅 UI-08 | 已完成 |
| P2 | 系统化，消除第二套实现 | UI-13 … UI-17 | UI-17 | 已完成 |

实施中有三处偏离本计划，都写在对应条目下：UI-04 只做了 A（改文案），
UI-14 保留了窄屏的滚动补偿，UI-15 没有把 SDK 表单并进 `WorkItemFields`。

## 4. P0 —— 接出已有能力，把话说对

### UI-01 补上取消 / 作废出口

领域状态机允许 `inbox / ready / in_progress / on_hold / pending_verification` 五个状态由人工以
`cancelled` 理由转入取消态，REST 也放行，但 Web 的转移表里 `cancelled` 出现 0 次。误录的条目目前永久留在列表中。

- `apps/web/src/App.tsx:116` `TRANSITIONS`：五个状态各补一条指向 `cancelled` 的出边，`reason: "cancelled"`。
- `apps/web/src/App.tsx` 侧栏：去掉 `ITEM_STATUSES.filter((status) => status !== "cancelled")` 的过滤，或单独加「已取消」入口。
- `apps/web/src/i18n.tsx` `TRANSITION_LABELS`：补 `Cancel` 与 `Restore` 两条中英文案。
- `apps/web/src/styles.css`：菜单项增加危险态样式，取消项与其他项之间加分隔线。
- 已就绪，不需改动：`packages/domain/src/work-item-status.ts`、`services/server/src/app.ts:907`。

**验收**：五个状态的「更多」菜单都能取消；已取消条目可从侧栏进入并「恢复」到草稿；`cancelled` 不再计入「未完成」。

### UI-02 详情页把结论提到附件之前

当前渲染顺序是 标题 → 截图与视频 → Bug 详情 → 环境 → 诊断 → 处理记录。带 3 张竖屏截图的条目，首屏被附件网格完全占满，「现象描述」在 520px 之后。

- `apps/web/src/App.tsx:1131` `DetailPane`：把 `AttachmentSection` 移到 `ReportDetails` 与环境区块之后。
- 附件区默认收成一行缩略图，点击进灯箱。

**验收**：1440×900 打开 `HG-1`（3 张 720×1560 截图），首屏能读到「现象描述」全文。

### UI-03 修 Modal 的初始焦点

标题输入框写了 `autoFocus`，但 `Modal` 在 `useEffect` 里才调用 `dialog.showModal()`，原生行为把焦点重置到 dialog 自身。实测标题框是模态内第 9 个可聚焦元素，键盘用户需要 8 次 Tab。

- `apps/web/src/App.tsx:2591` `Modal`：增加 `initialFocusRef`，在 `showModal()` 之后用 `requestAnimationFrame` 聚焦。
- `CaptureForm` 与 `EditItemForm` 把 ref 传给标题输入。
- 顺带：`<dialog>` 内层的 `role="dialog" aria-modal="true"` 换成 `aria-labelledby`，去掉嵌套对话框语义。

**验收**：打开「记录」后 `document.activeElement` 是标题输入框；移动端直接唤起键盘。

### UI-04 AI 文案与实际能力对齐

侧栏写着「结论、依据和风险会回写到处理记录」，但 `services/server/src/app.ts:287` 从未传过
`enableWriteTools`，`services/server/src/mcp.ts:329` 在注册写工具前就 `return server`——
`append_analysis` 等 10 个写工具在运行时不存在。README 对此是诚实的，界面不是。

两条路，**建议先走 A**：

- **A（本批次）** 改文案：`apps/web/src/i18n.tsx:41` 与 `:323` 的 `aiDispatchDescription`，改成「AI 可按编号读取完整上下文、日志和图片」。
- **B（单独立项，未实施）** 开能力：`app.ts:287` 接一个环境变量传入 `enableWriteTools`，同步 README、`docs/mcp-contract.md`、`docs/ai-client-setup.md` 与 `skills/missiongo/SKILL.md`。写工具一旦开出去就是接口承诺，不适合夹在界面迭代里。

**验收**：README、界面文案、MCP 实际注册的工具三者一致。

### UI-05 字号下限提到 11px

`styles.css` 里 9px 出现 27 次、10px 21 次、8px 12 次、7px 5 次。其中 `.item-evidence-summary small`
（「日志 1 条」「图片 3 张」这类证据标记，产品最想让人一眼看到的信息）是 7px，移动端同样。

- `apps/web/src/styles.css:1` `:root`：定义 `--text-xs: 11px` … `--text-3xl: 27px` 共 8 档。
- 7 / 8 / 9 / 10px 全部并入 11 / 12。此后新代码只允许用变量。

**验收**：`grep -o "font-size: [0-9]*px" apps/web/src/styles.css | sort -u` 的最小值为 `11px`。

### UI-06 中性色统一到 ≥ 4.5:1

实测不达标的四处：`.sidebar-label` 2.88:1、`.eyebrow` 与 `.type-filters`（未选中）4.16:1、
`.item-description` 4.27:1、`.list-pagination` 4.39:1。状态胶囊七种全部 5.0–5.9:1，说明规范意识是有的，
只是没有贯彻到中性文字。

- `styles.css:1` `:root` 四档：`--ink #172033`（16.4:1）、`--ink-2 #2b3341`（12.7:1）、
  `--muted #4a525f`（7.9:1）、`--muted-soft #5f6570`（5.9:1，在侧栏底 `#eceae4` 上 4.8:1）。
- 替换散落的 `#6d7481`、`#747b86`、`#858a93`。更浅的灰只用于图标与分隔线，不承载文字。

**验收**：列表页与侧栏所有承载文字的选择器对比度 ≥ 4.5:1。

## 5. P1 —— 列表与表单重构

### UI-07 行高 126 → 72px，缩略图放大并保留

桌面 `.item-row { min-height: 126px }`，12 条即 1888px 滚动高度（内容区 828px）；移动端每卡 248px，
一屏 3.27 条。同时，只要产品里存在任意一条带图条目，所有行都会渲染一个可见的空占位。

- `styles.css:242` `.item-row`：`min-height` 126 → 72，网格改为
  `28px minmax(0,1fr) 96px 168px 108px 92px 34px`。
- `App.tsx:861` `ItemRow`：改两行结构（编号 + 标题 + 证据徽章 / 摘要单行截断）。
- `App.tsx:930` `ItemMediaStrip`：缩略图 46×52，最多两张，第三张起在第二张上叠 `+N`；
  竖屏截图必须配 `object-position: top`，否则 `object-fit: cover` 只裁中间那段，认不出界面。
- `App.tsx:496` `showAttachmentColumn`：列继续占位以保持网格对齐，但无图的行渲染空内容，不画占位框。
- 标题行里的「图 N」徽章去掉，`+N` 已经说明数量；「日志 N」与「有复现步骤」保留。
- 移动端：卡片 96px，右侧 44×56 缩略图，多图右下角叠 `+N`。

**验收**：1440×900 一屏 ≥ 9 条；375×812 一屏 ≥ 6 条；字号与对比度不低于 UI-05 / UI-06 的标准。

### UI-08 筛选进 URL，统计跟着筛选走

`navigation.ts` 只序列化 `?item=`，产品/状态/类型/搜索全在 React state 里，刷新即丢。
`getWorkItemListSummary` 只按 `productId` 聚合，不吃筛选条件——实测搜索「CSV」时列表 1 条，
侧栏仍显示「全部条目 12」，页头仍显示「11 未完成」。

- `apps/web/src/navigation.ts`：序列化 `product` / `status` / `type` / `q`。
- `App.tsx:346-348`：state 初值从 URL 读，变更时 `history.replaceState`。
- `services/server/src/store.ts:706` `getWorkItemListSummary`：接收与 `listWorkItems` 相同的过滤条件。
- `services/server/src/app.ts:830`：把 status / type / search 一并传给 summary。
- 列表顶部增加「筛选生效中 · 匹配 N / 总数 · 清除」条。

**这是 P1 唯一需要动服务端的一项。**

**验收**：搜索后刷新页面结果不变；侧栏计数与列表一致；链接可分享。

### UI-09 录入表单按类型裁剪

只有 4 个 Bug 专属字段是条件渲染的。「所属平台」对灵感、备注同样标必填，深色诊断日志区对灵感同样常驻
且是整屏视觉重量最大的元素。实测 Bug 表单 1269px、灵感 1002px，容器 862px。

服务端本来就把 environment 当可选（`services/server/src/app.ts:166`），**这一项是纯前端改动**。

- `App.tsx:1582` `WorkItemFields`：平台对 `idea` / `note` 改为选填；诊断区对 `idea` / `note` / `requirement` 默认折叠。
- `FieldLabel`：去掉「选填」分支，只渲染必填。实测 Bug 表单 11 个徽章（3 必填 / 8 选填）。
- `CaptureForm` / `EditItemForm` 的提交校验同步放宽。

**验收**：灵感表单 `scrollHeight` ≤ 560px；表单上的徽章数 ≤ 3。

### UI-10 SDK Token 管理界面

`GET / POST / DELETE /api/v1/sdk-tokens` 已实现（`app.ts:632 / 634 / 647`），但整个 `apps/web/src`
搜 `sdk-token` 零命中。接入 Android 反馈 SDK——产品最大的差异点——目前必须手写 curl。

- `App.tsx` `ProductSettings`：增加第三个标签页（产品信息 / 模块管理 / 接入令牌）。
- `apps/web/src/api.ts`：补 `listSdkTokens` / `createSdkToken` / `revokeSdkToken`。
- 明文只在创建后展示一次，之后只显示前缀与创建时间。

**验收**：发令牌、看列表、吊销三件事都不需要离开界面。

### UI-11 处理记录改造

实测 `HG-1` 的时间线里连续四条「已添加附件 · 人工 · 2 分钟前」，不带文件名、不可折叠，且全部正序，
最新进展在页面最底部。

`attachment_added` 事件的 payload 里**已经带了 `filename` / `kind` / `displayNumber` / `sizeBytes`**
（`services/server/src/store.ts:852`），**这一项也是纯前端改动**。

- `App.tsx` `DetailPane` 时间线：连续的 `attachment_added` 合并成一条并列出文件名；默认倒序；按天分组可折叠。

**验收**：4 个附件显示为一条带文件名的记录；最新事件在最上方。

### UI-12 降低流转按钮的视觉权重

每行右侧固定一个深色实心按钮，12 行就是一列 12 个深色块，而标题、摘要是浅色小字。移动端每张卡片最抢眼的
都是那个黑色按钮。

- `styles.css` `.quick-action-button`：改次级样式，桌面端 `.item-row:hover` 才显形。
- 移动端移入长按菜单，整卡可点。

**验收**：列表页不再出现一列深色按钮；主操作在详情页工具栏仍是主按钮。

## 6. P2 —— 系统化，消除第二套实现

| 编号 | 内容 | 关键文件 |
|---|---|---|
| UI-13 | 建立完整令牌层（颜色 / 间距 / 字号 / 圆角）+ 暗色模式。圆角从 20 种取值收敛到 8 / 11 / 14 / 18 四档；`color-scheme: light` 改为跟随系统 | `apps/web/src/styles.css` |
| UI-14 | 桌面端 ≥1280px 改「列表 + 详情」双栏。`listScrollTopRef` 那套补偿**保留**：窄屏仍然是整页接管，补偿在那里仍然必要，只是在双栏下不再生效 | `App.tsx`、`styles.css` |
| UI-15 | `SdkFeedback` 接入 i18n（约 40 条硬编码中文，以及一套和主应用不一致的类型/优先级标签）。**没有**并进 `WorkItemFields`：两者的附件模型、上传目标和只读字段都不同，合并会给双方各加一打条件属性 | `apps/web/src/SdkFeedback.tsx` |
| UI-16 | 三处灯箱收敛为一个基于 `<dialog>` 的组件，一次性拿到焦点陷阱、Esc 与焦点归还 | `App.tsx` |
| UI-17 | 产品与模块的归档 / 恢复（migration 12 加 `archived_at`）。条目不需要第二套机制——UI-01 打通的 `cancelled` 就是条目的收回路径。选择器只看未归档，**展示路径必须带 `includeArchived`**，否则条目会静默丢掉来源模块 | `schema.ts`、`database.ts`、`store.ts`、`app.ts`、`App.tsx` |

## 7. 顺序与依赖

```text
UI-05 字号  ─┐
UI-06 颜色  ─┴─→ UI-07 行高与缩略图 ─→ UI-14 双栏详情
                                    └─→ UI-13 令牌层（对 05/06 的收口）

UI-01 取消出口 ─→ UI-17 删除/归档（共用「收回」语义）
UI-03 焦点修复 ─→ UI-09 表单裁剪（同一批表单改动，合并测试成本更低）
UI-08 独立，是 P1 唯一需要动 store.ts 的一项
UI-04 A 独立；UI-04 B 不进本次迭代
```

先做 UI-05 / UI-06 再做 UI-07 是有意的：行高压缩之所以成立，前提是字号和对比度已经提上去，
否则只是把本来就看不清的东西挤得更紧。

## 8. 验收口径

全部可量化，改完逐条复测。下表的「改版」列是实测值，不是估算。

| 指标 | 现状 | 目标 | 改版实测 | |
|---|---|---|---|---|
| 桌面列表区高度 ÷ 行高（1440×900） | 5.3 | ≥ 9 | **11.5** | ✅ |
| 桌面首屏完整可见行数 | ~4 | — | **8** | ✅ |
| 移动首屏完整可见卡片（375×812） | 3.27 | ≥ 6 | **6** | ✅ |
| 最小渲染字号 | 7px | 11px | **11px** | ✅ |
| 可见文字最低对比度（浅色） | 2.88 : 1 | ≥ 4.5 : 1 | **4.87 : 1** | ✅ |
| 可见文字最低对比度（深色） | 无深色模式 | ≥ 4.5 : 1 | **4.62 : 1** | ✅ |
| 灵感表单高度 | 1002px | ≤ 560px | **836px**（容器 836px，不再滚动） | ⚠️ |
| 录入表单徽章数（灵感） | 11 | ≤ 3 | **2** | ✅ |
| 打开「记录」到可打字 | 8 次 Tab | 0 | **0**（焦点直接落在标题框） | ✅ |
| REST 已实现但界面无入口的能力 | 3 | 0 | **0** | ✅ |
| 界面文案与 README 的能力口径 | 不一致 | 一致 | **一致** | ✅ |
| 最小触控目标（移动） | 44px | 44px | **44px** | ✅ |

对比度按 WCAG 相对亮度公式，遍历页面上每个可见文本节点，取它的计算前景色与逐层向上求得的真实背景色计算，
不目测；列表页、详情页、录入弹层在浅色和深色下都是 0 条不达标。

一处没打到目标：**灵感表单 836px 而不是 ≤560px**。删掉的是必填平台和常驻的诊断日志区；
剩下的高度来自类型选择、标题、截图区和说明框，再删就要动「灵感也可以配图」这个能力本身。
836px 正好等于弹层容器高度，实际效果是一屏内不用滚动——这是目标背后想要的东西，数字本身没达成。

## 9. 建议录入的工作条目

用 MissionGo 自己跟踪这次改造。建议的类型、优先级与模块归类如下（模块名按各自实例的实际配置调整）：

| 编号 | 类型 | 优先级 | 平台 | 标题 |
|---|---|---|---|---|
| UI-01 | bug | urgent | web | 条目无法取消或作废，误录后永久留在列表 |
| UI-02 | bug | high | web | 详情页首屏被附件占满，读不到现象描述 |
| UI-03 | bug | high | web | 打开「记录」后焦点不在标题输入框 |
| UI-04 | bug | high | web | 侧栏 AI 文案承诺了当前构建未开放的回写能力 |
| UI-05 | task | high | web | 字号阶梯下限提到 11px 并抽成变量 |
| UI-06 | task | high | web | 中性文字色统一到 WCAG AA |
| UI-07 | requirement | high | web | 列表行高压到 72px，缩略图放大并保留 |
| UI-08 | requirement | normal | web | 筛选进 URL，统计口径跟随筛选 |
| UI-09 | requirement | normal | web | 录入表单按条目类型裁剪 |
| UI-10 | requirement | normal | web | 增加 SDK 接入令牌管理界面 |
| UI-11 | task | normal | web | 处理记录合并附件事件并改为倒序 |
| UI-12 | task | low | web | 降低列表流转按钮的视觉权重 |
| UI-13 | task | normal | shared | 建立设计令牌层并支持暗色模式 |
| UI-14 | requirement | normal | web | 桌面端详情改为列表 + 详情双栏 |
| UI-15 | task | normal | web | SDK 反馈表单复用主表单组件并接入 i18n |
| UI-16 | task | low | web | 三处灯箱收敛为统一组件 |
| UI-17 | requirement | low | shared | 补齐产品、模块与条目的删除归档链路 |

## 10. 参考

- 复盘报告与实测数据、设计稿：见本次迭代的评审记录。
- 状态机与转移规则：[领域模型](domain-model.md)、`packages/domain/src/work-item-status.ts`
- 接口现状：[REST API](openapi.yaml)、[MCP 契约](mcp-contract.md)
- 长期方向：[产品与技术路线图](product-and-technical-plan.md)
