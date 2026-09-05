# 数据采集与业务上下文

## 自动采集

SDK 只通过 Android 公开 API 自动采集基础运行环境：

| 字段 | 来源 |
|---|---|
| 包名、版本名、版本号 | `PackageManager` |
| Android 版本、API Level | `Build.VERSION` |
| 设备厂商和型号 | `Build.MANUFACTURER`、`Build.MODEL` |
| 主 CPU 架构 | `Build.SUPPORTED_ABIS` |
| Locale、时区 | Java/Android 标准 API |
| 屏幕密度 | `Resources.displayMetrics` |
| Git revision、flavor、渠道 | 仅使用宿主初始化时显式传入的值 |

SDK 不自动获取 Android ID、IMEI、序列号、广告 ID、定位、通讯录、短信、剪贴板、应用列表、Logcat、宿主数据库、SharedPreferences、账号、Cookie、Token 或页面输入。

附件也不会自动扫描或采集。只有用户在反馈 H5 中通过系统文件选择器明确选中的文件，才会进入该草稿的 origin 隔离 IndexedDB 和后续上传流程。

## 宿主主动提供

业务信息必须采用白名单和摘要方式：

```kotlin
MissionGo.setContext(
    "sync",
    mapOf(
        "state" to "retrying",
        "pendingCount" to "8",
        "lastErrorCode" to "TIMEOUT"
    )
)
```

推荐传递状态、枚举、计数、时间和错误码。不要传递完整搜索词、表单内容、请求体、响应体或数据库记录。

## 日志和 breadcrumb

```kotlin
MissionGo.log(
    level = MissionGoLogLevel.Error,
    message = "Search request failed",
    throwable = error,
    attributes = mapOf("errorCode" to "TIMEOUT")
)
```

日志保存在进程内存环形缓冲区中，默认最多 500 条、合计 256 KiB。创建草稿时生成快照，之后的新日志不会进入已经创建的草稿。

调用交互式反馈或 `enqueueFeedback` 时，这份有限快照会写入 SDK 管理的应用私有禁止备份目录，以支持进程恢复或后台投递；最长保留 24 小时。SDK 不会因此读取宿主自己的存储。

SDK 按内部诊断工具策略保留宿主主动提供的日志原文，只做条数和长度限制，不改写 Token、Cookie 或其他字段。因此宿主必须在日志进入 SDK 之前完成自己的敏感信息治理，不得把密码、鉴权头或真实凭据写入诊断日志。

## 覆盖顺序

同名上下文按以下顺序覆盖：

```text
SDK 自动环境
→ 初始化配置
→ 宿主全局命名空间上下文
→ 本次 FeedbackOptions.context
```

本次反馈上下文优先级最高。服务端固定的产品和来源模块不能由宿主请求覆盖。
