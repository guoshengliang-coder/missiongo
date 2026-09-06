# AI 写入能力实施计划

> 文档版本：v1.0
> 状态：待执行的实施计划,不是接口承诺
> 日期：2026-09-06
> 依据：`feat/ui-iteration` @ `f216c94` 的代码通读

本文件只排**第一刀(评论闭环)**的实施顺序。能力边界、原则和 15 条决策见
[AI 写入能力设计](ai-write-plan.md),本文件不重复论证,只在决策落到具体文件时引用其编号(D1…D15)。

## 1. 开工前的两件事

**分支尚未合并。** `main` 仍在 `ca5ed33`,`feat/ui-iteration` 领先 11 个提交。设计文档
`docs/ai-write-plan.md` 被卷进了 `05de701`(一个 UI 主题提交)。按 [设计 §11](ai-write-plan.md)
的启动条件,界面迭代合并发布之后再开工。

**两个阻塞性发现**(详见 AW-05、AW-08),都会改变原计划的形状,建议开工前先定:

1. MCP 的写工具只有**一道总开关**。第一刀只想开评论,但翻开这道门,第二刀的领取、租约、
   状态流转工具会一起出去。必须先把开关分级。
2. Skill 是**单文件发布**的。设计 §9 说的「拆 `references/`」与现有分发模型冲突。

## 2. 批次总览

| 批次 | 主题 | 条目 | 产出 |
|---|---|---|---|
| A | 服务端地基 | AW-01 … AW-04 | 无界面产出,`curl` 可验证 |
| B | MCP 与 Skill | AW-05 … AW-08 | AI 侧可写,人侧还看不见 |
| C | Web | AW-09 … AW-11 | 人机闭环成立 |
| D | 收尾 | AW-12 | 契约与文档同步 |

## 3. A 批 —— 服务端地基

### AW-01 事件的归属字段

落 D13。现在 `work_item_events` 只有 `actor_kind`(human / agent / system),分不清哪个账号、
哪个 OAuth 客户端、哪次 execution 写的。这既是审计缺口,也让 AI 无法区分「人给的事实」与
「上一个 AI 的推测」。

- `services/server/src/storage/schema.ts:74`：`work_item_events` 增 `account_id` / `client_id` /
  `execution_id`,均可空(历史事件没有)。
- `services/server/src/storage/database.ts`：追加迁移 13,照 `version = 12` 那段 `archiveMigration`
  的写法(`PRAGMA table_info` 探测 + `ALTER TABLE ADD COLUMN`)。当前最高版本是 12。
- `services/server/src/store.ts:1670` `insertEvent`：签名增加归属参数,补齐全部调用点。
- `services/server/src/types.ts:146` `WorkItemEventSnapshot`：增对应字段。

**验收**：人写和 AI 写的事件能分辨账号与客户端;历史事件字段为空且读取不报错。

### AW-02 评论数据模型

落 D4 / D5 / D6。评论在系统里**完全不存在**——没有表、没有端点、Web 上人也不能评论。

- 迁移 14 新建 `work_item_comments`：`id` / `item_id` / `actor_kind` / `account_id` / `client_id` /
  `execution_id` / `body_kind`(`structured` | `free`) / `body_json` / `created_at` /
  `withdrawn_at` / `withdrawn_by`。`STRICT` 表,与现有风格一致。
- `store.ts` 新增 `createComment` / `listComments` / `withdrawComment`。软撤回:标记而非删除,
  撤回动作本身写一条事件。
- **归并 `appendAnalysis`**(`store.ts:1020`)：改为写评论表,`body_kind = 'structured'`;
  历史 `analysis_appended` 事件回填成评论。这是本刀唯一带数据迁移的一项。
- `getTimeline`(`store.ts:996`)：返回事件与评论按时间合流的单一流。评论与事件分表是刻意的——
  事件是不可变事实,评论是有状态实体(可撤回)。

**验收**：同一条目上人和 AI 各写一条评论并按时间正确排序;撤回后 MCP 读取不再返回;
历史 `analysis_appended` 显示为结构化评论,内容不丢。

### AW-03 评论的 REST 面

- `services/server/src/app.ts:919`(`GET /items/:itemKey/timeline`)之后新增
  `GET|POST /api/v1/items/:itemKey/comments` 与 `POST /api/v1/items/:itemKey/comments/:commentId/withdraw`。
- 沿用现有管理会话鉴权(`app.ts:351` 的 `onRequest` 钩子),不引入新的鉴权路径。
- 同步 `docs/openapi.yaml`。

**验收**：`curl` 可发、可读、可撤回;撤回后条目在列表里标记为已撤回而不是消失。

### AW-04 `missiongo:write` scope

落 D12。现在只有一个 scope,而且是硬断言。

- `services/server/src/oauth.ts:12`：新增 `MISSIONGO_WRITE_SCOPE`。
- `oauth.ts:149` 与 `:178`：现在写死 `scope !== MISSIONGO_READ_SCOPE` 即拒绝,改成 scope 集合校验。
- `app.ts:400` / `:415`：`scopes_supported` 补写权限。
- `app.ts:509`：签发 token 时按同意结果授予 scope。
- `app.ts:444` / `:467` 的授权页：**显式列出**写权限,不能默默把写一起授出去。
- `app.ts:583`：`/mcp` 路由继续只要求 read 才能连接;写工具各自校验 write。

**验收**：只授 read 的 token 调用写工具返回 `permission_denied`;授权页上能看到写权限条目。

## 4. B 批 —— MCP 与 Skill

### AW-05 把写工具的总开关分级 ← 阻塞项

`services/server/src/mcp.ts:329` 只有一道 `if (!options.enableWriteTools) return server;`,
门后依次是 `append_analysis`、`get_execution`、`claim_item`、`renew_item_lease`、`append_progress`、
`request_human_input`、`submit_resolution`、`mark_pending_verification`、`release_item`、
`resume_execution`。**第一刀翻开这道门,第二刀的全部工具会一起出去。**

- `mcp.ts:24` `MissionGoMcpOptions`：`enableWriteTools?: boolean` 改为分级,例如
  `writeTools?: "none" | "comments" | "all"`。
- `services/server/src/mcp-authorization.test.ts:85` 的结构化守卫按
  `indexOf("if (!options.enableWriteTools) return server;")` 切片,`handlers.length >= 10` 的
  下限也要重算。守卫本身(门后新增工具必须调用 `requireItemAccess` / `requireExecutionAccess`)
  必须保留并覆盖新的分档。
- 总开关仍由环境变量传入,默认关闭(D:不做按产品开关)。

**验收**：`comments` 档位下 `tools/list` 只多出评论工具,`claim_item` 不出现;守卫测试覆盖两档。

### AW-06 `append_comment` 工具

- 结构化与自由文本两种 body 用同一个工具,由入参区分(D5)。旧的 `append_analysis` 名字并入,
  不再对外暴露第二个入口。
- 必须走 `requireItemAccess`(AW-05 的守卫会强制)。
- 幂等键沿用 `idempotency_keys` 表的既有用法(参照 `store.ts:1031`)。
- 工具描述重复不可信数据声明,并写明只能写用户点名的条目(D11)。**服务端无法强制这一条**,
  它是 Skill 层约束,必须在文档里说清楚是约束不是保证。

**验收**：AI 能发两种形态的评论并读回;越权条目返回统一的「无权限或不存在」。

### AW-07 能力发现放服务端

`get_current_account` 除 `skill.expectedVersion` 外,再返回本次连接实际拿到的 scope 与可用工具。
Skill 依据「服务端说我能写」决策,而不是「我本地这份 Skill 写着能写」——版本漂移、scope 未授予、
总开关关闭三种情况因此收敛成同一个可靠信号。

**验收**：只读 token 下返回的可用工具清单不含评论工具。

### AW-08 Skill 2.0.0 ← 阻塞项

设计 §9 要求拆出 `references/`,但**当前 Skill 是单文件分发**:

- `apps/web/vite.config.ts:63` 的 `missiongo-skill-download` 插件把
  `skills/missiongo/SKILL.md` 一个文件拷到 `/downloads/missiongo-skill/SKILL.md`。
- `packages/contracts/src/skill.ts:13` 的 `MISSIONGO_SKILL_DOWNLOAD_PATH` 指向那一个文件。
- `packages/contracts/src/skill.test.ts:16` 的 `SKILL_CONTENT_DIGEST` 只哈希那一个文件。
- AI 客户端按单个 URL 安装,拿不到 `references/`。

**开工前要定**:(a) 第一刀维持单文件,把写流程压进 SKILL.md,拆分推迟;
(b) 改成目录分发——vite 插件拷目录、摘要守卫改哈希目录、安装说明改成取多个文件。
我倾向 (a):第一刀新增的流程有限,而改分发模型是独立的一件事,不该和开写捆在一起。

无论选哪个,都要做的:新增「只分析不领取」流程与写入前确认点;
`MISSIONGO_SKILL_VERSION` 升到 `2.0.0`(`skill.test.ts` 强制)。

## 5. C 批 —— Web

### AW-09 时间线接入评论

- `apps/web/src/timeline.ts:23` `groupTimeline` 现在只吃 `WorkItemEvent[]`,要改成吃合流后的条目。
  已有的附件事件折叠逻辑保留。
- `apps/web/src/App.tsx:1368` `timeline-block`：渲染评论条目。
- `App.tsx:1416` `AnalysisDetails`：现在专门渲染 `analysis_appended` 的 payload,改造成
  结构化评论的渲染。
- 人与 AI 的来源视觉区分,依赖 AW-01 的归属字段。

**验收**：一条人评论和一条 AI 评论在时间线上一眼可分;附件事件折叠不回归。

### AW-10 评论输入

- `App.tsx` `DetailPane` 的 `timeline-block` 增加输入框。
- `apps/web/src/api.ts:94` 的 `api` 对象补方法。
- `apps/web/src/i18n.tsx` 补双语键。
- 提交后 `invalidateQueries(["timeline", itemKey])`(现有写法见 `App.tsx:1245`)。

**验收**：Web 上发评论后时间线立即更新;Android 壳(WebView)自动获得同一能力。

### AW-11 软撤回的界面

- 撤回按钮对人可见,AI 的评论也能被人撤回;AI 一条都不能撤(D6)。
- 已撤回的评论折叠展示,展开可见撤回时间。

**验收**：撤回后 Web 折叠、MCP 读取不返回、时间线留有撤回记录。

## 6. D 批 —— 契约与文档同步

### AW-12

按 [设计 §10](ai-write-plan.md) 的清单逐项改:`docs/mcp-contract.md`(明文写着不得出现回写工具)、
`README.md:24`、`mcp.ts:17` 的 `MISSIONGO_MCP_INSTRUCTIONS`("This phase is read-only")、
`packages/contracts/src/mcp-tools.ts` 的 `MCP_TOOL_DEFINITIONS`、`docs/security-boundaries.md`、
`docs/ai-client-setup.md`、`docs/openapi.yaml`。

界面迭代已经按 UI-04 方案 A 把侧栏文案改成了「只读」,第一刀落地后要再改回来。

**验收**：仓库里不再有「当前只读」的表述与实际能力矛盾。

## 7. 顺序与依赖

```text
AW-01 ──┬─→ AW-02 ─→ AW-03 ─┬────────────→ AW-09 ─→ AW-10 ─→ AW-11
        │                    │
AW-04 ──┴─→ AW-05 ─→ AW-06 ──┴─→ AW-07 ─→ AW-08 ─────────────→ AW-12
```

A 批做完可用 `curl` 验证;B 批做完 AI 侧可写但人看不见;C 批做完闭环才成立。
AW-12 最后做,因为它把「只读」改成「可写」,做早了文档会先于能力撒谎。

## 8. 第二刀的边界(本文件不展开)

- 打开写工具的 `all` 档:领取、租约、进度、状态流转、结构化处理报告。
- 状态机改动(设计 §5):新增 `deferred` reason、`on_hold → in_progress` 收归人。
  **对 Web 零影响,可随时提前做**。
- 删除 `continue` 模式(D10)。注意 `schema.ts:92` 的 `ai_executions.mode` CHECK 约束含
  `'continue'`,SQLite 改 CHECK 要重建表;建议保留约束,只从 `EXECUTION_MODES` 与工具入参里去掉。
- 租约到期改为不再惰性回收(D14,`store.ts:1447` `expireStaleLease`)。
- `verify` 模式是否开出,待定。

## 9. 已知风险

1. **AW-02 的历史数据回填**是本刀唯一动存量数据的一项。回填前应先跑
   `scripts/backup.mjs`,并验证回填后旧的 `analysis_appended` 内容一条不少。
2. **AW-05 会动到现有的结构化守卫测试**。那个测试是「新写工具必须鉴权」这条不变量的唯一
   自动化保障,改它的时候要确保守卫变强而不是变松。
3. **AW-08 的分发模型**若选目录分发,会牵动 vite 插件、摘要守卫和客户端安装说明三处,
   工作量与第一刀其余部分不在一个量级。
