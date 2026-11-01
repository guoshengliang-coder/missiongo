# UI/UE 整改后截图

对应 [整改记录](../../ui-ue-remediation-2026-11.md)，基于 `d395954` 加本轮修复。本机 Chromium、合成数据、独立测试实例；不是生产截图或 Linux 像素比较基线。截图时测试实例也包含其他回归用例创建的合成条目，列表数量不用于前后比较。

- `detail-375-{light,dark}.png`、`detail-1440-{light,dark}.png`：默认字号的详情和工具栏。
- `preview-375-{light,dark}.png`、`preview-1440-{light,dark}.png`：原生媒体浮层；背景隔离与焦点恢复由行为测试验证。
- `toolbar-320-large-{light,dark}.png`：320px 大字号时次要动作进入更多，主操作和更多按钮完整可见。

来源为 `tests/ui/overlay-history.audit.spec.ts`。返回、焦点、草稿和 SDK 提交中状态的证据来自浏览器断言与原生单元测试，不能用截图代替。
