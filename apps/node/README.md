# @missiongo/node · 机器端守护进程

在开发机上常驻，从 MissionGo 服务端拉取派单，并为每一次派单启动一个可远程接管的 Claude Code 会话。

它只做出站请求：不监听端口，不接受连接。服务端下发的只有条目编号、agent、模式和仓库路径，**启动提示词固定在本机**（`src/prompt.ts`），服务端无法决定告诉会话做什么。派单本身不改条目状态；会话按 missiongo Skill 的规则自己领取条目。

## 三个前置条件

派出去的会话没有人守着，所以凡是平时表现为「弹个框等你点」的情况，都必须提前满足，否则会话会一直挂着不动，而控制台看起来一切正常：

1. **Claude Code 已登录**。`claude auth status` 必须返回 `{"loggedIn":true,...}`。未登录时守护进程直接把派单标为失败，并说明原因。
2. **仓库目录已被信任**。信任按绝对路径记录在 `~/.claude.json` 的 `projects["<路径>"].hasTrustDialogAccepted`。第一次映射一个仓库时，先在该目录手动运行一次 `claude` 并选择信任；不这样做，会话会永远停在 workspace trust 对话框上。会话自己用 `-w` 在已信任仓库下创建的 git worktree 不需要再信任一次。
3. **首次运行的 Chrome 扩展提示**由守护进程处理：启动命令固定带 `--no-chrome`，不需要人工干预。

另外，启动命令用 `script -q /dev/null` 包一层，给 CLI 一个 pty——守护进程里没有 TTY，不包这一层会话起不来。

## 安装

需要 Node.js 22.13+ 和已安装的 Claude Code。在仓库根目录：

```bash
npm ci
npm run build --workspace @missiongo/node
```

之后用 `node apps/node/dist/cli.js` 调用，或者把它链接成命令：

```bash
npm link --workspace @missiongo/node   # 提供 missiongo-node 命令
```

## 配对

在控制台的机器设置页生成一次性配对码，然后在本机执行：

```bash
missiongo-node pair <配对码> --server https://missiongo.example.com
```

配对成功后，服务地址、机器 token（形如 `mgn_…`）、机器编号和名称写入 `~/.missiongo-node/config.json`，权限 `0600`。token 只在配对时由服务端返回一次，命令不会把它打印出来。

## 运行

```bash
missiongo-node run
```

- 每 30 秒上报一次心跳，带本机检测到的 agent 及版本；控制台据此判断在线，并把配置好的「产品 → 仓库路径」映射回给本机（映射变化时会在日志里打印一行）。
- 每 5 秒拉取一次派单。拿到派单后做启动前检查，启动会话，然后把 `launched` 或 `failed` 回报给服务端。
- 每次派单的输出写在 `~/.missiongo-node/logs/<dispatchId>.log`。守护进程从日志里最多等 60 秒抓取 `https://claude.ai/code/session_…` 形式的会话地址；抓到就一起回报，抓不到仍按 `launched` 回报，此时只能按会话名（形如 `MissionGo AND-37+AND-38`）在 claude.ai/code 里找。
- 网络抖动、服务端重启、单次请求失败都只记一行日志，不退出。只有机器凭证失效（401/403，通常是机器已被撤销）才会停下来并以非零码退出。
- `Ctrl-C` 只停止拉取；已经启动的会话是 detached 的，不受影响。

## 常驻

macOS 下用 launchd 常驻，示例 plist 见 `docs/node.md`。守护进程不会自行安装任何开机项。

## 支持的 agent

首版只有 Claude Code。新增 agent 时实现 `src/agents/types.ts` 里的 `AgentAdapter`，放在 `src/agents/` 下，并注册到 `src/cli.ts` 的适配器列表；循环、配置和回报都不需要改。

## 开发

```bash
npm run test --workspace @missiongo/node
npm run typecheck --workspace @missiongo/node
```

只使用 Node 内置模块，没有第三方运行时依赖。
