# Linux headless 节点

支持 Ubuntu 22.04/24.04 x86_64，需要 Node.js 22.13 或更新版本、Git 和 util-linux 的 `flock`。
不需要桌面、浏览器、Swift 编译器或 root。三个 Agent 使用本机已有的配置、网关和认证。

从服务的下载页面取得 npm 安装包（及版本、来源提交与 SHA-256 清单），核对摘要后安装：

```sh
npm install --global ./missiongo-linux-latest.tgz
missiongo-node login --server https://missiongo.example.com
missiongo-node products
missiongo-node repo set <产品ID> /path/to/repository
missiongo-node agent enable claude_code
missiongo-node agent enable codex
missiongo-node agent enable opencode
missiongo-node doctor
missiongo-node run
```

登录会显示设备码和授权链接，可以在手机或另一台电脑完成；OAuth 临时访问令牌不落盘。
节点凭据是可撤销的设备令牌，仅写入当前用户 0700 目录内的 0600 文件，不输出到终端或日志。
仅显式启用的 Agent 会被检查、同步 Skill 和用于派单；未安装的 Agent 无需启用。
配置通过 `MISSIONGO_NODE_HOME` 或 `XDG_STATE_HOME` 选择，默认在用户状态目录的 `missiongo` 下。

自定义 CLI 路径可在启用时传 `--executable /path/to/cli`。启动节点前应在同一用户、同一环境中
配置好 Agent 的模型、第三方网关、代理和 `missiongo` MCP 读写授权，并确认仓库信任。
`doctor` 只验证节点授权、CLI/共享服务可用性和 Skill；不是模型调用成功的证明。
派单提示词要求 Agent 自己先核对 MCP 的实际评论及领取权限。Codex 还在首轮启动前通过
thread-scoped MCP 验证权限，拒绝未确认精确工作区和 reviewer 的旧版 app-server。

### Claude 的 nvm、环境脚本和启动器

`agent enable` / `agent check` 的 CLI 检查执行 `claude --version`，不会请求模型网关。
`Agent version check failed (exit …)` 表示命令自身退出失败；请核对 Node 版本、启动器和权限，
不能据此判断网关不可达。缺失可执行文件、超时和环境脚本失败会分别报告。

节点直接启动 CLI，不解析 `alias claude="nvm exec 22 claude"`，也不自动执行 `.bashrc`。
前台节点只继承启动它的终端环境，systemd 也不会自动读取另一个终端中的变量。
可以显式指定一个 Bash 环境脚本，将 nvm 和网关配置提取到同一入口，例如
`$HOME/.config/missiongo/claude-env.sh`（文件由你创建，建议权限为 `0600`）：

```bash
export NVM_DIR="$HOME/.nvm"
source "$NVM_DIR/nvm.sh" || return 1
nvm use --silent 22 >/dev/null || return 1
source "$HOME/.claude.bashrc.kimi" || return 1
```

脚本应导出变量、设置 PATH；不要启动 CLI、等待交互或发送模型请求。上例的网关文件须使用
`export` 设置变量。脚本由不加载 profile/rc 的非交互 Bash 执行；不要直接 source 带有
交互判断、提前 return 或启动其他程序的整份 `.bashrc`。脚本最多运行 5 秒，超时或失败不会
沿用上一次成功的解析结果放行。脚本输出不会进入版本、日志或状态报告。

```sh
missiongo-node agent enable claude_code --environment-script "$HOME/.config/missiongo/claude-env.sh"
missiongo-node agent check
missiongo-node doctor
```

脚本路径必须为可读文件的绝对路径；路径含空格也可以，调用时加引号。设置是本机对这个脚本的
显式执行授权。只保存脚本／启动器路径和重新检查标识，解析出的环境只保留在内存并传给 Claude
子进程，不写入节点配置、unit 或服务端。`CLAUDE_CONFIG_DIR` 同时用于该客户端的 Skill 同步。
不要把网关密钥写进命令参数、unit、条目评论或普通日志。

需要附加启动参数时，可用已有的 `--executable` 指定可执行包装脚本；它必须转发全部参数，并
保证 stdout 只含 Claude 原生输出。例如包装脚本最后执行 `exec /path/to/real/claude "$@"`。
检查与会话均使用这个启动器，环境脚本会在启动它之前加载。更改环境脚本设置时会保留已有启动器。

```sh
missiongo-node agent enable claude_code --executable /path/to/claude-wrapper
missiongo-node agent enable claude_code --clear-environment-script
missiongo-node agent enable claude_code --clear-executable
```

前台与 systemd 从同一个节点状态目录读取这些设置。心跳复用内存环境；修改脚本后运行
`agent check` / `doctor`（或重新 `agent enable`），运行中的节点在下一次心跳刷新环境。
每次新派单也重新加载脚本，并用同一份解析结果检查和启动 Claude；失败则不启动会话。
已有会话继续使用创建时的环境。清除脚本后恢复继承环境，不会撤销 Claude 自身配置中的认证。
环境脚本功能目前只用于 Claude Code，其他 Agent 保持原有配置方式。

Claude Code 通过 stream-json 控制通道运行；Codex 使用独立、受宿主管理的 app-server stdio 通道，
不要求 Mac App 或 macOS daemon；OpenCode 使用本机已登记的 V2 共享服务，不另开服务。
各 Agent 升级后需要验证协议兼容性；不支持的协议会明确失败，不降级为无限权限。
Claude 保留不可逆 Git 操作拒绝列表；Codex 始终 workspace-write/on-request，plan 和 auto 使用 auto-review。
计划批准与技术权限审查是两道不同的门，节点不能替人批准方案。

Web 派单、会话与文字回复、提问及权限请求通过原有节点 API 同步。Claude/OpenCode 的请求
显示为带请求标识的提问，Codex 使用审批卡；不能把普通文字当作批准其他请求或永久授权。
OpenCode 计划批准后，需在会话设置将 plan 切换为 default/build，才能实施。
未知或过期的审批保持未决。当前仅开放单次授权，不能从文字推断持久授权范围。

节点主循环重启后连接原宿主，回复命令先持久化再发给 Agent；确认丢失会进入
`delivery_unknown`，需在 Web 核对，不自动补发。Agent 宿主意外退出后不自动启动第二个会话。
现有宿主仍可运行；恢复失败会显示不可用，而不会冒充已经恢复。此版本不声明聊天附件、外部
原生会话接入、产物文件预览及托管执行能力，因此不拉取这些任务。

## 可选用户服务

```sh
missiongo-node service install
systemctl --user daemon-reload
systemctl --user enable --now missiongo-node
systemctl --user status missiongo-node
journalctl --user -u missiongo-node
```

安装命令只生成 unit 并打印上述明确操作。unit 固定安装时的 Node 路径、CLI 路径和 PATH；
升级 Node 路径或 npm prefix 后重新安装 unit。Claude 可通过上面的显式环境脚本取得 nvm 和网关配置；
其他 Agent 的 systemd 用户环境须包含它们实际需要的配置；
不要把密钥写入 unit 或普通日志。是否允许退出 SSH 后继续运行，依赖用户自己的 systemd/linger 设置。

服务使用内核 `flock` 防重复节点；停止/重启主循环不终止已有 Agent 宿主。宿主存活时不要删除
状态目录。修改凭据或切换账号前停止服务，并先处理旧会话；Web 撤销设备立即阻止后续服务器操作。

```sh
systemctl --user disable --now missiongo-node
missiongo-node service uninstall
systemctl --user daemon-reload
missiongo-node logout
```

`logout` 删除本地凭据；Web 撤销用于使正在运行的其他副本失效。卸载 npm 包前先卸载服务。

## 验证边界

CI 在 Ubuntu 22.04/24.04 上进行打包、安装与协议回归，涵盖设备码授权、配置权限、回复去重、
审批拒绝与隔离、节点重启。模拟协议不代表真实 Agent/网关或用户的 systemd 配置已验证。
正式验收须在目标 Ubuntu 上逐个 Agent 完成真实派单、回复、批准/拒绝、计划批准、断网恢复及
systemd 重启，并记录 CLI/网关版本。下载包存在和构建通过不代表已正式发布。
