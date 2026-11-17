# Windows 客户端

首版目标为 Windows 11 x64。默认在 Windows 原生环境运行；WSL 必须由用户在「本机设置」中明确选择发行版。桌面端负责设备登录、节点和本机配置，会话、条目、附件预览和审批继续使用同一 Web 控制台。

## 开发与验证

在仓库根目录执行：

```sh
npm ci
npm run check
npm run build:windows
npx playwright test --config playwright.windows.config.ts
```

在 Windows 上运行 `npx electron apps/windows/dist/app` 可启动开发版。`npm run build:windows -- --package --unsigned` 仅生成开发用 NSIS 安装包，不生成正式清单。用户已决定暂时未签名发布，主线正式工作流按 `product.json` 的明确策略使用 `--unsigned-release` 并保留来源证明；更新暂经控制台下载页手动安装。其他操作系统可构建和检查代码，不能生成 Windows 安装包。

CI 的 `windows-build` 作业在 Windows runner 上执行原生 DPAPI、ACL、命名管道互斥、PowerShell 环境、npm `.cmd` 参数测试，以及真实 Electron 本地 IPC 冒烟和开发包构建。Linux、Web/Server 与 macOS 原有检查继续执行。未实际执行的 CI 不能当作已通过。实际结果见 [本次验证记录](../../docs/windows-validation.md)。

## 功能与验证边界

| 范围 | Windows 实现 | 自动化覆盖 |
| --- | --- | --- |
| 登录与设备 | 浏览器设备授权、取消、改名、退出、凭据撤销错误；模型账号仍使用 Agent 本机配置 | OAuth 合约、取消信号、秘密不进入快照；Windows 凭据由原生 CI 测试 |
| 执行环境 | 原生默认，明确切换 WSL 发行版；登录、映射和 Agent 配置隔离 | UI 显式保存、WSL 无效时可重新选择，真实 WSL 联调待测 |
| Agent 识别 | 显式启用；PATH、常见用户安装目录、npm shims、绝对启动器；可选 `.ps1` 或明确的 Bash 环境脚本 | 启动环境一致、超时、参数原样传递、不读取 profile、失败不输出脚本秘密 |
| 三种 Agent | Claude stream-json、Codex app-server、OpenCode 2 已登记共享服务；动态模型目录、模式/模型设置 | 原生协议夹具、模型目录与权限拒绝；真实 Windows Agent 联调待测 |
| 派单与项目会话 | 原有领取/启动许可和项目会话语义、Git 仓库映射；识别盘符、空格、中文和 UNC 绝对路径 | 实际服务端 API、作用域校验、原项目会话不额外领取 |
| 回复与审批 | 原会话回复、停止回合、原生请求审批；Codex 自动审查拒绝后显式人工重试 | 失效标识拒绝、重启不重放、明确停止原回合、问答保留 |
| 外部会话 | 桥接创建的 Claude/Codex 原生会话；OpenCode 精确原生 ID 接入 | 不扫描历史、不重建无桥接会话、不把 Web 文字转为来源终端工具授权 |
| 附件与产物 | 原文件下载/大小/摘要校验；图片输入与本地路径；图片、文档、HTML/CSS/JS 相对资源预览 | 缓存篡改、越界、符号链接、错误来源、资源和体积上限 |
| 恢复与归档 | 脱离 UI 的原宿主保持存活；Claude 显式归档后 `--resume` 原 ID，Codex 原生归档/恢复 | 重启宿主不重建、回复只送一次、归档不重放首轮；系统重启后的真实 CLI 恢复待联调 |
| 受控执行 | 用户明确启用、独立 worktree、两阶段许可、冻结模型、角色沙箱/MCP 校验、停止与绑定回执 | 许可丢失、崩溃不重启、模型/目录/协议不符拒绝；需要匹配的 Codex 原生协议 |
| 发布事实 | 上传所映射仓库的发布观察，仅保存事实；交接由发布会话显式核实 | 同仓库匹配、失败退避、幂等回执；不领取核对任务或改变条目状态 |
| 桌面与更新 | 托盘、登录启动、通知、浅深色、原生文件选择；更新说明、下载进度、取消/重试、显式安装和签名发布者校验 | UI 浅深色/窄屏/草稿保护、真实 Electron IPC 由 Windows CI 执行；安装升级实机待测 |

本地自动化通过不等于 Windows 安装验收，也不证明所有网关/Agent 版本可用。正式分发前需要 Windows 11 原生与所选 WSL 发行版分别完成三 Agent 登录、审批、附件、断网/睡眠恢复和安装升级验证。

OpenCode 必须使用 2.x 登记的共享服务；可显式选择服务登记文件。未接入桥接的普通 Claude/Codex CLI 会话不会被擅自恢复。来源不提供的归档操作会明确返回未完成，不伪造成功。受控 Codex 当前严格匹配 macOS 端的 `0.155.0-alpha.16.3` 协议，未通过原生范围和 MCP 隔离校验前不发送任务。

## 配置和运行时

Windows 用户配置置于 Electron 用户数据目录的 `local` 下；原生节点使用 `native` 子目录，凭据用当前用户 DPAPI 加密，状态和宿主日志只允许该用户及系统管理员访问。内部请求使用命名管道和私有随机令牌。WSL 在发行版内使用独立的 `windows-desktop` 节点目录和 Linux 私有文件权限；需要 Node.js 22.13+、Git、util-linux `flock` 和所需 Agent。在本机设置填写 Linux Node.js 绝对路径（默认 `/usr/bin/node`）；nvm 用户填写对应版本的完整可执行路径。Worker、桥接和脱离 UI 的宿主使用同一 Node，不依赖隐式 profile。

运行中的 Agent 使用用户数据目录中按摘要保存的独立 Node/worker 副本。更新客户端不会覆盖这些文件或结束原会话；缓存变化时拒绝覆盖。界面只加载本地代码，禁用 Node 集成，限制 IPC 为设备、仓库和 Agent 设置等明确操作；远程控制台在系统浏览器打开。

Windows PATH 只接受绝对目录，相对项会被忽略；npm shim 和 shebang 解释器也不能从当前仓库目录隐式加载。Git Bash 环境通过本机 Node 导出，以保留原生 Windows 路径格式和模型配置。

环境脚本仅在用户明确选择后执行。不会自动读取 profile、alias 或把解析后的环境变量写入配置。更改凭据后可重新检查 Agent；新的宿主重新解析环境。UNC 仓库需要支持该目录的原生可执行启动器；`.cmd`/`.bat` 无法保持 UNC 工作目录时明确拒绝。优先使用本地 NTFS 仓库或所选 WSL 的 Linux 路径，不自动映射驱动器或改变仓库位置。

## 签名与正式分发

参见 [Windows 发布说明](../../docs/windows-release.md)。身份、版本和安装包文件名来自 `product.json`，图标来自产品统一源。开发构建、签名包生成、正式暂存和生产部署是分别核验的步骤；未发布时下载页不显示失效的安装链接。
