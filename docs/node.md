# AI 节点

节点是一台你自己的机器，它主动连到 MissionGo 拉取派单，然后在本机启动一个 AI 会话处理这批条目。
服务端不开放任何指向机器的端口，也不下发 Shell 命令——只下发条目编号、agent、模式和仓库路径。

首版只接 Claude Code。Codex 和 Hermes 的适配器接口已经留好，但还没有实现。

## 机器上要先具备什么

这三项不满足时，节点会直接回报失败，而不是让会话卡在一个没人按的确认框上：

1. **装了 Claude Code**，`claude --version` 能跑。
2. **Claude Code 已登录**：`claude auth status` 返回 `"loggedIn": true`。没登录就跑
   `claude auth login`。桌面 App 的登录不算，CLI 的登录是独立的。
3. **仓库目录已经被 Claude Code 信任过**：在那个目录下手动跑一次 `claude` 并选「Yes, I trust this
   folder」。没信任过的目录，会话一启动就停在信任确认框上，永远等不到人。

派单会话起在仓库主目录本身，不带 `-w`。Claude Code 按工作目录归档会话，worktree 会被当成另一个项目，
在主目录 `/resume` 里就找不到这次派单的会话了。隔离仍然要做，只是改由会话自己按仓库规则建 worktree，
启动提示词里写明了这一点。

## 配对

1. 在控制台的设置页点「添加机器」，填一个名字，拿到配对码（10 分钟内有效，只能用一次）。
2. 在那台机器上执行：

   ```bash
   missiongo-node pair <配对码> --server https://你的-missiongo-地址
   ```

   配对成功后，凭证写在 `~/.missiongo-node/config.json`，权限 0600。这个凭证长期有效，
   在控制台点「撤销」即刻失效。

3. 启动常驻进程：

   ```bash
   missiongo-node run
   ```

   它每 30 秒上报一次心跳（连同本机检测到的 agent 和版本），每 5 秒问一次有没有新派单。
   超过 90 秒没有心跳，控制台就把这台机器显示为离线，也不允许派单给它。

## 配置仓库映射

在控制台里为每台机器填「产品 → 仓库绝对路径」。产品不是仓库，这层对应关系没法自动推断，只能写。

一次派单里的条目必须落在同一个仓库：一个会话只能在一个 checkout 里跑。勾选的条目跨了两个产品、
而这两个产品映射到不同仓库时，控制台会拒绝并说明原因。

## 开机自动运行（launchd）

把下面的 plist 存成 `~/Library/LaunchAgents/net.missiongo.node.plist`，按需要改路径，然后
`launchctl load -w ~/Library/LaunchAgents/net.missiongo.node.plist`。

```xml
<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>Label</key><string>net.missiongo.node</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>/绝对路径/missiongo/apps/node/dist/cli.js</string>
    <string>run</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/tmp/missiongo-node.log</string>
  <key>StandardErrorPath</key><string>/tmp/missiongo-node.log</string>
</dict>
</plist>
```

## 排障

| 现象 | 原因 | 处理 |
|---|---|---|
| 控制台里机器一直离线 | `missiongo-node run` 没在跑，或者服务端地址不对 | 看 `~/.missiongo-node/config.json` 和进程日志 |
| 派单状态停在「失败」，原因写着未登录 | CLI 登录过期 | 在那台机器上跑 `claude auth login` |
| 失败原因写着目录未信任 | 仓库没被 Claude Code 信任过 | 在该目录手动跑一次 `claude` 并确认信任 |
| 会话起来了但控制台没有链接 | 日志里还没出现会话地址，或 Remote Control 没连上 | 看 `~/.missiongo-node/logs/<派单 ID>.log` |
| 派单按钮点不动 | 条目不是待处理，或产品没有映射仓库 | 只有待处理的条目能派；先把仓库映射填上 |

## 边界

- 派单不改条目状态。条目仍是待处理，由会话按 Skill 自己 `claim_item` 领取。
- 服务端不会看到机器上跑了什么命令，也不记录会话内容；它只知道启动成功与否和会话地址。
- 没有定时和无人值守：每一次派单都是人在控制台点的。
