# AND-331：会话底部紧凑设置

用户在本次派单会话中选择并批准：手机显示模型，模式与推理强度通过“更多”修改。长模型名可以在展开的选项中完整查看，附件与发送按钮保持可用。

统一 Select 的 `display: inline-flex` 优先级高于已有窄屏隐藏规则，使模式与强度重新出现在工具栏。本次只提高这条局部隐藏规则的优先级，沿用 640px 会话容器断点、现有面板和设置请求。桌面宽面板仍直接显示三个设置。

## 浏览器证据

以下截图来自临时测试实例和合成会话，不包含真实用户数据。手机为 353×757 触屏视口，应用字号设为“大”。

- [深色手机紧凑布局](phone-dark.png)
- [浅色手机展开完整模型名称](model-menu-light.png)
- [深色手机“更多”设置面板](more-panel-dark.png)
- [1920×1080 桌面直接显示全部设置](desktop.png)

## 自动化验证

- 修复前，新增浏览器回归在 353px 下因模式按钮意外可见而失败。
- `npm run check`：通过。
- `npm run test:ui -- tests/ui/agent-settings-compact.audit.spec.ts tests/ui/select-integration.audit.spec.ts tests/ui/agent-console-enter.audit.spec.ts`：19 项通过。
- 最终补充附件文件选择入口和审阅截图后，单独重跑 `agent-settings-compact.audit.spec.ts`：7 项通过；`npm run lint` 与 `git diff --check` 通过。
- 新增回归覆盖 320/353/390px、深浅主题、默认与大字号、可用文字宽度、完整模型名、44px 触屏目标、更多面板的返回与 Escape 关闭、模式与强度修改请求、附件选择入口、发送请求，以及桌面宽面板与窄面板切换。

## 人工验证

发布包含修复的 Web 版本后，在 Android App 中打开一个可回复、可调整设置的 Codex 会话：确认底部只有模型与“更多”，展开模型查看完整名称；通过“更多”修改模式和强度，用系统返回关闭面板；打开附件选择并发送消息。实际 Android WebView、系统字体放大与软键盘交互需要真机验证；浏览器测试不证明 Mac 已应用设置或真实会话已收到消息。

本次发布范围为 Web；无需重发 Android App、Android SDK 或 macOS App。该判断基于仅修改 Web CSS 及测试、审阅证据，且 Android App 使用服务端 Web 页面。
