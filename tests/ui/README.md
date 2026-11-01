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
