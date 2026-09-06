# 宿主 App 接入

> 当前 SDK 版本为 `0.2.2`。面向用户的入口使用短期、单草稿 Web 会话打开共用 H5 编辑器。

## 1. 创建受限 SDK Token

先在 MissionGo 中创建产品和 Android 来源模块，然后使用管理员权限创建 Token：

```bash
curl -X POST https://missiongo.example.invalid/api/v1/sdk-tokens \
  -H 'Authorization: Bearer <local-admin-token>' \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "Search App debug",
    "productId": "<product-id>",
    "sourceComponentId": "<android-component-id>"
  }'
```

明文 Token 只在创建响应中返回一次。服务端只保存 SHA-256 摘要。SDK Token 固定绑定产品和可选 Android 来源模块，不能读取已有任务。

## 2. 引入 SDK

SDK 由 MissionGo 网站以静态文件形式分发，读取匿名。AAR 里不含任何密钥——endpoint 和 Token
由宿主在自己的构建期注入——所以宿主的 CI 不需要配置 Maven 凭据。

在宿主的 `settings.gradle.kts` 中加入仓库：

```kotlin
dependencyResolutionManagement {
    repositories {
        google()
        mavenCentral()
        maven {
            name = "missiongo"
            url = uri("https://<missiongo origin>/maven")
            content { includeGroup("io.missiongo") }
        }
    }
}
```

然后钉死一个具体版本，不要使用 SNAPSHOT：

```kotlin
dependencies {
    implementation("io.missiongo:missiongo-feedback:0.2.2")
}
```

### 发布新版本

版本号在 `sdks/android-feedback/gradle.properties` 的 `missiongoVersion` 单点定义。

```bash
cd sdks/android-feedback
./gradlew :missiongo-feedback:publishReleasePublicationToWebsiteRepository
```

制品写入 `apps/web/public/maven/`，随下一次 `npm run build:web` 和网站部署上线。该目录和内部
APK 一样不进 Git。网站的 nginx 需要 `location ^~ /maven/ { try_files $uri =404; }`：Maven 客户端
必须在制品缺失时看到真正的 404，SPA 回落会给出 200 的 HTML 并让 Gradle 报出难以定位的错误。

本机联调可以先发到 Maven Local：

```bash
./gradlew :missiongo-feedback:publishToMavenLocal
```

或者让宿主直接指向本地目录构建：

```bash
./gradlew :app:assembleDebug -PmissiongoMavenUrl=file:///path/to/missiongo/apps/web/public/maven
```

私有 Maven 仓库（需要鉴权的那种）仍然可用，参数从本机 Gradle 属性或 CI Secret 提供：

```bash
./gradlew :missiongo-feedback:publish \
  -PmissiongoMavenUrl=https://packages.example.invalid/releases \
  -PmissiongoMavenUsername="$MAVEN_USERNAME" \
  -PmissiongoMavenPassword="$MAVEN_PASSWORD"
```

也可以使用 `MISSIONGO_MAVEN_URL`、`MISSIONGO_MAVEN_USERNAME` 和 `MISSIONGO_MAVEN_PASSWORD`
环境变量。仓库内不保存真实地址或凭据。

## 3. 在 Application 中初始化

```kotlin
class SearchApplication : Application() {
    override fun onCreate() {
        super.onCreate()
        // 配置缺失是受支持的状态，不是错误：跳过初始化并隐藏反馈入口。
        if (BuildConfig.MISSIONGO_ENDPOINT.isBlank() || BuildConfig.MISSIONGO_SDK_TOKEN.isBlank()) return
        MissionGo.initialize(
            application = this,
            options = MissionGoOptions(
                endpoint = BuildConfig.MISSIONGO_ENDPOINT,
                sdkToken = BuildConfig.MISSIONGO_SDK_TOKEN,
                sourceRevision = BuildConfig.GIT_REVISION,
                buildFlavor = BuildConfig.FLAVOR,
                distributionChannel = "internal"
            )
        )
    }
}
```

**不要用占位 Token 兜底。** 新克隆的仓库、别人的机器、没有 Secret 的 CI 都拿不到 endpoint 和
Token，此时正确的行为是「没有这个功能」，而不是「带着一把必然 401 的 Token 初始化」。

跳过初始化之后不需要再做防御性包装：记录类调用（`setCurrentScreen`、`setContext`、
`addBreadcrumb`、`log`）静默丢弃，`openFeedback` 通过回调报 `not_initialized` 而不抛，
`enqueueFeedback` 返回 null。宿主用 `MissionGo.isInitialized` 决定是否展示反馈入口。

生产环境默认只允许 HTTPS。本机开发若必须连接 HTTP，需要显式设置 `allowInsecureHttp = true`，不得在生产构建中开启。

真实服务地址和 SDK Token 放在宿主的本地 Gradle 配置或私有 CI Secret 中，不得写入 Git 跟踪文件。Token 最终仍会进入 APK，因此它不是不可提取的秘密，真正的安全边界是服务端的最小权限、配额、限流和撤销能力。

## 4. 添加业务现场

```kotlin
MissionGo.setCurrentScreen("search_result")
MissionGo.setContext(
    namespace = "search",
    values = mapOf(
        "resultCount" to resultCount.toString(),
        "filter" to selectedFilter.code
    )
)
MissionGo.addBreadcrumb(
    name = "search_submitted",
    attributes = mapOf("source" to "home")
)
```

## 5. 打开用户反馈入口

```kotlin
feedbackButton.setOnClickListener {
    MissionGo.openFeedback(
        activity = this,
        options = FeedbackOptions(
            title = "搜索结果加载失败",
            type = FeedbackType.Bug,
            context = mapOf("queryLength" to query.length.toString())
        )
    )
}
```

需要更新宿主界面时可接收终态回调：

```kotlin
MissionGo.openFeedback(this, FeedbackOptions(title = "搜索结果加载失败")) { result ->
    when (result) {
        is FeedbackResult.Submitted -> showMessage("已创建 ${result.submission.itemKey}")
        FeedbackResult.Cancelled -> Unit
        is FeedbackResult.Failed -> showMessage(result.message)
    }
}
```

返回键产生 `Cancelled`；错误页选择关闭产生 `Failed`；用户重试并成功后只产生一次 `Submitted`。回调属于当前进程内对象，不会跨进程恢复；进程重启后草稿流程仍可恢复，但旧进程注册的回调不会再次触发。

SDK 先创建草稿，再签发 15 分钟、只允许访问该草稿的 Web 会话，并通过 HttpOnly Cookie 打开 H5。SDK Token 和 Web 会话 Token 都不会进入页面 URL。

H5 可选择最多 10 个图片、视频或日志文件。任务先以幂等方式创建，再逐个上传附件；每个附件也有独立幂等 ID，即使响应丢失后重试也不会重复保存。部分附件失败不会重复创建任务，用户可在完成页单独重试。文件类型和大小由服务端再次校验。

打开入口时 SDK 会保存一份最大 512 KiB 的本地恢复快照，包括当时的环境、合并后上下文和有限日志。快照位于 SDK 自己管理的 `noBackupFilesDir` 子目录，24 小时过期；不会访问宿主数据库或 SharedPreferences。断网时错误页可手动重试，进程重建后也会沿用同一个客户端草稿 ID 和已记录的服务端草稿 ID。

## 6. 验证程序化链路

从协程调用：

```kotlin
val result = MissionGo.submitFeedback(
    FeedbackOptions(
        title = "搜索结果加载失败",
        description = "重试后缓存结果消失。",
        type = FeedbackType.Bug,
        priority = FeedbackPriority.High,
        context = mapOf(
            "queryLength" to query.length.toString(),
            "cachedResultCount" to cachedCount.toString()
        )
    )
)

println(result.itemKey)
```

`clientDraftId` 是幂等键。同一个 `FeedbackOptions` 重试时不会生成多个服务端草稿；对同一个草稿重复 finalize 也会返回同一个任务编号。

SDK 默认对网络连接失败、HTTP 408、429 和 5xx 最多重试 2 次，并采用指数退避。可通过 `maxNetworkRetries` 和 `initialRetryDelayMillis` 调整；鉴权、参数和业务冲突错误不会重试。`submitFeedback` 只覆盖当前协程调用，需要跨进程投递时使用下面的后台队列入口。

无需立即等待结果的程序化反馈可进入后台队列：

```kotlin
val queueId = MissionGo.enqueueFeedback(
    FeedbackOptions(
        title = "搜索索引同步失败",
        description = "等待网络恢复后自动提交。",
        context = mapOf("indexVersion" to indexVersion)
    )
)

// 用户撤销或业务现场已失效时：
MissionGo.cancelQueuedFeedback(queueId)

// 修复初始化或鉴权配置后，重新调度仍在 24 小时内的队列：
MissionGo.retryQueuedFeedback(queueId)
```

队列使用 WorkManager 的联网约束与指数退避，进程或设备重启后仍会继续。宿主必须在 `Application.onCreate()` 中同步调用 `MissionGo.initialize()`，以便后台 Worker 启动时取得服务地址和 SDK Token。队列快照位于 SDK 自己的禁止备份目录，24 小时过期；服务端草稿和正式提交均幂等。取消正在执行的工作属于尽力而为，若服务端已完成提交则不会删除已生成的任务。

当前 `enqueueFeedback` 是持久化、无界面的投递入口，不提供跨进程回调；宿主可保存返回的队列 ID 用于取消。队列状态查询与完成通知属于后续能力。

## 7. 接入验收

- 任务归属正确产品和 Android 来源模块；
- App 版本、构建号、系统和设备信息正确；
- 宿主送入的日志和业务字段没有密码、Token、Cookie 或个人敏感信息；
- SDK Token 无法读取任务列表或任务详情；
- Token 撤销后所有 SDK 请求返回 401；
- 超过相应 Token 操作频率后返回 429，且不同 Token 互不影响；
- H5 会话不能上传到其他草稿生成的任务；
- R8 构建后 SDK 初始化和提交仍然正常；
- SDK 网络错误不会导致宿主 App 崩溃。
- 进程重建后反馈页能够恢复，成功、取消或最终关闭后本地快照被删除；
