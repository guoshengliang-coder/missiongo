# 当前能力与后续里程碑

## 已完成：核心提交链路

- SDK Token 创建、摘要存储、列表和撤销；
- 未初始化时不会让宿主崩溃的公开 API 契约；
- 失败结果公开 `retryable`，宿主不必自建 code 白名单；
- 编辑器 Activity 与 H5 的浅色/深色主题，宿主可用 `editorAppearance` 覆盖系统偏好；
- Token 产品/Android 模块范围；
- 24 小时反馈草稿；
- 客户端草稿 ID 幂等更新；
- 重复安全的正式提交；
- Android 环境采集；
- 页面、上下文、日志、breadcrumb 和异常 API；
- 保留原文的有限内存环形缓冲；
- 15 分钟、单草稿范围的 Web 编辑会话；
- Android `openFeedback(Activity, FeedbackOptions)`；
- 专用 H5 草稿编辑和正式提交页；
- H5 图片、视频和日志附件选择、上传及失败重试；
- 按 SDK Token 和操作类型持久化限流；
- 网络错误、HTTP 408、429 和 5xx 指数退避重试；
- 24 小时、禁止备份的 App 私有本地反馈快照；
- 进程回收后的同一服务端草稿恢复和错误页手动重试；
- 提交成功、取消和最终失败结果回调；
- WorkManager 网络约束下的无界面程序化提交队列；
- 后台队列草稿 ID 持久化、系统退避、重启恢复与主动取消；
- H5 所选附件的草稿级 IndexedDB 恢复与 24 小时清理；
- Maven Local、网站静态 Maven 仓库，以及凭据外置的私有 Maven 发布配置；
- Release AAR、示例 APK和单元测试；
- 独立 SDK 示例工具，以及源码直连 SDK 的 MissionGo Android 管理 App；两类 APK 的构建与发布路径保持隔离。

## 下一里程碑

完整方案见 [v0.2 方案](v0-2-plan.md)。v0.2 的主题是让 SDK 第一次离开自己的仓库，第一个外部
宿主是 Hermes GO。

1. 私有 Maven 分发（P0，已完成）；
2. 宿主接入契约收敛：未初始化时记录类调用静默丢弃、`openFeedback` 回报 `not_initialized`
   而不抛、`enqueueFeedback` 返回 null，并公开 `isInitialized`（P0，已完成）；
3. 打开反馈时可选截图（P1）；
4. 后台队列状态查询与宿主通知（P1）；
5. 附件上传进度与提交前删除（P1）；
6. IP/字节配额、审计（P2）；
7. 录屏与公共 Maven Central 签名发布（暂不排期）。

自动崩溃/ANR 上报、完整 Logcat、网络全量拦截和后台屏幕采集不属于首版范围。
