# MissionGo Android 反馈 SDK · 宿主接入说明

> 这份文档是自包含的接入契约，写给第一次接触 MissionGo 的宿主开发者或编码 Agent。
> 读完它就足以完成接入，不需要 MissionGo 的源码，也不需要读 MissionGo 的其他文档。
>
> 固定地址：`__MISSIONGO_PUBLIC_ORIGIN__/downloads/missiongo-android-sdk/INTEGRATION.md`
> 对应 SDK 版本：**0.2.0**

## 0. 这是什么

一个 Android 库，让宿主 App 的用户在应用内提交 Bug / 需求 / 想法，直接落成 MissionGo 里的
工作条目。SDK 负责采集运行环境、承载宿主给的业务现场、打开一个 H5 编辑器让用户补充文字和
附件，然后幂等地提交。

**它不是什么**：不是任务管理客户端。SDK Token 只能写入反馈，不能读取任何已有条目、列表、
附件或配置。SDK 不做自动崩溃上报、不抓 Logcat、不拦截网络、不采集后台屏幕。

## 1. 接入前你需要拿到的四样东西

| | 内容 | 从哪来 |
|---|---|---|
| 1 | Maven 仓库地址 `__MISSIONGO_PUBLIC_ORIGIN__/maven` | 本文档 |
| 2 | 坐标 `io.missiongo:missiongo-feedback:0.2.0` | 本文档 |
| 3 | 服务地址（endpoint）`__MISSIONGO_PUBLIC_ORIGIN__` | 本文档 |
| 4 | SDK Token | **由人在 MissionGo 管理端创建后，直接写入本机私密文件** |

关于第 4 项：Token 不通过对话、提交信息或任何被 Git 跟踪的文件传递。负责接入的人会把它写进
宿主仓库里一个 gitignore 的属性文件；接入者只需要知道**从哪个文件读**，不需要知道它的值。

Token 最终会进入 APK，可以被反编译提取，所以它不是密码学意义上的秘密。真正的安全边界在
服务端：它被限定为「只能为某一个产品写反馈」，有频率限制，并且可以随时吊销。

## 2. 兼容基线

| 项 | 值 |
|---|---|
| `minSdk` | 23 |
| 编译/字节码 | Java 17 |
| 库的 `compileSdk` | 36（宿主用更高的 compileSdk 没有问题） |
| Compose | 不需要。SDK 不含任何 Compose 依赖 |

**会进入宿主的传递依赖**（宿主不需要重复声明，但需要知道它们存在）：

- `androidx.activity:activity-ktx`
- `androidx.work:work-runtime` ← 注意
- `org.jetbrains.kotlinx:kotlinx-coroutines-android`

WorkManager 这一条值得单独确认：如果宿主已经使用了自定义 `WorkerFactory`（例如 Hilt 的
`@HiltWorker` 配合 `Configuration.Provider`），必须保证默认 WorkerFactory 仍能实例化 SDK 自己的
Worker，否则后台队列投递会失败。宿主此前没有 WorkManager 的话则无需任何处理。

## 3. 声明仓库

制品由 MissionGo 网站以静态文件分发，**读取匿名，不需要任何凭据**——AAR 里不含密钥。

Gradle 版本目录风格的宿主，在 `settings.gradle.kts`：

```kotlin
dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
        maven {
            name = "missiongo"
            url = uri("__MISSIONGO_PUBLIC_ORIGIN__/maven")
            // 限定作用域：其他依赖不会因为这个仓库多一次网络往返。
            content { includeGroup("io.missiongo") }
        }
    }
}
```

> ⚠️ 使用 `RepositoriesMode.FAIL_ON_PROJECT_REPOS` 的项目（多数现代 Android 项目）**必须**
> 把仓库加在这里，加进模块的 `build.gradle.kts` 会直接构建失败。

## 4. 加依赖

钉死一个具体版本。**不要使用 SNAPSHOT**——外部宿主不应跟随一个会漂的版本。

```kotlin
// gradle/libs.versions.toml
[versions]
missiongoFeedback = "0.2.0"

[libraries]
missiongo-feedback = { module = "io.missiongo:missiongo-feedback", version.ref = "missiongoFeedback" }
```

```kotlin
// app/build.gradle.kts
dependencies {
    implementation(libs.missiongo.feedback)
}
```

## 5. 注入 endpoint 和 Token

两个值都必须来自**不被 Git 跟踪**的来源。推荐做法是一个 gitignore 的属性文件，外加 CI 环境
变量兜底：

```kotlin
// app/build.gradle.kts
import java.util.Properties

val missionGoPropsFile = rootProject.file("missiongo.properties")
val missionGoProps = Properties().apply {
    if (missionGoPropsFile.exists()) missionGoPropsFile.inputStream().use { load(it) }
}
fun missionGoSetting(propertyName: String, environmentName: String): String =
    (missionGoProps.getProperty(propertyName) ?: System.getenv(environmentName) ?: "").trim()

fun javaStringLiteral(value: String): String =
    "\"${value.replace("\\", "\\\\").replace("\"", "\\\"")}\""

android {
    defaultConfig {
        buildConfigField("String", "MISSIONGO_ENDPOINT",
            javaStringLiteral(missionGoSetting("missiongoEndpoint", "MISSIONGO_ENDPOINT")))
        buildConfigField("String", "MISSIONGO_SDK_TOKEN",
            javaStringLiteral(missionGoSetting("missiongoSdkToken", "MISSIONGO_SDK_TOKEN")))
    }
    buildFeatures { buildConfig = true }
}
```

对应的属性文件（**必须加进 `.gitignore`**）：

```properties
# missiongo.properties
missiongoEndpoint=__MISSIONGO_PUBLIC_ORIGIN__
missiongoSdkToken=mg_sdk_...
```

### ⚠️ 配置缺失是受支持的状态，不是错误

新克隆的仓库、别人的机器、没有 Secret 的 CI 都拿不到这两个值。此时**正确的行为是「这个功能
不存在」**：不初始化 SDK，不显示反馈入口，构建和测试照常通过。

**绝对不要用占位 Token 兜底。** 那会产出一个每次提交都必然 401 的 App，而且失败只在用户手里
才暴露。

## 6. 初始化

必须在 `Application.onCreate()` 里**同步**完成——后台队列的 Worker 可能在用户从未打开过界面的
进程里被唤醒，它靠这次初始化拿到服务地址和 Token。

```kotlin
class HostApplication : Application() {
    override fun onCreate() {
        super.onCreate()
        if (BuildConfig.MISSIONGO_ENDPOINT.isBlank() || BuildConfig.MISSIONGO_SDK_TOKEN.isBlank()) return
        MissionGo.initialize(
            application = this,
            options = MissionGoOptions(
                endpoint = BuildConfig.MISSIONGO_ENDPOINT,
                sdkToken = BuildConfig.MISSIONGO_SDK_TOKEN,
                sourceRevision = "${BuildConfig.VERSION_NAME} (${BuildConfig.VERSION_CODE})",
                buildFlavor = BuildConfig.BUILD_TYPE,
                distributionChannel = "internal",
            ),
        )
    }
}
```

生产构建只接受 HTTPS。本机开发若必须连 HTTP，需显式设置 `allowInsecureHttp = true`，不得在
生产构建中开启。重复用相同 options 调用 `initialize` 是安全的。

### 未初始化时的行为

**不需要包一层防御性门面。** 未初始化是受支持的状态，SDK 自己处理，宿主不必在每个调用点判断：

| 调用 | 未初始化时 |
|---|---|
| `setCurrentScreen` / `setContext` / `clearContext` / `addBreadcrumb` / `log` | 静默丢弃 |
| `openFeedback` | 不抛异常。有回调则收到 `FeedbackResult.Failed("not_initialized", ...)`，没有回调则什么都不做 |
| `enqueueFeedback` | 返回 `null` |
| `cancelQueuedFeedback` / `retryQueuedFeedback` | 什么都不做 |
| `createDraft` / `finalizeDraft` / `submitFeedback`（suspend） | 抛 `MissionGoException`，`code = "not_initialized"` |

需要决定是否展示反馈入口时读 `MissionGo.isInitialized`。

唯一仍需宿主处理的是 `initialize` 本身：它会对 endpoint 和 Token 做格式校验，值写错时抛
`IllegalArgumentException`。包一层 `runCatching` 并记一条本地诊断即可，不要上抛。

## 7. 提供业务现场

这一步决定了收到的反馈有没有用。SDK 自动采集的只有运行环境（见第 10 节），**业务信息必须由
宿主主动给**。

```kotlin
// 用户当前在哪个页面。导航目的地变化时调用。
MissionGo.setCurrentScreen("chat_session")

// 按命名空间给业务状态。传状态、枚举、计数、时间、错误码。
MissionGo.setContext(
    namespace = "gateway",
    values = mapOf(
        "state" to "reconnecting",
        "pendingCount" to "8",
        "lastErrorCode" to "TIMEOUT",
    ),
)

// 关键用户动作
MissionGo.addBreadcrumb("session_opened", mapOf("source" to "notification"))

// 日志和异常
MissionGo.log(
    level = MissionGoLogLevel.Error,
    message = "Send failed",
    throwable = error,
    attributes = mapOf("errorCode" to "TIMEOUT"),
)
```

### 宿主已经有自己的日志系统时

不要做实时桥接。宿主的诊断日志通常默认关闭，实时转发会给「什么都不用报告」的运行也多复制
一份数据。**正确做法是在打开反馈入口的那一刻，把宿主环形缓冲的快照一次性喂给
`MissionGo.log`**——用户开着诊断时，缓冲里装的正好就是刚出问题的那次运行。

### 上下文覆盖顺序

```text
SDK 自动环境 → 初始化配置 → 宿主全局命名空间上下文 → 本次 FeedbackOptions.context
```

后者覆盖前者。服务端固定的产品和来源模块不能被宿主覆盖。

### 数据上限

上下文最多 50 个字段、单值 2,000 字符；日志最多 500 条 / 256 KiB、单条 4,000 字符；
每个任务最多 10 个附件。服务端会再次校验。

## 8. 打开用户入口

```kotlin
MissionGo.openFeedback(
    activity = activity,
    options = FeedbackOptions(
        title = "",                      // 预填，用户可改
        type = FeedbackType.Bug,         // Idea / Requirement / Bug / Task / Note
        priority = FeedbackPriority.Normal,
        context = mapOf("queryLength" to query.length.toString()),  // 仅本次
    ),
) { result ->
    when (result) {
        is FeedbackResult.Submitted -> showMessage("已创建 ${result.submission.itemKey}")
        FeedbackResult.Cancelled -> Unit
        is FeedbackResult.Failed -> showMessage(result.message)
    }
}
```

**需要一个真实的 `Activity`。** 纯 Compose 宿主用 `androidx.activity.compose.LocalActivity`
取；它可能为 null（预览、非 Activity 宿主），拿不到时不要展示入口。

SDK 会先创建服务端草稿，再签发一个 15 分钟、只能访问该草稿的 Web 会话，用 HttpOnly Cookie
打开 H5 编辑器。SDK Token 和会话 Token 都不会进入页面 URL。用户在 H5 里补充文字、选择最多
10 个图片/视频/日志附件并提交。

回调是进程内对象：返回键产生 `Cancelled`，错误页关闭产生 `Failed`，重试成功只产生一次
`Submitted`。进程重建后草稿流程仍可恢复，但旧进程注册的回调不会再触发。

## 9. 程序化提交与后台队列

不需要用户参与的反馈有两条路：

```kotlin
// 协程内直接提交，等待结果
val submission = MissionGo.submitFeedback(FeedbackOptions(title = "索引同步失败"))

// 交给 WorkManager，等有网再投递。未初始化时返回 null。
val queueId = MissionGo.enqueueFeedback(FeedbackOptions(title = "索引同步失败"))
queueId?.let {
    MissionGo.cancelQueuedFeedback(it)   // 用户撤销或现场已失效
    MissionGo.retryQueuedFeedback(it)    // 修正配置后重新调度（24 小时内）
}
```

`FeedbackOptions.clientDraftId` 是幂等键：同一个 options 重试不会产生多个草稿，重复 finalize
同一草稿返回同一个任务编号。SDK 对连接失败、408、429、5xx 最多重试 2 次并指数退避；鉴权、
参数和业务冲突错误不重试。

队列快照存在 SDK 自己的禁止备份目录，24 小时过期，进程和设备重启后继续。当前版本**查询不到
队列状态**（下个版本补），宿主可以保存 queueId 用于取消。

## 10. SDK 采集什么、不采集什么

**自动采集**（全部通过 Android 公开 API）：包名、版本名、版本号、Android 版本与 API Level、
设备厂商与型号、主 CPU 架构、Locale、时区、屏幕密度，以及宿主初始化时显式传入的 revision /
flavor / 渠道。

**绝不自动采集**：Android ID、IMEI、序列号、广告 ID、定位、通讯录、短信、剪贴板、应用列表、
Logcat、宿主数据库、SharedPreferences、账号、Cookie、Token、页面输入。附件也不会自动扫描，
只有用户在 H5 里通过系统文件选择器明确选中的文件才会上传。

### ⚠️ 宿主必须自己完成脱敏

**SDK 按原文保存宿主主动提供的日志和上下文，只做条数和长度限制，不会自动遮盖 Token、Cookie
或鉴权头。** 敏感信息治理必须在数据进入 SDK **之前**完成。

不要传：完整搜索词、表单内容、请求体、响应体、数据库记录、密码、真实凭据、完整鉴权头、
个人敏感信息。

要传：状态、枚举、计数、时间、错误码。

宿主也不得把数据库、SharedPreferences、Logcat、请求头或用户输入整体倾倒给 SDK。

## 11. 接入验收清单

逐条验证，不要跳过：

- [ ] 条目落在正确的产品和 Android 来源模块下；
- [ ] App 版本、构建号、系统和设备信息正确；
- [ ] 送入的日志和业务字段里没有密码、Token、Cookie 或个人敏感信息；
- [ ] SDK Token 无法读取任务列表或详情（用它调读取接口应失败）；
- [ ] Token 撤销后所有 SDK 请求返回 401；
- [ ] 超过频率限制返回 429，且不同 Token 互不影响；
- [ ] 未配置 endpoint / Token 的构建能正常编译、测试通过，且不显示反馈入口；
- [ ] R8 / 混淆构建后初始化和提交仍然正常；
- [ ] 断网时打开入口，错误页可手动重试；杀进程后重进能恢复同一草稿；
- [ ] SDK 的任何网络错误都不会导致宿主崩溃；未配置的构建里点不到入口，且不会崩。

## 12. 常见问题

| 现象 | 原因 |
|---|---|
| Gradle 报仓库不被允许 | 用了 `FAIL_ON_PROJECT_REPOS` 却把仓库加在了模块里，应加到 `settings.gradle.kts` |
| Gradle 报制品解析/解析失败且信息难懂 | 服务端把缺失路径回落成了 HTML。仓库地址写错，或服务端未配置 `/maven` 返回真正的 404 |
| `IllegalArgumentException` 出现在 `initialize()` | endpoint 不是合法 origin，或 Token 格式不对（应形如 `mg_sdk_` + 43 位） |
| 所有提交 401 | Token 已撤销、写错，或用了占位值 |
| 提交 429 | 触发按 Token 的频率限制 |
| 后台队列不投递 | 没有在 `Application.onCreate()` 同步初始化，或自定义 `WorkerFactory` 无法实例化 SDK 的 Worker |
| 生产构建连不上 | endpoint 不是 HTTPS；生产环境不允许 HTTP |

## 13. 当前版本不支持

自动崩溃 / ANR 上报、完整 Logcat 采集、网络全量拦截、后台屏幕采集、录屏、打开反馈时自动截图、
后台队列状态查询、附件上传进度与提交前删除。

其中「打开反馈时自动截图」和「队列状态查询」是下一个版本的内容。
