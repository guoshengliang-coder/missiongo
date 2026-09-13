# AI 节点

节点是一台你自己的机器，它主动连到 MissionGo 拉取派单，然后在本机启动一个 AI 会话处理这批条目。
服务端不开放任何指向机器的端口，也不下发 Shell 命令——只下发条目编号、agent、模式和仓库路径。

首版只接 Claude Code。Codex 和 Hermes 的适配器接口已经留好，但还没有实现。

控制台「管理产品 → 执行机器」页里有同样的分步引导，命令带着你的服务地址和配对码，可以直接复制。

## 1. 机器上要先具备什么

下面几项不满足时，节点会直接回报失败并写明原因，而不是让会话卡在一个没人按的确认框上：

1. **Node 22 或更新**：`node --version`。没有就 `brew install node`。
2. **装了 Claude Code**，`claude --version` 能跑。
3. **Claude Code 已登录**：`claude auth status` 返回 `"loggedIn": true`。没登录就跑
   `claude auth login`。桌面 App 的登录不算，CLI 的登录是独立的。
4. **仓库目录已经被 Claude Code 信任过**：在那个目录下手动跑一次 `claude` 并选「Yes, I trust this
   folder」。没信任过的目录，会话一启动就停在信任确认框上，永远等不到人。

## 2. 下载

节点程序是一个不依赖任何 npm 包的单文件，随服务端一起发布：

```bash
mkdir -p ~/.missiongo-node && curl -fsSL https://你的-missiongo-地址/downloads/missiongo-node/missiongo-node.mjs -o ~/.missiongo-node/missiongo-node.mjs
```

以后要更新，重跑这一条再重启服务即可（`install-service` 会替换正在运行的那份）。

## 3. 配对

1. 在控制台「执行机器」页填一个名字，点「生成配对码」。配对码 10 分钟内有效，只能用一次。
2. 在那台机器上执行（页面上生成的命令已经带好了配对码和地址）：

   ```bash
   node ~/.missiongo-node/missiongo-node.mjs pair <配对码> --server https://你的-missiongo-地址
   ```

   配对成功后，凭证写在 `~/.missiongo-node/config.json`，权限 0600，终端里不会打印它。这个凭证
   长期有效，在控制台点「撤销」即刻失效。

## 4. 常驻运行

```bash
node ~/.missiongo-node/missiongo-node.mjs install-service
```

它会写好 `~/Library/LaunchAgents/net.missiongo.node.plist` 并立即启动：关掉终端、重启电脑后都会
继续在线，日志在 `~/.missiongo-node/logs/daemon.log`。不想要了就 `uninstall-service`。

安装时会把当前终端的 `PATH` 写进服务配置。launchd 默认只有 `/usr/bin:/bin`，找不到装在
`~/.local/bin` 或 Homebrew 下的 `claude`——那样节点能上线，却报不出任何 agent。所以请在一个能直接
运行 `claude` 的终端里执行安装；以后如果移动了 `claude` 的位置，重装一次服务。

只想临时跑一下，用前台模式 `node ~/.missiongo-node/missiongo-node.mjs run`，关掉终端就离线。

目前只支持 macOS 的 `install-service`。其他系统用 `run`，交给自己的进程管理器常驻。

节点每 30 秒上报一次心跳（连同本机检测到的 agent 和版本、本机可用的仓库），派单用长轮询拉取：
机器挂着请求等，有派单立即送达。超过 90 秒没有心跳，控制台就把这台机器显示为离线，也不允许派单给它。

## 5. 配置仓库映射

节点会上报本机 Claude Code 打开过、已信任、并且确实是 git 仓库的目录，控制台据此给每个产品提供下拉
选择；目录名和产品名能对上的会被标成「建议」预选，保存前需要你确认。从没用 Claude Code 打开过的仓库
不在列表里，选「手动输入」填绝对路径即可。上报的只有路径和目录名，不包括 git remote。

一次派单里的条目必须落在同一个仓库：一个会话只能在一个 checkout 里跑。勾选的条目跨了两个产品、
而这两个产品映射到不同仓库时，控制台会拒绝并说明原因。

派单会话起在仓库主目录本身，不带 `-w`。Claude Code 按工作目录归档会话，worktree 会被当成另一个项目，
在主目录 `/resume` 里就找不到这次派单的会话了。隔离仍然要做，只是改由会话自己按仓库规则建 worktree，
启动提示词里写明了这一点。

## 排障

| 现象 | 原因 | 处理 |
|---|---|---|
| 控制台里机器一直离线 | 服务没在跑，或者服务端地址不对 | 看 `~/.missiongo-node/logs/daemon.log` 和 `~/.missiongo-node/config.json` |
| 机器在线但没有 Claude Code | 服务的 `PATH` 里找不到 `claude` | 在能直接运行 `claude` 的终端里重跑 `install-service` |
| 派单状态停在「失败」，原因写着未登录 | CLI 登录过期 | 在那台机器上跑 `claude auth login` |
| 失败原因写着目录未信任 | 仓库没被 Claude Code 信任过 | 在该目录手动跑一次 `claude` 并确认信任 |
| 仓库下拉里没有想要的目录 | 这个目录没被 Claude Code 打开过，或不是 git 仓库 | 在该目录跑一次 `claude`，或选「手动输入」 |
| 会话起来了但控制台没有链接 | 日志里还没出现会话地址，或 Remote Control 没连上 | 看 `~/.missiongo-node/logs/<派单 ID>.log` |
| 派单按钮点不动 | 条目不是待处理，或产品没有映射仓库 | 只有待处理的条目能派；先把仓库映射填上 |

## 边界

- 派单不改条目状态。条目仍是待处理，由会话按 Skill 自己 `claim_item` 领取。
- 服务端不会看到机器上跑了什么命令，也不记录会话内容；它只知道启动成功与否和会话地址。
- 没有定时和无人值守：每一次派单都是人在控制台点的。
