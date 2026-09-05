# Android 反馈 SDK 文档

Android 反馈 SDK 面向接入 MissionGo 的宿主 App。它不是 Android 管理 App，也不提供任务查询、修改状态或管理员能力。

## 文档导航

- [宿主 App 接入](getting-started.md)
- [SDK 独立验证工具与第一阶段验收](validation-app.md)
- [数据采集与业务上下文](data-collection.md)
- [安全边界](security.md)
- [当前能力与后续里程碑](status-and-roadmap.md)

## 接入层次

最小接入只需要初始化 SDK 并调用程序化提交接口，SDK 会自动采集基础运行环境。

增强接入由宿主主动提供：

- 当前业务页面；
- 业务状态摘要；
- 日志和异常；
- 用户操作 breadcrumb；
- 本次反馈的一次性上下文。

宿主不得把数据库、SharedPreferences、Logcat、请求头或用户输入整体倾倒给 SDK。
