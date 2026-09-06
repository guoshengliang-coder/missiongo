# AI 写入能力设计

> 文档版本：v1.0
> 状态：设计已定稿,等待启动条件(见 §11),不是接口承诺
> 日期：2026-09-06
> 依据：`feat/ui-iteration` @ `a725cee` 的代码通读 + 设计评审逐项定稿

本文件定义 MissionGo 从「只读 AI」走向「可写 AI」的能力边界、分刀顺序和契约改动。
长期产品方向见 [产品与技术路线图](product-and-technical-plan.md);当前只读契约见
[MCP 契约](mcp-contract.md),本文件落地后需同步替换其中的只读表述。

## 1. 核心原则

**内容归人,过程归 AI。**

AI 不修改任何人写的工作内容——标题、正文、问题详情、分类字段一概不碰。它只做两件事:
**追加评论**,和**在人已经放行的任务上推进工作流阶段**。

这条原则同时决定了三件事的答案:AI 不能创建条目(创建即 triage,triage 归人)、
不能连续处理队列(队列里有什么由人决定)、不能改字段(字段是内容)。

## 2. 非目标

本次明确不做:

- `create_item`。创建条目 = 决定什么值得做,属于人的判断。Web、Android 和浏览器内
  WebMCP(`apps/web/src/webmcp.ts:115`)已经覆盖录入场景。
- `update_item`。AI 不得覆盖人写的内容。分类建议通过评论表达,由人手动应用。
- 队列 / 连续处理模式(路线图 §6.5)。它天然是「AI 自己决定写哪些条目」,注入面最大。
- 字段建议的一键采纳按钮。先观察 AI 分类建议的实际质量,再决定值不值得做。
- 多用户与角色。与单管理员自托管定位一致。

## 3. 决策记录

| # | 决策 | 结论 | 理由 |
|---|---|---|---|
| D1 | AI 能否改人写的内容 | 否 | 核心原则 |
| D2 | AI 能否创建条目 | 否 | 创建即 triage;注入内容可驱动 AI 批量造垃圾条目 |
| D3 | 队列 / 连续处理 | 否 | AI 自主决定写入目标,注入面最大 |
| D4 | 评论的定位 | 人机共用的一等概念 | 只给 AI 单向广播的话,「暂缓」路径是断的——AI 提的问题无处回答 |
| D5 | 评论的形态 | 结构化三段式 + 自由文本 | 前者承载正式分析结论(可筛选、可摘要),后者承载问答与零散记录 |
| D6 | 评论能否删除 | 人可软撤回,AI 一条都不能 | AI 写的内容会成为下次读取的上下文,错误分析必须可撤,但删除权归人 |
| D7 | 「暂缓」是否区分来源 | 分两个 reason | AI 的「结论是先不做」与人的「我要补信息」语义不同,列表要能一眼分清 |
| D8 | AI 可做的状态流转 | 4 条边(见 §5) | 进不去草稿,走不到已完成 |
| D9 | 暂缓的恢复权 | 收归人 | AI 说「先别做」然后自己又捡起来做,是自相矛盾 |
| D10 | `claim` 的 `continue` 模式 | 删除 | 唯一用途是领取暂缓态条目,D9 之后失去意义 |
| D11 | 「只分析不领取」模式 | 保留,Skill 层收紧 | 保住轻量场景;Skill 规定只能写用户本次对话明确点名的编号 |
| D12 | OAuth scope | 单一 `missiongo:write` | 范围收缩后,评论与状态流转风险相当,两级 scope 是过度设计 |
| D13 | 事件归属字段 | 开写的前置条件 | 见 §7 |
| D14 | 租约到期回收 | 补掉惰性 | 死掉的会话会让条目永远显示「处理中」 |
| D15 | 分刀顺序 | 先评论闭环,后处理闭环 | 见 §4 |

## 4. 分刀

### 第一刀：评论闭环

交付后 AI 具备「读完整上下文 → 回写意见 → 人回复」的能力,不碰领取、租约和状态流转。

- 评论概念:数据表、REST 端点、MCP 工具、Web 输入与渲染、软撤回。
- `missiongo:write` scope 与 OAuth 同意流程。
- 事件归属字段(D13)。
- 「只分析不领取」模式的 Skill 流程。

选它先行的理由:评论是全新概念,要动数据库和 Web;而处理闭环的服务端代码已经写好躺在
`services/server/src/mcp.ts:329` 的门后。先做没有的,再开已有的,风险面更小,价值也立刻兑现。

### 第二刀：处理闭环

打开 `enableWriteTools`,交付领取、租约、状态流转和结构化处理报告。依赖第一刀:AI 暂缓时
写下的原因需要有地方承载,人需要有地方回复。

`verify` 模式(领取待验证条目做自动验证,不改状态)是否随第二刀开出,待定。

## 5. 状态机改动

AI 能做的状态流转收敛为 4 条:

```
待处理 → 处理中     领取,拿租约              claim
处理中 → 待验证     完成,交人验收             resolution_submitted
处理中 → 暂缓       结论是先不做,等人跟进      deferred        ← 新 reason
处理中 → 待处理     放弃或租约到期,归队        released / lease_expired
```

人独占:草稿的全部出边、triage(待处理放行)、验收(→已完成)、重开、取消与恢复,
以及**把暂缓的条目放回队列**。人放回待处理后,AI 走标准 `claim` 重新领取。

需要改 `packages/domain/src/work-item-status.ts`:

- `on_hold → in_progress` 去掉 `agent`,只留 `human`(D9)。
- `TRANSITION_REASONS` 增加 `deferred`。
- `in_progress → on_hold` 同时接受 `deferred` 与 `request_human_input`。

**一处建模限制**:现在的 `TransitionRule` 是 (actors × reasons) 的笛卡尔积,无法表达
「agent 只能用 deferred、human 只能用 request_human_input」。要在领域层强制这条绑定,
需要把规则结构改成按 actor 绑 reason;否则只能靠调用方自律(MCP 工具固定发 `deferred`,
REST/Web 固定发 `request_human_input`),领域层挡不住。改不改由实施时权衡。

## 6. 评论模型

- 一张评论表,两种 body 形态:`structured`(结论 / 依据 / 风险)与 `free`(自由文本)。
  不做成两套实现——两者都要进时间线、都要在 Web 上渲染、都要被 MCP 读取。
- 作者记 `actor_kind` + 账号 + 客户端 + `execution_id`(见 §7)。
- 软撤回:标记已撤回,Web 折叠,MCP 读取时不返回,撤回动作本身进时间线。只有人能撤回。
- 现有 `analysis_appended` 事件与 `store.appendAnalysis` 需要归并到这套模型,不保留第二套路径。

## 7. 开写的前置条件

`docs/security-boundaries.md` 结尾写着:「未来 AI 领取和租约事件……在对应能力上线前必须
先建立持久化审计模型。」这条尚未兑现。

现在 `store.ts:1670` 的 `insertEvent` 只记 `actor_kind`(human / agent / system),
**不记哪个账号、哪个 OAuth 客户端、哪次 execution**。这不只是审计缺口:AI 写入的内容会
成为下一次读取时的上下文,如果分不清「这段是人给的事实」还是「这段是上一个 AI 的推测」,
AI 会把自己的猜测当证据反复强化。

因此第一刀必须包含事件与评论的归属字段。

## 8. 其他服务端改动

- **scope**:`oauth.ts:12` 只有 `MISSIONGO_READ_SCOPE`,且 `:149` 与 `:178` 会拒绝任何
  非 read 的 scope,`app.ts:583` 的 `/mcp` 路由也只检查 read。需要:授权请求接受多 scope、
  同意页显式列出写权限、token 携带 scopes、每个写工具做 `requireScope`。
- **总开关**:复用现有 `enableWriteTools`(`mcp.ts:24`),由环境变量传入,默认关闭。
  不做按产品的 AI 写开关——单人自托管下产品都是自己的。
- **租约到期**:`expireStaleLease`(`store.ts:1447`)只在下一次领取尝试时惰性触发。
  改为定时清扫,或在列表渲染时按 `expires_at` 标注。
- **鉴权不变量**:`mcp-authorization.test.ts:78` 的结构化断言(门后新增工具必须调用
  `requireItemAccess` / `requireExecutionAccess`)继续有效,新增写工具时不得绕过。

## 9. Skill 改动

- **不拆成两个 Skill**。写必须以完整读为前提,拆开会导致写流程重复读、或跳过读。
  保持单一 `missiongo` Skill,内部按模式分节:查看 / 只分析 / 处理。
- **拆出 `references/`**。当前 SKILL.md 已接近单文件上限。按路线图 §10.4:
  `SKILL.md` 留主流程与分诊,`references/` 承载 `task-workflow.md`、`status-rules.md`、
  `security-rules.md`。
- **能力发现放服务端**。`get_current_account` 除 `skill.expectedVersion` 外,再返回
  本次连接实际拿到的 scope 与可用工具。Skill 依据「服务端说我能写」决策,而不是
  「我本地这份 Skill 写着能写」——版本漂移、scope 未授予、总开关关闭三种情况因此
  收敛成同一个可靠信号。
- **写入前的确认点**:状态流转一律先向用户复述再执行;评论在用户已经要求回写时可直接写。
- **注入防线**:写入目标必须是用户在本次对话明确给出的编号,禁止从条目内容里读出编号再写
  它(D11)。服务端对 `append_comment` 无法强制这一点,是已知的 Skill 层约束。
- **版本跳 2.0.0**。`packages/contracts/src/skill.ts` 的契约测试强制此项。

## 10. 契约与文档同步清单

以下每一处都写着「当前只读」,开写时必须同步:

- `docs/mcp-contract.md` —— 明文写着「MCP 工具列表不得出现分析回写、领取、进度、修改状态……工具」
- `README.md:24` —— 「不开放领取、回写、修改状态」
- `services/server/src/mcp.ts:17` `MISSIONGO_MCP_INSTRUCTIONS` —— "This phase is read-only"
- `packages/contracts/src/mcp-tools.ts` —— `MCP_TOOL_DEFINITIONS` 目前只列 7 个 read 工具
- `docs/security-boundaries.md` —— 审计模型与 Token 类型
- `docs/ai-client-setup.md`、`docs/openapi.yaml`
- `docs/ui-iteration-plan.md` UI-04 —— 侧栏 AI 文案。若第一刀先行落地,该项的方案 A(改文案)
  会被本文件的方案 B(开能力)取代

## 11. 启动时机

**本设计在 [界面改版迭代](ui-iteration-plan.md) 合并发布之后才开始实施。**

硬冲突只有一处:第一刀里 Web 那半的落点是时间线——评论输入、评论渲染、人机来源区分、
软撤回折叠——而 UI-11 正在重做时间线(连续事件合并、默认倒序、按天分组可折叠)。
先做评论等于在一面即将拆掉的墙上挂东西。

不构成阻塞的:

- P2 的系统化批次(UI-13 令牌层与暗色、UI-14 双栏)。评论 UI 按当时的样式做,随 P2 一起收敛。
- §5 的状态机改动。新增 `deferred` reason 与 `on_hold → in_progress` 收归人,对 Web 的转移表
  零影响——`apps/web/src/work-item-transitions.ts` 里 `on_hold` 的 "Resume work" 是人用的,
  `in_progress → on_hold` 人仍发 `request_human_input`。它是 self-contained 的 domain 层改动。

一个几乎零成本的提前量:UI-11 选时间线结构时,倒序 / 按天分组 / 可折叠这套本来就是为
「有对话内容的时间线」设计的。做的时候把「以后这里会有人和 AI 的对话」当成一个约束,
结构会更贴。
