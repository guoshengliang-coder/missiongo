# Agent 与设备（macOS 客户端）

控制台里的「Agent 管理」列出你账号下的设备，以及每台设备上报的 agent（Claude Code、Codex、OpenCode）。
设备是一台你自己的 Mac。它运行 MissionGo 客户端，主动连到服务端拉取你在控制台派出的任务，然后在本机
启动 Claude Code、Codex 或 OpenCode 会话处理这批条目。服务端不开放任何指向机器的端口，也不下发 Shell 命令——只下发
条目编号、agent、模式和仓库路径；启动提示词的业务流程相同，工作区和计划确认说明按客户端适配。

目前支持 Claude Code、Codex 和 OpenCode，Hermes 暂不支持。

## 1. 机器上要先具备什么

- macOS 13 或更新。
- **装了 Claude Code 并已登录**：终端里 `claude auth status` 显示已登录；没登录就运行 `claude auth login`。
  桌面 App 的登录不算，CLI 的登录是独立的。客户端会检测这一项，没满足时直接在菜单里告诉你。
- **仓库目录被 Claude Code 信任过**：在那个目录里手动运行一次 `claude`，选「Yes, I trust this folder」。
  没信任过的目录，会话一启动就会停在信任确认框上，而派出去的会话旁边没有人。

用 Codex 派单时（两个 agent 可以只装一个）：

- **Codex 的 app-server 后台服务在运行**。MissionGo 是连
  `$CODEX_HOME/app-server-control/app-server-control.sock` 创建会话的，这个 socket 由
  `codex app-server daemon` 提供，用 `codex app-server daemon start` 启动，
  `codex app-server daemon bootstrap` 让它开机常驻。**ChatGPT App 开着不算**：App 和它自己的 app-server 走
  stdio，不会创建这个 socket。客户端每次都实际连一次来判断通不通；连不上时，派单和菜单里的「启用 / 重新检查」
  会先自动运行一次 `codex app-server daemon start`（最多等 5 秒），仍连不上才失败，提示里带着该命令的输出。
  后台心跳不会运行它；`bootstrap` 会安装开机常驻服务，也不会自动运行。
  另外终端里 `codex login status` 应显示已登录。
- **Codex 配好了 missiongo MCP 并已登录**：

  ```bash
  codex mcp add missiongo --url <MissionGo 地址>/mcp && codex mcp login missiongo
  ```

  客户端检测到缺失时，菜单里有「复制命令」，复制出来的就是指向当前登录服务器的这条命令。

用 OpenCode 派单时：

- **在运行 MissionGo macOS 客户端的 Mac 上启动 OpenCode 2 共享服务**。客户端读取 OpenCode 自己登记的服务信息，连接已有服务，不另起进程。当前接入使用 OpenCode 2 的 HTTP API；服务关闭、登记文件无效或版本太旧都会使该集成暂停。
- **在同一个 OpenCode 服务里配置并授权 `missiongo` MCP**。建议按 [AI 客户端接入说明](ai-client-setup.md) 设置 `codemode: false`，让 Skill 直接调用 MissionGo 工具。客户端按派单仓库查询 MCP 状态，只有 `connected` 才发送提示词；显示 `needs_auth` 时，在 OpenCode 的 `/mcps` 中完成登录，再在 MissionGo 菜单点击 OpenCode「重新检查」。MissionGo 节点的登录不等于 OpenCode 的 MCP 授权。
- **把 MissionGo Skill 同步到 OpenCode 的原生 Skill 目录**。启用 OpenCode 集成时客户端会下载到 `~/.config/opencode/skills/missiongo/SKILL.md`，不会覆盖更新的本地副本或符号链接。已有 `~/.claude/skills/missiongo/` 的机器仍按 OpenCode 自身的兼容读取方式处理，但不作为 MissionGo 的同步目标。
- 对于 Mac mini 运行共享服务、MacBook 和手机连接它的部署，只在 **Mac mini** 的 MissionGo 节点启用 OpenCode 并把产品仓库映射到 Mac mini 上的真实路径。手机和 MacBook 作为 OpenCode 远程界面使用，不需要承担这次派单的仓库执行。

**客户端集成需要在本机明确启用。** 首次安装或从旧版本升级后，各集成都默认未启用。
在菜单中分别点击「启用…」，确认用途后才运行该客户端的登录检查，并下载 Skill 到它自己的
`~/.claude/skills/missiongo/`、`$CODEX_HOME/skills/missiongo/` 或 `~/.config/opencode/skills/missiongo/`。不会同时访问另一个未启用的客户端。
本地版本更新、或者目标是符号链接时不覆盖。之后需要更新 Skill 或修复登录时，点击该客户端的「重新检查」。
心跳、打开菜单和重启不再自动检查客户端登录或同步 Skill；安装新 CLI 后也需手动重新检查以更新上报版本。

拒绝访问、检查失败或派单启动失败后，该集成暂停并保留具体原因，重启仍保持暂停，直到用户重新检查成功。
暂停按客户端独立生效；不影响另一个客户端，也不终止已启动的会话。停用时已经开始的派单启动操作可能完成，
但其完成结果不会重新启用集成。未启用/暂停时，旧的服务端派单也不能绕过本地检查。

## 2. 安装

1. 在控制台侧边栏「下载」或「Agent 管理」点「下载 macOS 客户端」，解压，把 MissionGo 拖进「应用程序」。
2. 发布流程默认要求 Developer ID 签名和 Apple 公证；经明确选择也可发布无证书的临时签名包。临时签名包可能被系统拦截，也可能在升级后重新要求授权；
   不应把“关闭系统保护”或“授予全盘访问”作为通用安装步骤。下载可信临时签名包后如被系统阻止，按 macOS 提示手动确认打开。
3. 菜单栏出现 MissionGo 图标。点「登录 MissionGo」，浏览器会打开授权页；输入账号密码确认后回到客户端，
   这台 Mac 就登记好了，控制台「Agent 管理」的设备列表里会出现它。

登录后按需启用客户端集成。需要开机启动时，手动打开菜单里的「开机自启」；登录不会自动注册登录项。
已经启用的登录项不受升级影响。

## 3. 升级

**客户端自己检查更新。** 登录后它会读服务器上的
`/downloads/missiongo-macos-latest.json`，和自己的版本逐段比数字，之后每 6 小时再看一次；菜单里的
「检测更新」也能立即检查并明确提示已经是最新版。有新版时会弹窗列出版本、发布时间、合并的 PR 和条目，
只有点「同意更新」才安装；点「稍后」会在菜单中保留提示。

同意之后会先重新读取清单，再下载安装包、核对 sha256、解压、检查解出来的确实是这个版本的 MissionGo、替换
「应用程序」里的这一份，然后退出并自动重新打开。**已经在跑的 agent 会话不受影响**——它们是独立进程，
退出、登出、更新客户端都不会打断它们。

安装是手动的一步；检查既有定期自动检查，也能手动触发。更新会让客户端重启，这件事不该在人不知道的时候发生。

心跳还会带回服务端期望的 missiongo Skill 版本；客户端只为已经由用户启用的 Agent 自动同步，且不会覆盖
更新的本地副本或软链接。同步尚未完成时，版本不一致的派单仍按现有预检规则拦截。

出问题时这一行会变成橙色并写明原因。两种常见情况：

- 「应用程序」写不进去（不是管理员、或者 App 是从磁盘映像里直接运行的）——按第 2 节重新下载、手工替换。
- 下载校验不通过——多半是没下完，过一会儿再点一次。

发布一个新版本是另一回事，见 `scripts/publish-macos.sh`：改了 `apps/macos/` 下任何东西之后，
必须先把 `apps/macos/version.properties` 里的版本号抬上去，否则发布脚本会拒绝——同一个版本号对应两个
不同的构建，客户端就没法判断该不该更新了。

## 4. 选择仓库

在客户端菜单里，每个产品一行「选择文件夹…」，选中这个产品在本机对应的仓库目录即可。控制台里新建的产品
最多 30 秒就会自己出现在这个列表里，不用退出客户端重进。选好的映射会同步到
服务端，控制台「Agent 管理」里每台设备的卡片上列出你能看到的所有产品，也能在那里改。
目录不是 git 仓库时，客户端当场提示。Claude Code 的目录信任在真实派单启动前检查；选择仓库不会顺带读取
Claude 配置。候选列表只来自这台节点已有的仓库映射，不再遍历 Claude 的历史项目，也不在心跳中访问候选目录。

设备和仓库映射都属于账号，不属于某个产品，所以不用在每个产品的设置里各配一次（AND-51）。
你失去某个产品的权限后，那个产品的映射不再显示，也不会被你的保存覆盖或删除；权限恢复后它还在。
账号被停用或删除后，它名下的设备立即无法再心跳和领取派单。

一次派单里的条目必须落在同一个仓库：一个会话只能在一个 checkout 里跑。

派单要求账号对这些条目的产品有「AI 调用」权限（AND-68）；只有「操作」权限可以人工处理，但不能派单。

## 5. 派单之后

- Claude Code 会话在后台运行。使用官方订阅且 Claude Code 提供 Remote Control 时，可以在 claude.ai/code 或手机上接管、批准计划；使用自定义 API 地址（如 GLM）时，Claude Code 不提供 Remote Control，改在 MissionGo 会话里查看、回复和审批，Mac 节点需保持在线。
- Codex 会话出现在 Codex App（包括远程控制这台 Mac 的另一台电脑）和 ChatGPT 手机 App 里，名字是
  「机器昵称-条目编号」，在那里查看、回复和批准。一次派多条时，同一产品的编号只写一次前缀，
  例如 `M4-HG-52,51,50,48,44,43`；名字太长才截断成「…等 N 条」。它的链接是 `codex://threads/<ID>`，只能在装了 Codex App
  的 Mac 上点开。
- OpenCode 会话创建在该 Mac 已运行的共享服务中，同一服务的 MacBook 和手机客户端可以打开它。MissionGo 用设备昵称和条目编号命名会话，并在自己的会话页镜像可见的对话、接收回复与中断请求；当前不提供 OpenCode 深链。OpenCode 服务和 MissionGo 节点都要保持在线，MissionGo 内的回复才能送达。
- 客户端菜单的「最近派单」里能看到派给了哪个 agent、什么模式、状态和失败原因；有外部链接时可点开。没有 Remote Control 链接的 Claude Code 会话请在 MissionGo 控制台查看。
- Claude Code 仍在仓库主目录启动（不带 `-w`），保持项目归属和 `/resume` 行为；批准后按仓库规则创建独立 worktree，权限由 Claude Code 自身管理。
- Codex 同样在主目录启动，同时只为本次派单预留一个同级 `missiongo-<完整派单编号>` 路径，通过 `runtimeWorkspaceRoots` 配置写权限，不提前建目录或分支。已有同名目录或符号链接会使派单失败，不覆盖、不清理。如果仓库要求其他位置，会话须先申请该精确路径的权限；`cd` 本身不改变沙箱。
- Codex 返回的实际 reviewer、审批策略、沙箱和工作区范围须与派单要求相符才发送首轮提示词。旧客户端忽略参数或组织策略不允许时明确报错，不静默改用人工审查。
- 派单不改条目状态。条目仍是待处理，由会话按 Skill 自己领取。

## 6. 验证没通过，再派一次

条目进入待验证后原会话仍可继续回复，便于讨论验收和发布；只有条目全部完成后会话才会关闭。
待验证被打回（或完成后被重新打开）会回到待处理；需要改代码时重新派单并使用新的分支和 worktree：

- 原会话的分支已经合并删除，它自己也认为活干完了，接着用它反而容易被旧上下文带偏；退回的原因记在条目时间线上，
  新会话读条目就能拿到。要是只改一处小地方，也可以自己点开上一次的会话链接接着聊。
- 已经被会话领取过的旧派单不再算「已派出未领取」，所以不会再弹「确认上一次的会话已经不在了」的提示。
- 同一条目已经有会话时，新会话的名字末尾带轮次，例如 `M4-HG-52 第2轮`，不会和上一次重名。一批里各条轮次不同时
  取最大的。只算真正交到机器上的派单：排队时被取代的、启动失败的不算。
- 提示词会点出哪些条目是返工，要求先读最近一次退回的说明和上一轮的 PR，再从最新的 main 另开分支。服务端只传返工
  条目的编号，具体怎么说由本机决定。
- 这两项需要新版客户端；旧客户端照常能派，只是名字不带轮次、提示词里没有返工这段。

## 模式

| 模式 | Claude Code | Codex | OpenCode |
|---|---|---|---|
| 计划 | 原生 plan 模式，加计划提示词 | 提示词要求等待方案批准；技术权限请求由自动审查处理，保留可写工作区沙箱 | 原生 plan agent；批准后手动切换到 build agent |
| 默认 | default | 可写工作区沙箱；越出沙箱的操作由你在 App 里批准 | build agent，权限由 OpenCode 自身控制 |
| 自动接受编辑 | acceptEdits | 不提供 | 不提供 |
| 自动 | auto | 可写工作区沙箱；越出沙箱的操作交给 Codex 的自动审核 | 不提供 |
| 无需确认（保留硬拦截） | bypassPermissions | 不提供 | 不提供 |

计划模式下，先读条目并澄清问题，在会话中给出方案，停下等待批准。批准前不评论、不领取、不建分支或 worktree、不改代码。
批准后先写已批准的计划评论，再领取、创建 worktree 并实施；Claude Code 须先退出原生 plan 模式。Codex 的计划等待依赖提示词和 Skill，自动权限审查不代表方案已被批准。

节点登录与 AI 客户端 OAuth 是不同的授权，`mcp list` 显示已配置/已登录不能证明拥有写权限。Codex 在发送任务首轮之前通过该线程自己的 MCP 连接调用只读的 `get_current_account`，核对 `canComment`、`append_comment`、`claim_item` 以及本地/服务端 Skill 版本；能力缺失、版本不符或接口不支持时派单明确失败。节点不读取或借用客户端令牌。

Claude Code 的权限能力由会话首步调用 `get_current_account` 核对，实施前需确认评论与领取能力；不把节点的登录当作 Claude Code 已授权。缺少授权时说明需要在哪个客户端完成授权，并停在实施之前。启动时优先尝试 Remote Control；若 CLI 明确不支持（包括自定义 API 地址），则保留同一会话的本机 MissionGo 控制，不重复启动第二个会话。

Claude Code 的 `bypassPermissions` 仅按账户所有者明确配置后由 MissionGo 派单提供；节点仍通过
`--disallowedTools` 硬性拒绝不可逆 Git 清理和强制推送。`dontAsk` 仍不可用。Codex 的审批策略
`never` 和沙箱 `danger-full-access` 仍由服务端和客户端拒绝。

## 登录与凭证

客户端用 MissionGo 现有的 OAuth 登录（权限 `missiongo:node`），拿到登录令牌后立刻换成这台 Mac 专属的机器
凭证，登录令牌随即丢弃；机器凭证存在钥匙串里。

- 同一台 Mac 退出登录后再登录，找到的是同一台机器：仓库映射和派单历史都在，旧凭证在新凭证发出的同时失效。
- 在控制台「撤销」这台机器，客户端马上回到「请登录」状态；之后重新登录可以恢复。
- 在控制台改过的机器名，重新登录不会被覆盖。

## 排障

| 现象 | 原因 | 处理 |
|---|---|---|
| 打开时提示「无法验证开发者」 | 旧版临时签名包、开发包或签名异常 | 核对下载来源与版本，获取正式签名包；不要扩大系统权限 |
| 菜单显示 Claude Code 未安装 | 在继承的 PATH 和常见安装位置找不到 `claude` | 确认 CLI 已安装；自定义位置可点「导入终端 PATH…」并确认执行一次登录配置，之后点「重新检查」。导入结果保存，重启不重新执行配置 |
| 菜单显示 Claude Code 未登录 | CLI 登录过期 | 终端里运行 `claude auth login` |
| 派单失败，原因写着目录未信任 | 仓库没被 Claude Code 信任过 | 在该目录手动运行一次 `claude` 并确认信任 |
| 显示离线 | 网络不通，或凭证被撤销 | 菜单里会写明原因；被撤销就重新登录 |
| Claude Code 会话没有远程链接 | 自定义 API 地址下 Remote Control 不可用，这是预期行为；会话仍可由 MissionGo 控制 | 在 MissionGo 会话内查看、回复和审批，保持 Mac 节点在线；如连会话消息都没有，再查看 `~/Library/Logs/MissionGo/<派单 ID>.log` |
| 菜单显示 Codex 后台服务未运行 | 控制通道没有应答，而且客户端自动运行 `codex app-server daemon start` 后仍没有连上 | 在终端运行菜单里复制出的 `codex app-server daemon start`，看它报什么错；要常驻就再跑一次 `codex app-server daemon bootstrap` |
| Codex 派单失败，提示 missiongo MCP 未配置或未登录 | Codex 连不上 MissionGo | 运行菜单里复制出的命令 |
| OpenCode 显示共享服务不可用 | OpenCode 2 服务未运行或登记文件无效 | 在这台 Mac 上启动 OpenCode 共享服务，然后点击「重新检查」 |
| OpenCode 显示 missiongo MCP `needs_auth` | OpenCode 尚未完成 MissionGo 授权 | 在 OpenCode `/mcps` 中登录，再点击「重新检查」 |
| 菜单里 missiongo Skill 一行显示失败 | 下载不到，或写不进 skills 目录 | 修复提示中的问题，再点击对应客户端「重新检查」；不会后台反复重试 |
| 菜单显示集成未启用或已暂停 | 未授权本机集成、检查未完成或启动失败 | 在本机确认用途后启用/重新检查；不会自动替用户批准 macOS 权限 |
| 启动时提示未自动读取登录凭据 | 钥匙串要求用户交互 | 点击登录，在前台处理系统授权；后台启动不弹钥匙串确认框 |

## 发布签名与权限回归

默认发布使用稳定的 Developer ID Application 身份。把证书及私钥导入本机钥匙串，并用 `notarytool`
在钥匙串中保存公证凭据；不要把证书私钥、密码或真实账号提交到仓库。发布环境配置提供：

```sh
MISSIONGO_MACOS_SIGNING_IDENTITY='Developer ID Application: <开发者名称> (<Team ID>)'
MISSIONGO_MACOS_NOTARY_PROFILE='<本机钥匙串中的公证配置名>'
```

`publish-macos.sh` 默认缺少以上配置时在构建前失败；构建后依次签名（hardened runtime）、提交公证、检查 Accepted、
装订并验证票据、检查 Gatekeeper，最后重新打包。失败时不更新公开产物或发布记录。CI 的
`build-macos-app.sh` 仍可生成临时签名开发包。默认发行版的自动更新先通过系统校验，不再删除隔离属性。
签名流程通过不代表获得了任何隐私权限，也不保证旧版临时签名应用的既有授权能直接迁移；首次迁移可能仍需用户确认。

继续无证书发行必须显式执行 `npm run publish:macos -- --allow-ad-hoc`。此模式不要求 Developer ID 或公证，
但仍验证代码签名完整性、记录来源提交与 SHA-256，并在发布元数据记录 `signing_mode=adhoc`。
只有这种显式构建的客户端允许安装通过完整性校验的后续临时签名更新；该许可写在本机应用中，下载清单不能开启它。
Developer ID 发行版不会因此自动降级。两种模式都保留隔离属性和系统启动检查，不修改系统权限；
临时签名下升级后仍可能重新要求系统授权，不承诺“只授权一次”。

自动测试覆盖禁用客户端零探测、客户端互不影响、失败跨重启保持暂停、异步旧结果不恢复权限、Skill 下载后取消不写入、
启动不执行 shell 配置及签名/公证失败路径。以下需在真实 macOS 用户账户验证（测试不自动点授权按钮）：

- 首次启动及打开菜单：没有历史项目文件夹、其他客户端或登录项权限请求。
- 只启用一个客户端：只出现该集成实际需要的系统请求；另一个客户端不运行、不写文件。
- 拒绝一次后等待多个心跳并重启：保持暂停，不再次尝试；点击重新检查才重试。
- 分别用 Claude Code 和 Codex 派单：原生模式、计划确认和任务链接保持原流程。
- 使用同一 Developer ID 连续安装两个已公证版本，核对钥匙串和文件权限的延续情况。

## 边界

- 服务端不会看到机器上跑了什么命令，也不记录会话内容；它只知道启动成功与否和会话地址（Codex 是会话 ID）。
- 没有定时和无人值守：每一次派单都是人在控制台点的。
