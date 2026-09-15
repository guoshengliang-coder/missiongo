# 执行机器（macOS 客户端）

执行机器是一台你自己的 Mac。它运行 MissionGo 客户端，主动连到服务端拉取你在控制台派出的任务，然后在本机
启动 Claude Code 或 Codex 会话处理这批条目。服务端不开放任何指向机器的端口，也不下发 Shell 命令——只下发
条目编号、agent、模式和仓库路径；启动会话用的提示词写死在客户端里，两个 agent 收到的提示词完全一样。

目前支持 Claude Code 和 Codex，Hermes 暂不支持。

## 1. 机器上要先具备什么

- macOS 13 或更新。
- **装了 Claude Code 并已登录**：终端里 `claude auth status` 显示已登录；没登录就运行 `claude auth login`。
  桌面 App 的登录不算，CLI 的登录是独立的。客户端会检测这一项，没满足时直接在菜单里告诉你。
- **仓库目录被 Claude Code 信任过**：在那个目录里手动运行一次 `claude`，选「Yes, I trust this folder」。
  没信任过的目录，会话一启动就会停在信任确认框上，而派出去的会话旁边没有人。

用 Codex 派单时（两个 agent 可以只装一个）：

- **ChatGPT App 已安装、已登录并保持运行**。Codex 会话是通过 ChatGPT App 内置的 Codex 后台服务创建的，
  App 没开，客户端连不上它的控制通道，派单会失败并提示打开 App。终端里 `codex login status` 应显示已登录。
- **Codex 配好了 missiongo MCP 并已登录**：

  ```bash
  codex mcp add missiongo --url <MissionGo 地址>/mcp && codex mcp login missiongo
  ```

  客户端检测到缺失时，菜单里有「复制命令」，复制出来的就是指向当前登录服务器的这条命令。

**missiongo Skill 不用手动装。** 客户端登录后会从服务器下载最新的 SKILL.md，写进
`~/.claude/skills/missiongo/` 和 `~/.codex/skills/missiongo/`（只写本机装了的 agent；本地版本更新、或者
那个位置是符号链接时不覆盖），之后每小时检查一次。菜单里「missiongo Skill」一行显示同步到的版本。

## 2. 安装

1. 在控制台侧边栏「下载」或「管理产品 → 执行机器」点「下载 macOS 客户端」，解压，把 MissionGo 拖进「应用程序」。
2. 第一次打开会被系统拦下。到「系统设置 → 隐私与安全性」，在页面下方点「仍要打开」。
   客户端目前没有做 Apple 签名，这一步每台 Mac 只需要一次。
3. 菜单栏出现 MissionGo 图标。点「登录 MissionGo」，浏览器会打开授权页；输入账号密码确认后回到客户端，
   这台 Mac 就登记好了，控制台的机器列表里会出现它。

登录成功后客户端默认开机自启，可以在菜单里关掉。

## 3. 选择仓库

在客户端菜单里，每个产品一行「选择文件夹…」，选中这个产品在本机对应的仓库目录即可。选好的映射会同步到
服务端，控制台上也能看到、也能改。目录不是 git 仓库、或没被 Claude Code 信任过时，客户端当场提示。

一次派单里的条目必须落在同一个仓库：一个会话只能在一个 checkout 里跑。

## 4. 派单之后

- Claude Code 会话在后台运行，可以在 claude.ai/code 或手机上接管、批准计划。
- Codex 会话出现在 Codex App（包括远程控制这台 Mac 的另一台电脑）和 ChatGPT 手机 App 里，名字是
  「机器昵称-条目编号」，在那里查看、回复和批准。一次派多条时，同一产品的编号只写一次前缀，
  例如 `M4-HG-52,51,50,48,44,43`；名字太长才截断成「…等 N 条」。它的链接是 `codex://threads/<ID>`，只能在装了 Codex App
  的 Mac 上点开。
- 客户端菜单的「最近派单」里能看到状态和失败原因，点一下打开会话链接。
- 会话起在仓库主目录（不带 `-w`），这样它归在这个项目下，在主目录 `/resume` 能找到；动手改代码前，会话会
  按仓库规则自己建独立 worktree。
- 派单不改条目状态。条目仍是待处理，由会话按 Skill 自己领取。

## 模式

| 模式 | Claude Code | Codex |
|---|---|---|
| 计划 | 原生 plan 模式，加计划提示词 | 只靠计划提示词，沙箱仍可写 |
| 默认 | default | 可写工作区沙箱；越出沙箱的操作由你在 App 里批准 |
| 自动接受编辑 | acceptEdits | 不提供 |
| 自动 | auto | 可写工作区沙箱；越出沙箱的操作交给 Codex 的自动审核 |

计划模式下，会话先读完条目，把计划写成条目评论，然后在会话里停下等你批准；批准之前不领取、不改代码。
Codex 没有强制的计划模式，这完全依赖模型遵守提示词和 Skill。

两个 agent 都拿不到「绕过权限」类的模式：Claude Code 的 `bypassPermissions`、`dontAsk`，Codex 的
审批策略 `never` 和沙箱 `danger-full-access`，服务端和客户端都会拒绝。

## 登录与凭证

客户端用 MissionGo 现有的 OAuth 登录（权限 `missiongo:node`），拿到登录令牌后立刻换成这台 Mac 专属的机器
凭证，登录令牌随即丢弃；机器凭证存在钥匙串里。

- 同一台 Mac 退出登录后再登录，找到的是同一台机器：仓库映射和派单历史都在，旧凭证在新凭证发出的同时失效。
- 在控制台「撤销」这台机器，客户端马上回到「请登录」状态；之后重新登录可以恢复。
- 在控制台改过的机器名，重新登录不会被覆盖。

## 排障

| 现象 | 原因 | 处理 |
|---|---|---|
| 打开时提示「无法验证开发者」 | 客户端未做 Apple 签名 | 「系统设置 → 隐私与安全性」里点「仍要打开」 |
| 菜单显示 Claude Code 未安装 | 客户端在登录 shell 的 PATH 里找不到 `claude` | 确认终端里能直接运行 `claude`，然后重新打开客户端 |
| 菜单显示 Claude Code 未登录 | CLI 登录过期 | 终端里运行 `claude auth login` |
| 派单失败，原因写着目录未信任 | 仓库没被 Claude Code 信任过 | 在该目录手动运行一次 `claude` 并确认信任 |
| 显示离线 | 网络不通，或凭证被撤销 | 菜单里会写明原因；被撤销就重新登录 |
| 会话起来了但没有链接 | 日志里还没出现会话地址，或 Remote Control 没连上 | 看 `~/Library/Logs/MissionGo/<派单 ID>.log` |
| Codex 派单失败，提示找不到控制通道 | ChatGPT App 没在运行 | 打开 ChatGPT App 并保持运行 |
| Codex 派单失败，提示 missiongo MCP 未配置或未登录 | Codex 连不上 MissionGo | 运行菜单里复制出的命令 |
| 菜单里 missiongo Skill 一行显示失败 | 下载不到，或写不进 skills 目录 | 看提示里的路径和原因 |

## 边界

- 服务端不会看到机器上跑了什么命令，也不记录会话内容；它只知道启动成功与否和会话地址（Codex 是会话 ID）。
- 没有定时和无人值守：每一次派单都是人在控制台点的。
