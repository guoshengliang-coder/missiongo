# 从仓库安装本机发布工具

本机统一发布入口 `missiongo-release` 和共享锁、CI、预检、覆盖率守卫以前只在某一台机器上维护，
与仓库里的 `scripts/` 会各自演进。现在这些工具全部位于仓库 `scripts/`，由下面的命令安装到本机，
两者不再分叉。

```sh
node scripts/install-release-tools.mjs --dry-run   # 只列出会写入哪些文件
node scripts/install-release-tools.mjs             # 实际安装
```

安装位置与本机手册（`~/.config/missiongo/AGENT-RELEASE.md`）一致，不改动调用方式：

| 来源 `scripts/` | 目标 |
| --- | --- |
| `missiongo-release.py` | `~/.local/bin/missiongo-release` |
| `deploy.sh`、`release-timing.sh`、`release-coverage-guard.sh`、`release-status.sh` | `~/.config/missiongo/release-tools/` |
| `release-lock.py`、`release_coverage_options.py` | 同上 |
| `release-preflight.mjs`、`release-receipt.mjs` | 同上 |
| `release-ci.mjs`、`release-ci-wait.mjs` | 同上 |

规则：

- 只在 `HEAD` 包含 `origin/main` 且 `scripts/` 无未提交改动时运行；每个文件都必须在 `HEAD` 中存在。
- 目标位置若已有非常规文件或符号链接则拒绝，不覆盖。
- `deploy.sh` 与入口合起来必须仍引用全部共享守卫，入口必须仍经过 `release-lock.py` 加锁，否则拒绝安装。
  安装后的 `deploy.sh` 从 `$MISSIONGO_RELEASE_TOOLS` 调用收据与状态守卫，不读仓库工作区里的副本。
- 安装前检查 Python 与 bash 语法；旧版清单里的 `globalRulesIdentical` 字段会被忽略，其他未知字段仍然拒绝；写入前按 `release-tools-manifest.json` 比较磁盘上的实际内容，
  只替换内容变化的文件，每个被替换的文件首次备份为 `<文件>.before-release-tools-in-repo`。
- 私有目标参数（`release-local.json`、`release-coverage.json`、凭据与签名文件）不在仓库中，
  安装脚本不会创建或修改它们。

仓库 `scripts/deploy.sh` 直接运行会要求 `MISSIONGO_RELEASE_TOOLS`，避免绕过统一入口；
发布一律通过 `missiongo-release check|deploy --candidates ...` 执行。
