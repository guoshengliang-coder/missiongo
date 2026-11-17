# Windows 包与发布门禁

## 当前临时策略：未签名正式分发

用户已明确决定 Windows 暂时无需签名发布。唯一策略声明为 `product.json.windows.app.releaseSigning = "temporary-unsigned"`；这不是已取得可信证书，也不声称 Authenticode 签名通过。恢复签名时需改回策略、配置真实证书并核实更新兼容性。

- Windows 主线手动工作流依据该声明使用 `--package --unsigned-release`。原生测试和安装包、清单两份 GitHub provenance attestation 继续执行，产物名为 `windows-release-package`。普通 `--unsigned` 仍仅生成开发包，不产生正式清单。
- 正式清单必须明确 `signed: false`、`releaseSigning: "temporary-unsigned"`、`certificateSha256: null`，继续记录精确源提交、版本、文件名、大小、SHA-256、发布说明。不能把开发包伪装成正式包。
- 统一 `missiongo-release publish:windows` 仍校验 GitHub 仓库、主线 ref、工作流和源提交对应的两份 attestation，当前代码包含关系、包字节摘要、大小与版本。仅明确未签名策略时免除证书要求；已签名包仍要求可信链和固定证书摘要。
- 下载卡片及 Windows 客户端明确提示未签名、未知发布者或系统阻止安装。未签名阶段通过控制台的客户端下载页手动安装更新，应用内安装禁用；不静默取消既有更新验签。无需关闭系统安全功能，不保证所有 Windows 策略允许运行。
- 本机仍用锁、干净 worktree、最新主线、实时 CI、全量候选及范围门禁；构建成功不等于正式上线，必须部署后公开下载并核对实际 SHA-256 和来源。
- 来源 attestation 和摘要不是系统认可的发布者身份。Windows/WSL 实机安装、卸载、升级、Agent 接入与权限效果仍须实际验证，不从 CI 推断通过。

## 恢复签名后的流程参考

以下签名流程仅在恢复签名策略后适用。Windows 功能的代码入口在 `apps/windows`，首版目标 Windows 11 x64；应用身份及版本唯一声明位于 `product.json.windows.app`。`released.json.windowsApp` 初始为空，不代表已发布。不要用未签名开发包、构建成功或账本记录代替正式分发验收。

## 代码与包检查

`npm run check` 覆盖代码、类型、共享协议、样式和构建；`npx playwright test --config playwright.windows.config.ts` 覆盖 Windows 本地界面。Windows CI 额外执行 DPAPI/ACL/PowerShell/npm shim/命名管道测试、真实 Electron 的本地 IPC 冒烟和 NSIS 开发包构建。macOS 本机会跳过这些原生用例。

开发安装包只在 Windows x64 执行 `npm run build:windows -- --package --unsigned`。它保留用户数据、按用户安装，不能进入正式发布路径。真实安装、卸载、升级、WSL 和三种 Agent/网关仍须在 Windows 上验证。

## 正式包生成

`.github/workflows/windows-package.yml` 只允许从 `main` 人工触发，使用 `windows-signing` 环境。管理员需事先在该环境设置批准策略、`WINDOWS_CSC_LINK` / `WINDOWS_CSC_KEY_PASSWORD` secrets 和 `WINDOWS_PUBLISHER` variable；证书、密码和本机路径不得加入 Git。工作流不会部署生产。

流程先执行原生测试，再以 `npm run build:windows -- --package` 生成带 Authenticode 签名的 NSIS 包，核对有效签名和发布者，生成带版本、源提交、大小、摘要、证书摘要和更新说明的 `latest.json`。安装包和清单分别生成 GitHub provenance attestations，上传 `windows-release-package` 构建产物。`latest.yml` 在正式暂存时从已核验安装包及说明重新生成，不接受外部地址。Windows 首次说明范围从该客户端进入主线的父提交开始，后续从已发布账本提交开始；客户端改动需提供 `release-notes/windows/*.json` 声明。

## 统一暂存和部署

生产暂存和部署仍必须通过本机共享 `missiongo-release`，不绕过现有互斥、干净 worktree、最新主线、CI、来源和候选覆盖率门禁。新增支持不会自动修改已安装的本机工具：

1. 从已合并代码、干净的独立 worktree 按 [发布覆盖门禁](release-coverage.md) 的原流程刷新全量候选，并重新安装当前覆盖工具，使其认识 `windowsApp`。
2. 使用当前主线的 `node scripts/install-release-tools.mjs --dry-run` 对照共享安装清单；按原发布授权安装审核后的工具。兼容入口 `enable-windows-release.mjs` 只转交该安装器，不再对已安装入口做字符串补丁。安装清单包含 Windows 验证器，现有锁、CI 和覆盖检查继续生效；它不构建、不部署。
3. 在仓库外下载已签名工作流产物。用本机环境变量 `MISSIONGO_WINDOWS_BUILD_DIRECTORY` 选择该目录，`MISSIONGO_WINDOWS_CERT_SHA256` 指定人工核实的可信签名证书 DER SHA-256。本机需有支持 source/workflow 约束的 GitHub CLI 和支持 `-require-leaf-hash` 的 osslsigncode；证书信任链需由本机可信 CA 配置验证。
4. 经发布授权后运行 `missiongo-release publish:windows`。它核验两个文件的 GitHub attestation 与仓库、工作流、主线 ref、源提交绑定；以 osslsigncode 校验证书链和固定证书摘要；核对当前客户端源码包含关系、版本、实际包摘要及大小后才更新暂存目录和账本。
5. 提交账本、按用户授权集成，再运行 `missiongo-release plan/check/deploy --candidates <完整候选文件>` 原流程。Windows 包必须包含条目的集成提交；缺包、来源过旧、任一必需产物未覆盖都阻断。明确部分发布仍需用户原有产物范围授权。

部署会保留已核验的线上 Windows 包，避免另一个 worktree 清空下载；当前工作区暂存了新包时才使用新包。公开 `/downloads/windows/latest.json` 和 `latest.yml` 不缓存且缺文件返回 404，安装包使用带版本的文件名。公开发布凭据和节点交付检查以实际下载 SHA-256、版本、源提交核实 `windowsApp`，全部必需产物都具备证据后才参与待验证交接。

客户端从当前已登录服务器的 `/downloads/windows/` 检查更新，需用户明确下载和安装；不在普通退出时自动安装。下载后仍核对有效 Authenticode 签名与构建时固定的发布者，未配置正式发布者的开发构建不能安装更新。签名身份变更和证书轮换须单独核实，不能为使流程通过而使用未知证书。

验签和 attestation 参数依据：[osslsigncode 文档](https://github.com/mtrojnar/osslsigncode/blob/master/osslsigncode.md)、[GitHub CLI attestation verify](https://cli.github.com/manual/gh_attestation_verify)。这些工具验证的只是对应签名和来源约束，真实 Windows 功能、安装和升级验收另行记录。
