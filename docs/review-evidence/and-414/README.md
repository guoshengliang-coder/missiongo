# AND-414 页面验证

来源：`tests/ui/agent-handoff.audit.spec.ts`，2026-11-06 本地隔离浏览器回归。

| 视口 | 浅色 | 深色 |
| --- | --- | --- |
| 375×812 | [phone-light](phone-light.png) | [phone-dark](phone-dark.png) |
| 1440×900 | [desktop-light](desktop-light.png) | [desktop-dark](desktop-dark.png) |

预期变化：旧记录状态未知时允许选择接手会话，不再显示逐条停止核实表单。截图中的范围与原因属于接手授权，不是停止证明。已验证草稿、失败重试、提交禁用、焦点及三档字号；不代表 Android/macOS 真机或生产已验证。
