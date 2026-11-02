# AND-359 验证记录

首版：Ubuntu 22.04/24.04 x86_64，Node.js 22.13+，npm 安装、前台节点、可选 systemd 用户服务。
使用现有节点 API，接入 Claude Code、Codex 和 OpenCode 2。Linux 版本声明来自 product.json。

本地验证：

- `npm run check`：通过。76 项脚本测试、15 项节点测试、524 项 Web 测试、9 项契约测试、43 项领域测试、849 项服务端测试通过（另 2 项既有跳过），类型与构建通过。
- `swift test --package-path apps/macos`：644 项，7 项既有跳过，0 失败。
- Playwright：5 项 Linux 下载测试与 25 项共享浮层回归通过。375×812、1440×900，明暗主题，下载入口、安装指引、完整性清单、窄屏溢出、返回关闭和抽屉切换均验证。
- npm 包清单检查：仅包含编译后的 CLI、package.json、README 和 LICENSE，无运行时 npm 依赖，不携带测试夹具或本机配置。
- 本机统一发布工具兼容检查：对实际安装版本只读生成临时升级副本，Python/Node/shell 语法通过；升级幂等，保留原互斥、CI、干净工作区与产物核验门禁。本机工具未修改、未发布。

截图：`download-375-light.png`、`download-375-dark.png`、`download-1440-light.png`、`download-1440-dark.png`。
共用组件为 DownloadCard、Modal、主题令牌和共享浮层历史协调器；没有新增 CSS 或扩大样式例外。

为使手机能够进入新增下载入口，同轮修复已有抽屉关闭与下载弹窗打开的 history 竞态。审批协议另外修复了服务端丢弃原生选项的问题；回归验证仅接受来源实际提供的选择，不能凭空扩展为会话授权。

节点协议测试使用隔离的 CLI 和共享服务夹具，无模型请求。跨进程测试验证主循环重启后复用原宿主、重复回复仅输入一次；Codex 验证缺少 MCP 写权限、Skill 不一致、沙箱或 reviewer 不符均不启动首轮；工具审批拒绝、陈旧请求和自动审查转人工重试均有覆盖。

发布安装流程复核补充：发现仓库映射曾使用 `path`，实际服务端要求 `repoPath`，原模拟夹具也沿用了错误字段。现已统一 CLI 写入、既有映射保留和心跳派单检查的字段；新增真实 Fastify 服务端契约测试，覆盖新增、保留旧映射和删除，修正前可复现 HTTP 400。修正后 16 项节点测试、lint、类型与 CLI 构建通过。

Ubuntu 两个版本的 npm 实际安装、可执行入口和 systemd unit 语法由 PR 中的 `linux-node` CI 矩阵执行。该检查不会在开发机启用服务；完整 systemd 登录/注销会话生命周期及三个真实 Agent/网关的模型调用仍需目标主机人工验收。安装与操作步骤见 `apps/node/README.md`。

交付产物范围为 `web` 与 `linuxCli`。Linux 账本初值明确为未发布，构建包与创建 PR不代表正式上线；待 PR 合并并核实公开产物后才可推进条目状态。
