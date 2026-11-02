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
升级 Node 路径或 npm prefix 后重新安装 unit。systemd 用户环境须包含 Agent 实际需要的配置；
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
