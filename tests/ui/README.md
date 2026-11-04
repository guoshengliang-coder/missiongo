# 界面检查（D1-1、D1-3）

这里的通用测试用 Chromium 打开控制台，在 5 种视口 × 2 种主题下检查界面；其他页面和交互另有专项测试。对应
[UI/UE 复盘与改进方案](../../docs/ui-ue-review-2026-09.md) 的 D1-1 与 D1-3，规范见
[设计规范](../../docs/design-system.md)。

## 两个项目

| 项目 | 命令 | 查什么 | 在 CI 跑吗 |
|---|---|---|---|
| `audit` | `npm run test:ui` | 量出来的数：字号下限 11px、文字对比度 4.5:1（大字 3:1）、触屏下点击区域 44×44、横向溢出、深色下写死的浅色块 | 是 |
| `visual` | `npm run test:ui:visual` | 截图和基线逐像素比对 | 是（用 Linux 基线） |

`audit` 的结论是数字，在哪台机器上都一样；`visual` 的基线和渲染平台绑定，Linux 和 macOS
的字体不同，排版就不同。

## CI 并行与耗时

PR、main push 和普通手动运行仍执行全量 UI 测试，不按改动文件筛选：

- `ui-audit (1)` 到 `ui-audit (4)` 使用 `--shard=1/4` 到 `--shard=4/4`，按文件分片，各自启动独立的服务、数据库和账号。
- 每个分片仍只有一个 worker，文件内按原顺序执行；不要直接开启 `fullyParallel` 或增加 worker，共用账号的通知计数、派单默认值等会互相影响。
- `ui-visual` 独立执行全部截图比对，不等行为测试结束。手动勾选更新基线时，只运行截图生成。
- `ui` 汇总前两类任务，保留发布门禁检查名；行为测试失败、取消或意外跳过，均不能通过汇总检查。

行为报告与附件分别在 `ui-audit-1` 到 `ui-audit-4`；截图基线与报告仍在 `ui-snapshots`，互不覆盖。
完整报告包含每条测试耗时，可用于后续对比分片耗时和调整测试组织。

本机只运行一个分片可用 `npm run test:ui -- --shard=1/4`。不要在同一 checkout 同时启动多个
Playwright 命令：它们会覆盖 `.auth` 和报告；并行验证须使用独立 checkout 和不同测试端口。

验证状态随轮询刷新的测试，在导航前 `page.clock.install()`，修改 mock 或通过 API 更新夹具后，
按实际轮询间隔推进浏览器时钟，再断言实际读取后的界面；会话轮询复用 `polling.ts`。详情、列表仍走真实轮询回调和 HTTP 请求，
不修改产品轮询间隔，也不以刷新页面代替自动更新。验证平滑滚动、动画或真实时间间隔的测试继续使用真实时间。

## 基线归 CI 所有

版本库里只放 CI 用的 Linux 基线（`*-linux.png`）。本机跑 `visual` 会生成 `*-darwin.png`，
这些文件不进版本库（见 `.gitignore`），只用于你在本机比较改动前后。

界面确实要改、需要更新基线时：

1. 在 GitHub Actions 里手动运行 CI 工作流，勾选 `update_ui_snapshots`；
2. 下载 `ui-snapshots` 产物；
3. 把里面的 `*-linux.png` 覆盖到 `tests/ui/visual.spec.ts-snapshots/`，作为改动的一部分提交。

比对失败时，同一个产物里有差异图和 Playwright 报告。

## 测试环境从哪来

`tests/ui/fixture.mjs` 会另起一个 MissionGo：临时目录当数据库、临时生成的测试账号、
独立端口（服务端 8799，前端 5199）。它不读仓库里的 `.env`，也不碰你本机的数据。
种子数据由 `scripts/seed-ui-fixture.mjs` 写入，每次内容相同：五种类型、七种状态、两张截图、
一个日志附件、一条评论和一个长链接。

这个种子脚本也可以单独用在本地的临时实例上：

```bash
node scripts/seed-ui-fixture.mjs --base http://127.0.0.1:8799 --cookie "<会话 cookie>"
```

## 已知的豁免

- `audit.spec.ts` 里的 `SMALL_TARGET_ALLOWANCE` 已为 **0**，触控目标不允许小于 44×44；原先的 8 个豁免已清理。
- `font-size: 0` 不算违规：图标按钮用它隐藏文字标签，同时保留无障碍名称。

## 覆盖边界

通用矩阵见 `fixture.mjs`：375×812、812×375、768×1024、1180×820、1440×900，覆盖列表、详情与 Agent 控制台。设置、筛选、审批等另有专项，但不是所有状态都进入通用截图矩阵。

UI 测试通过不代表 Safari、Android WebView 或 macOS 原生界面已验收。本轮新增的 `overlay-contract.audit.spec.ts` 覆盖分层返回、草稿、焦点恢复、iframe 和 SDK 桥接；`toolbar-font-contract.audit.spec.ts` 与 `visible-control.ts` 检查控件及裁切祖先、三档字号、320px 和断点两侧。这些专项不能证明所有入口或平台都没有缺陷；原始案例见 [2026-10 审计](../../docs/ui-ue-audit-2026-10.md)。新增入口需按[设计规范 §8–§9](../../docs/design-system.md)补同类交互验证。
