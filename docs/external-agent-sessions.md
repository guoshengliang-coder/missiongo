# 外部 Agent 会话

用户直接在 Agent 客户端要求处理条目时，`claim_item.session` 或 `register_agent_session` 建立一条外部处理记录。同一账号、OAuth 客户端、Agent 类型和稳定引用会合并为同一条记录，可关联多条用户指定的条目。MCP 进展、条目状态和原生运行状态各自独立。

## 支持范围

| 客户端 | 进展上报 | 原生消息与 Web 文字回复 | 前提 |
| --- | --- | --- | --- |
| Codex | 支持 | 支持 | 已确认原生 ID，选定节点的 Codex 控制通道能访问该会话 |
| OpenCode | 支持 | 支持 | 已确认原生 ID，会话运行在该节点已登记的同一共享服务 |
| Claude Code（含第三方模型） | 支持 | 已桥接会话支持 | 使用本机 MissionGoClaudeBridge 启动或明确移交；普通未桥接 CLI 仅进展 |
| tracking、其他 Agent | 支持 | 暂不支持 | 跟踪 UUID 不构成原生 ID |

手动同步与桥接已随 Mac 0.4.38 发布；自动登记、节点握手和 tracking 记录升级需要 Mac 0.4.40 与 Skill 5.21。Claude 桥接已通过本地模拟协议验证；用户实际第三方网关与 CLI 组合仍需实测。

Codex 外部读取必须确认会话已在控制通道对应的运行时加载；`notLoaded` 历史不可自动认领。同步不订阅 MissionGo 的审批观察器，文字回复不调用 `thread/resume` 或覆盖原模型和权限。Codex CLI 若不在选定控制通道可访问的运行时中，连接保持不可用，不会另起会话冒充接管。OpenCode 普通 TUI 的临时服务也不能与已登记共享服务混用。需升级包含此外部同步协议的 MissionGo macOS 客户端；旧客户端不拉取外部绑定。

Codex 上一轮发生模型服务、连接或限流错误后，用户可在 Web（包括手机）手动发送新消息。派单会话先恢复原线程，核对同一线程为 `idle`，或为没有运行中回合且上一轮属于上述暂时性错误的 `systemError` 后才发送。Codex 的 `systemError` 标记在下一轮启动时清除，不能要求它先变回 `idle`；恢复成功后的本地状态检查失败也不得表述为 Codex 拒绝了恢复请求。外部会话只向原客户端已加载且空闲的线程发送，不代为恢复。无法继续或恢复在发送前失败时，本次回复明确标为失败并显示原因，避免一直排队；上下文、预算、认证等需处理的错误仍提示先在来源端解决。

查看错误或刷新页面不会重发失败轮次。回复使用稳定消息 ID 核对原会话记录；节点重启或发送尝试后无法确认是否收到的回复进入 `delivery_unknown`，须人工核对后再继续。旧版 Mac 节点尚不支持上述失败后继续发送，需要升级包含此修复的客户端。

## 使用流程

1. 一次性更新 Mac 客户端和 MissionGo Skill，并在 Mac 节点启用需要的 Agent。Codex 从当前运行时的 `CODEX_THREAD_ID` 取得原生身份；Claude 与 OpenCode 可安装下面的身份接入脚本。
2. Agent 按 Skill 领取用户指定条目，传入可信原生 ID、`refKind: native` 与 `autoConnect: true`。不能取得 ID 时只登记 tracking，不扫描其它聊天猜匹配。
3. 已启用的同账号节点只探测该 ID，不启动或恢复 CLI、不发送输入。首次成功读取原生会话后，服务端选定该节点，开放 Web 文字回复。多个节点同时探测时只有一个绑定成功。无法访问原会话则保持待接入；仍可手动「同步原生会话」选择节点。
4. 旧 tracking 记录点击「启用回复」，复制接入请求给原 Agent。Agent 取得自己的真实 ID 后，用原记录的 `sessionId` 调用 `register_agent_session`，保留原进展和所有关联条目；不会创建第二条记录或猜测截图中的会话。旧记录所属 OAuth 客户端和所有关联产品权限必须一致。
5. 回复经过 queued → delivering → delivered。网络错误或节点重启使交付无法确认时进入 delivery_unknown；先在原客户端核实，再确认「已收到」或「未收到」。不会自动重发；确认未收到也不会创建新回复。
6. 断开保留已同步历史，同时关闭自动接入；后续 MCP 重试不会再次连上。归档、断开只停止 MissionGo 同步，不关闭或归档原客户端会话，不创建派单、占用派单执行名额或改变条目状态。存在待交付或未确认回复时，先取消或确认才能归档、断开或更换节点。

同一节点、Agent 类型和原生会话 ID 已有派单或外部回复通道时，服务端跳过其他记录的重复自动接入，保留原记录、历史和回复队列。绑定在探测后被其他记录占用时，Mac 将 `external_native_already_bound` 冲突记入日志并冷却重试，其他会话继续同步，不将此冲突列为节点接口异常；其他错误仍按原规则报告。已有外部绑定被明确断开后，其他尚未绑定且已启用自动接入的记录可重新参与探测。

### 一次性身份接入设置

Web 的「自动接入设置」提供配置脚本下载和当前站点的运行命令。也可下载同一目录的 `install.mjs`、`claude-session.cjs` 和 `opencode-session.mjs` 后运行 `node install.mjs`；单独下载脚本时使用 `node install.mjs --origin <当前 MissionGo HTTPS origin>`。需要 Node.js 22+。

脚本只为已检测到的 OpenCode V2 安装插件；未安装或版本不兼容时保留原配置，升级后可重新运行。脚本在本机添加 Claude `SessionStart` hook 与 OpenCode V2 本地插件，幂等安装并为改写文件保留受保护的备份。保留已有 hooks、第三方接口、模型、认证来源和 MCP 配置；不读取其它会话、不上传 settings。遵循 `CLAUDE_CONFIG_DIR` 和 `XDG_CONFIG_HOME`，其它自定义目录可在安装模块调用时显式指定。安装后重新启动相关 Agent，以加载当前会话身份。

Claude hook 仅向当前上下文提供真实会话 ID，**不会给普通 CLI 增加输入通道**。新任务使用下面的 `MissionGoClaudeBridge start`，已存在的普通 CLI 则在本机明确移交后才能在 Web 回复。OpenCode 插件针对 V2 的 context hook；节点仍须连接它已登记的同一共享服务。Codex 没有可信当前 ID 或控制通道不可达时仍仅进展，不承诺控制所有独立 CLI。

身份来源分别使用 [Claude SessionStart](https://code.claude.com/docs/en/hooks)、[OpenCode V2 context hook](https://opencode.ai/v2/docs/build/plugins/) 与 [V2 插件自动发现](https://opencode.ai/v2/docs/plugins)。Codex 节点通过 [App Server](https://developers.openai.com/codex/app-server/) 精确读取已登记 ID，不发现其它会话。

当前不开放附件、模式或模型变更、远程停止，也不接入外部 Codex 会话的权限审批控制；权限批准仍在原客户端操作。原生消息不能替代条目结局评论或发布核验。

## 接口与权限

- `PUT /api/v1/agent-sessions/:id/native-connection`，正文 `{ nodeId }`：连接当前账号所属节点，只允许 Codex、OpenCode、Claude native 记录，检查全部关联产品 operate、ai 权限。
- `DELETE /api/v1/agent-sessions/:id/native-connection`：停止同步，递增绑定代次，使旧同步请求失效。
- 原有 detail、list、commands、cancel、resolve-delivery、read、archive 入口兼容外部记录，仍检查全部关联产品权限。归档不发送来源归档命令。
- 新节点通过 `X-MissionGo-External-Sessions: 1` 和进程级 `X-MissionGo-External-Worker` 拉取精确绑定。自动探测另需 `X-MissionGo-External-Auto-Connect: 1`；首次快照带精确 `X-MissionGo-External-Ref`，不含回复命令。服务端核验权限、节点和原生 ID 后递增代次，再开放正常回复。快照另带 `X-MissionGo-External-Generation`，服务端核对绑定代次、节点所有权和当前产品权限。旧客户端不收到此类记录。
- 回复预留持久化 worker 身份。worker 变更或预留超时转为交付待确认，防止重启后重发。节点不能直接把未预留回复标为成功。

原生连接不新增 MCP 控制工具，不提供任意字段更新、命令执行或会话发现接口。消息按 sourceId 更新，保留省略的历史；重复快照不推进未读时钟。

## Claude Code 外部会话接入设计与实现边界

### 第三方模型是正式支持目标

MissionGo 的控制能力不得依赖 Claude 官方 Remote Control、官方订阅或官方模型名单。使用第三方模型、兼容 API 和自定义网关的 Claude Code，只要本机 CLI 的输入输出与会话恢复协议兼容，就应能通过 MissionGo 查看消息和回复。不能把“没有官方远程链接”判为“不能在 MissionGo 回复”。

官方 Remote Control 要求合适的官方订阅登录，并明确不支持指向第三方地址的 `ANTHROPIC_BASE_URL`；其链接仅作为可选入口，不承担 MissionGo 消息交付。[官方要求](https://code.claude.com/docs/en/remote-control#requirements)

本地协议选用 Claude Code 的结构化输入输出与精确会话恢复能力。官方 CLI 文档描述了 `--input-format stream-json`、`--output-format stream-json`、`--resume`；不能由此推断所有第三方网关、CLI 分支和版本已通过兼容验证。[CLI 参考](https://code.claude.com/docs/en/cli-reference)、[程序化运行](https://code.claude.com/docs/en/headless)

现有代码基础：`ClaudeHostArguments` 已构造结构化输入输出参数，`MissionGoClaudeHost` 已持有 CLI 的 stdin/stdout 并处理消息与权限请求。官方 Remote Control 初始化失败时已有本地控制回退。本阶段应复用这些机制，并为外部会话添加独立的生命周期约束，不能直接套用派单结束时终止进程的行为。

### 控制通道与模型请求分开

消息路径为：MissionGo Web → 服务端回复队列 → 用户选定的本地节点 → 本地桥接宿主 → Claude Code 输入通道。CLI 输出由宿主转换成原生快照，经同一节点同步回 Web。模型请求仍由 Claude Code 按用户原有配置发起。

服务端不代调模型接口，不持有模型认证材料，不把回复送到 Claude 官方 Web，也不提供远程任意命令启动入口。MCP 领取负责关联条目和进展；仅连接 MCP 不代表已建立实时输入通道。

官方订阅和第三方模型使用相同的 MissionGo 队列、会话权限、快照与交付确认规则。可用能力按本地通道的握手结果确定，不按模型品牌决定。

### 两种接入方式

| 来源 | 接入方式 | 行为边界 |
| --- | --- | --- |
| 用户准备从终端开始处理条目 | 提供本地桥接启动入口，从当前终端环境启动受宿主管理的 Claude 会话 | 不强制 Web 派单；保留原生会话 ID，由 MCP 关联条目，启用自动接入的节点完成首次同步后开放回复 |
| 用户已经启动普通交互式 Claude CLI | 初期继续展示进展；用户在本机显式移交后，由宿主精确恢复该会话 | 不承诺无缝附着现有 TUI；原进程结束且会话已保存、无活跃回合或审批后，才能以指定 ID 和原配置恢复 |

桥接入口 MissionGoClaudeBridge 已包含在客户端构建中。它通过同用户、仅当前用户可访问的本地目录与内核锁关联宿主，向子进程继承终端配置；终端可通过桥接界面输入和查看输出。不能将该界面描述成原版 Claude TUI，原版 `/resume` 与桥接恢复也不得同时写同一会话。

连接使用真实的 CLI 会话 ID、选定节点、原工作目录及本地配置引用。读取范围只包含这一条会话；恢复后必须核对 CLI 返回的 ID。历史若需补读，只读取该会话对应的本地历史并校验消息身份，不枚举、上传其它会话。无法确认身份、原进程所有权、保存完成或协议兼容时保持不可回复，不新建另一条会话冒充接管。

移交必须在本机明确完成，Web 的“连接”操作本身不负责杀掉既有 CLI。后续若探索原版 TUI 的实时附着，应另行验证公开协议及第三方模型兼容性，不依赖官方 Remote Control 作为前提。

### 配置继承与恢复

新建桥接会话继承发起终端的环境、工作目录和用户指定的启动参数；移交会话使用经用户确认的同一组配置。保留自定义接口、认证来源、模型及别名、代理、配置目录、用户和项目 settings、MCP、Skill、hooks、权限模式与恢复参数的语义，不强制官方模型，不清空第三方接口，不为了建立控制通道要求官方登录。

不向外部会话套用 Web 派单的默认模型或默认权限模式。用户明确选择的 CLI 参数、环境和 settings 的优先级交由 CLI 按其规则处理；桥接仅添加控制协议必需的参数，冲突时在本机解释，不能静默覆盖。首期 Web 不开放改模型、接口或权限模式。

需要单独解决终端与 GUI 的配置差异：当前 `ShellEnvironment` 的显式 shell 导入只恢复 PATH，不能因此声称已继承 shell 中导出的第三方认证与模型配置。宿主能保留它实际收到的环境，并不意味着它自动拿到了原终端环境。

方案要求：

- 从终端桥接启动时，通过本地通道交接实际配置；GUI 连接使用本机已登记的配置引用，不根据环境缺失猜测使用官方账户。
- API Key、认证 Token、认证 helper 和完整接口地址保留在本机，不写入会话上报、服务端绑定、Git 或普通日志；Web 只展示脱敏的配置名称与可用状态。
- 持久恢复使用本机受保护的配置引用，当前桥接不新增密钥持久化；认证沿用用户 settings、helper 或终端环境。将来若增加密钥保存，仅使用系统钥匙串；短期凭据仍按原机制重新获取。重启后不能恢复配置时显示“本机配置待恢复”，不切换供应商或自动登录。
- 本地文件和 IPC 限定当前用户，诊断日志脱敏。不批量读取 shell 配置、凭据或整个环境用于排错。

### 会话生命周期与交付

外部 Claude 会话仍属于用户，绑定与断开遵循现有外部会话协议：不生成派单，不占用派单执行名额，不改变条目状态。条目完成或 Web 断开只撤销 MissionGo 的同步和输入权限，不能沿用派单宿主在任务结束时终止整个进程组的策略。宿主继续保持本机可用，或由用户显式移交回 CLI。

同一原生 ID 同时只能有一个输入宿主；本地进程所有权与锁必须可核验。节点重启、断开、重新绑定和配置恢复沿用服务端绑定代次与 worker 身份隔离。宿主在写入输入前持久记录命令身份，CLI 的回显或相应确认才能推进交付；“写入 stdin 成功”不等于“CLI 已接收”。确认丢失进入 `delivery_unknown`，由用户核实，不自动补发或重开模型回合。

首次版本开放原生消息与文字回复。问题回答和工具权限审批应显式区分：文字消息不能被隐式转换成批准任意工具。若需要回答结构化提问或权限请求，复用现有 Claude 宿主的明确请求 ID 与审批语义，并单独声明和校验能力；通道不支持时保持请求未决，清楚提示在原控制入口处理。停止、附件和模型变更继续按各自能力独立设计。

### 实施顺序与验收

1. 增加本地桥接启动与配置交接，核验结构化协议、原生 ID、工作目录和进程所有权；先验证无需官方 Remote Control 的启动、消息输入与输出。
2. 扩展外部绑定的 Claude 能力声明与适配器，只允许真实宿主连接；复用现有服务端队列、代次隔离、权限与交付待确认规则。界面区分“仅进展”“待同步”“可回复”“需本机移交”和“配置待恢复”。
3. 增加已有 CLI 的显式移交与精确恢复，核验历史、配置一致性、单一写入者及断开后的本地继续处理。
4. 完成协议测试及真实第三方配置验收后，更新 Skill 与能力表。兼容性分别记录为“已验证”“协议兼容待验证”“不支持”，不能只因看到 Claude Code 名称而承诺可控。

| 验收场景 | 必须验证的结果 |
| --- | --- |
| 官方登录与自定义接口/第三方模型两条路径 | 均能走 MissionGo 本地控制；第三方路径无需官方远程链接、无需新增官方登录 |
| 第三方环境仅配置在发起终端；GUI 中没有相同环境 | 桥接仍使用发起环境；配置未交接时明确不可回复，不回退到官方配置 |
| 用户 settings、项目 settings、模型别名、认证 helper 与代理 | 原配置按 CLI 优先级生效；失败不切换模型或供应商 |
| 已有会话移交、历史同步与继续回复 | 原生 ID 和原历史一致；活跃 CLI 未释放时拒绝第二个输入宿主 |
| Web 与本机桥接同时输入、权限请求与结构化提问 | 输入可追踪，问题和审批不串线，不自动批准；断开后本机仍可继续 |
| 节点重启、确认丢失、重复快照和旧代次上传 | 保持身份隔离、历史去重与未读语义；交付不明不自动重发 |
| 权限撤销、节点离线、断开、条目结束和归档 | Web 输入按规则关闭，用户会话不被派单清理策略终止，条目状态不被会话状态替代 |
| CLI/网关缺少必需协议或恢复配置失败 | 展示具体能力或配置问题，不伪造已连接，不新建会话掩盖错误 |

自动化测试使用脱敏的本地模拟协议与临时配置，验证接口和认证没有进入上报或日志。真实网关验收只使用用户已配置的连接和最小输入；模型调用属于实际使用成本，不能用模拟测试替代“第三方模型已实测”的结论。本地桥接、消息同步、文字回复与明确移交已实现；真实第三方网关验收未完成。Web 结构化提问与审批、自动恢复凭据、附件和远程停止不在本次能力范围。


## Claude 桥接使用（需更新后的客户端）

将客户端内 `Contents/MacOS/MissionGoClaudeBridge` 配置为终端命令或通过其完整路径执行。以下命令必须在原项目、原第三方模型配置的终端中运行，不改写 Claude settings，也不保存 API Key。

```sh
MissionGoClaudeBridge start -- '处理 EX-1，按 MissionGo Skill 读取并领取'
MissionGoClaudeBridge start --model company-alias --settings ./claude-settings.json -- '处理 EX-1'
```

终端会打印原生 UUID。领取时 Skill 登记原生 ID 并启用自动接入；仍可在 Web 手动选择节点。节点核对本机桥接、原生 ID 与首次 CLI 确认成功后才开放回复。初次启动提示词由用户明确提供，随后可以在桥接终端或 Web 继续同一会话。终端普通输入不会自动回答权限请求；使用 `/answer <request-id> <答案或批准/拒绝>` 明确回答，或使用 `answer` 子命令。Web 首期仅文字消息，待审批时文字交付会明确失败并提示本机处理。

`/detach` 或关闭终端输入只退出桥接界面，宿主保留。未确认交付需要先核实原会话；Web 队列在 Web 确认，本机写入记录用 `/confirm <command-id> received|not_received` 确认，均不会自动重发。空闲、无审批且无交付待确认时用 `/release` 或 `release <session-id>` 明确释放 CLI，之后可回到原版 Claude 的 `/resume`。宿主不会因 Web 断开、归档或条目结束被关闭。Mac 重启或宿主停止后，Web 显示不可用，需回到原配置终端：

```sh
MissionGoClaudeBridge resume <session-id> -- '继续处理 EX-1'
```

恢复沿用原工作目录与启动参数；接口、模型别名或代理环境发生变化时拒绝静默恢复，只有本机显式 `--confirm-config-change` 才采用当前配置。已有活跃 CLI、未完成回合或审批不能直接恢复。移交已停止的普通 CLI 时，用户须先记录原 PID，确认任务和审批已处理且历史已保存，再指定精确历史文件：

```sh
MissionGoClaudeBridge adopt <session-id> --history <selected-history.jsonl> --handoff-pid <exited-pid> --confirm-handoff -- '继续处理 EX-1'
```

只读取指定历史，核对原生 ID、工作目录及未完成工具请求，不发现其它会话。桥接内核锁阻止多个宿主；还会拒绝已知旧 CLI 子进程仍运行的恢复。原版 CLI 不使用桥接锁，因此移交后不得再在另一个终端同时 `/resume` 同一 ID。
