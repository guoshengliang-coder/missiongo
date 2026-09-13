# @missiongo/node · 机器端守护进程

在开发机上常驻，从 MissionGo 服务端拉取派单，并为每一次派单启动一个可远程接管的 Claude Code 会话。

它只做出站请求：不监听端口，不接受连接。服务端下发的只有条目编号、agent、模式和仓库路径，**启动提示词固定在本机**（`src/prompt.ts`），服务端无法决定告诉会话做什么。派单本身不改条目状态；会话按 missiongo Skill 的规则自己领取条目。

安装、配对和常驻运行的完整步骤见 [`docs/node.md`](../../docs/node.md)，控制台「执行机器」页里也有同样的引导。这里只记开发者需要知道的。

## 分发

操作者拿到的不是这个 workspace，而是 `npm run bundle` 打出的单文件 `dist/missiongo-node.mjs`：`@missiongo/domain` 被内联进去，只剩 Node 内置模块。部署时 `deploy/Dockerfile` 构建它、先跑一次 `--help` 确认能起来，再挂到 `/downloads/missiongo-node/missiongo-node.mjs`，所以每次部署都会发布最新版本。

```bash
npm run bundle --workspace @missiongo/node
node apps/node/dist/missiongo-node.mjs --help
```

## 启动会话时的硬约束

派出去的会话没有人守着，所以凡是平时表现为「弹个框等你点」的情况，都必须提前满足，否则会话会一直挂着不动，而控制台看起来一切正常。以下都在真机上验证过：

1. 启动命令用 `script -q /dev/null` 包一层，给 CLI 一个 pty——守护进程里没有 TTY，不包这一层会话起不来。
2. 固定带 `--no-chrome`，否则首次运行会停在 Chrome 扩展确认框上。
3. `claude auth status` 必须是 `loggedIn: true`，未登录直接把派单标为失败。
4. 仓库目录必须已被信任（`~/.claude.json` 的 `projects["<路径>"].hasTrustDialogAccepted`），否则会话永远停在信任对话框上。
5. 会话起在仓库主目录，不带 `-w`：Claude Code 按工作目录归档会话，起在 worktree 里的会话在该仓库的 `/resume` 里找不到。提示词要求会话自己建 worktree。

`install-service` 写 launchd 配置时会带上安装那一刻的 `PATH`。launchd 默认只有 `/usr/bin:/bin`，找不到 `claude`，节点会上线却报不出 agent。

## 运行时行为

- 每 30 秒上报一次心跳：本机检测到的 agent 及版本，以及本机可用的仓库（`src/repo-candidates.ts`，只含路径和目录名）。
- 派单用长轮询：请求服务端挂起最多 25 秒，有派单立即返回；空轮询之间只停 250ms。
- 每次派单的输出写在 `~/.missiongo-node/logs/<dispatchId>.log`。最多等 60 秒从日志抓取 `https://claude.ai/code/session_…` 会话地址；抓不到仍按 `launched` 回报，此时只能按会话名在 claude.ai/code 里找。
- 网络抖动、服务端重启、单次请求失败都只记一行日志，不退出。只有机器凭证失效（401/403）才会停下并以非零码退出；launchd 配置里的 `ThrottleInterval` 防止它被紧密循环地重启。
- `MISSIONGO_NODE_HOME` 可以把配置和日志目录换到别处，用于在同一台机器上跑第二个实例或对着测试服务端验证。

## 支持的 agent

首版只有 Claude Code。新增 agent 时实现 `src/agents/types.ts` 里的 `AgentAdapter`，放在 `src/agents/` 下，并注册到 `src/cli.ts` 的适配器列表；循环、配置和回报都不需要改。

## 开发

```bash
npm run test --workspace @missiongo/node
npm run typecheck --workspace @missiongo/node
```
