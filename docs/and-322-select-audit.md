# AND-322 单选控件覆盖与验证

## 覆盖范围

统一全部 Web 页面及 App/SDK 内共用 Web 页面。原生独立控件保留系统行为并记录例外。桌面与移动端使用相同的自定义菜单；不改筛选、自动保存或显式提交的生效规则。

| 入口 | 实现文件（apps/web/src） | 覆盖内容 |
|---|---|---|
| 工作区 | list-filters.tsx | Builder、类型、更多筛选中的 Builder |
| 产品及条目 | App.tsx | 产品切换器、转移目标、创建/编辑的类型、来源组件、优先级、发生频率、组件管理 |
| 统计 | statistics-center.tsx | 产品、时间、条目类型 |
| 账号与授权 | account-settings.tsx | Token 权限及有效期、账号角色、产品筛选 |
| 产品列表 | product-settings-list.tsx | 产品状态筛选 |
| Agent 控制台 | agent-session-console.tsx | Agent 筛选、派发健康筛选 |
| 会话设置 | agent-session-settings.tsx | 模式、模型、推理强度和更多设置 |
| 派发 | dispatch-dialog.tsx | 节点、Agent、模式、模型分组、推理强度 |
| 默认派发配置 | dispatch-defaults-settings.tsx | 节点、Agent、模式、模型分组、推理强度 |
| 设备设置 | node-settings.tsx | 仓库产品映射 |
| 原生会话接入 | external-native-connection.tsx | 接入节点 |
| 状态检查 | status-check-panel.tsx | 完成依据类型 |
| 交付与执行 | item-delivery.tsx | 默认 Builder、转交 Builder、执行状态、执行人分组、执行安排 |
| SDK 反馈 | SdkFeedback.tsx | 优先级 |

审计时文本搜索得到的 46 处 `<select` 包含一处产品切换器注释；实际迁移 45 个原生单选声明，另将已有产品切换器接入共享组件。隐藏原生表单 select 只存在于共享组件内。

## 平台例外与发布范围

- macOS `ServerConnectionSection.swift` 的“连接方式”是独立 SwiftUI Picker，保留原生行为；不改其业务逻辑或视觉样式。
- Android 主界面和反馈 SDK 的优先级控件由服务器 Web 页面提供，使用本次共享组件；文件/媒体选择器属于系统文件选择操作，不属于单选下拉控件。
- 本次只修改 Web 代码、Web 测试和文档，所需发布产物为 `web`。Android App、Android SDK 和 macOS App 二进制未改动，无需为共用页面重新打包。

## 验证方式

- `npm run check`：仓库 lint、身份/平台契约、迁移、样式、单测、类型检查及构建。
- `tests/ui/select.audit.spec.ts`：375/768/1440px，明暗主题；可见控件的键盘、指针/触控、分组禁用、校验、表单数据、外部更新、reset、弹窗裁切、向上避让、短视口、字体放大。
- 受影响业务 UI 测试通过可见菜单选择，不直接写隐藏 select；覆盖 Builder、产品切换、统计、设置、Token、节点接入、转移及交付。
- Playwright 触控模拟不能代替实际 Android/iOS WebView、系统读屏或完整旧浏览器兼容验收。真机、VoiceOver/TalkBack 和浏览器基线版本需人工复核。
