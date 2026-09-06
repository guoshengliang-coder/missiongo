# Android 反馈 SDK v0.2 方案

v0.1 把提交链路做完了，但它只被两个宿主用过，而这两个宿主都在本仓库里：`sample` 和
`apps/android`。它们通过 `implementation(project(":missiongo-feedback"))` 直接引用源码，
所以从来没有真正验证过"一个外部仓库怎么拿到这个 SDK"。

v0.2 的主题就是这一件事：**让 SDK 第一次离开自己的仓库**。第一个外部宿主是 Hermes GO
(`hermes-remote`)，它是独立仓库、独立 CI（Jenkins + GitHub Actions）、独立发版节奏。

## 一、v0.2 的范围

| 编号 | 内容 | 优先级 | 为什么现在做 |
|---|---|---|---|
| A | 私有 Maven 分发 | P0 | 不做则外部仓库无法构建，其余全部无从谈起 |
| B | 宿主接入契约收敛 | P0 | 配置缺失必须优雅降级，否则外部 CI 会红 |
| C | 打开反馈时可选截图 | P1 | 当前最大的人工成本，见下 |
| D | 后台队列状态查询与通知 | P1 | `enqueueFeedback` 目前是黑洞 |
| E | 配额与审计 | P2 | 宿主变多之后才会疼 |

不在 v0.2 范围：自动崩溃/ANR 上报、完整 Logcat、网络全量拦截、后台屏幕采集、录屏、
Maven Central 签名发布。

## 二、A：私有 Maven 分发（P0）

### 问题

Hermes GO 的 `android/settings.gradle.kts` 用 `RepositoriesMode.FAIL_ON_PROJECT_REPOS`，
仓库只有 `google()` 和 `mavenCentral()`。CI 在 Jenkins 容器和 GitHub Actions 里跑，
两边都不会有 MissionGo 的源码检出，所以 `project(...)` 和 `mavenLocal()` 都不成立。

### 方案：复用已有的网站静态托管

MissionGo 的网站已经在 `apps/web/public/downloads/` 下分发 Android 管理 App 的 APK 和
AI Skill。SDK 的 Maven 制品走同一条路：

```
apps/web/public/maven/io/missiongo/missiongo-feedback/<version>/
    missiongo-feedback-<version>.aar
    missiongo-feedback-<version>.pom
    missiongo-feedback-<version>-sources.jar
    ...
```

- 发布 = `./gradlew :missiongo-feedback:publishReleasePublicationToWebsiteRepository`，
  写进 `apps/web/public/maven`，再随 `npm run build:web` 和现有部署流程上线；
- 消费 = 宿主加一行 `maven { url = uri("https://<origin>/maven") }`；
- 目录和 APK 一样 **不进 Git**（`.gitignore`），仓库里不留二进制。

**读匿名、写靠部署权限。** AAR 里不含任何密钥——endpoint 和 SDK Token 由宿主在自己的
构建期注入——所以制品本身不是机密。这样两套 CI 都不需要配 Maven 凭据，这是选它而不选
GitHub Packages 的主要原因。

### nginx

网站的 `location /` 会把未知路径回落到 `index.html`。Maven 客户端必须在制品缺失时看到
真正的 404，否则 Gradle 会拿到一个 200 的 HTML 然后报出难以定位的解析错误。因此需要一条
`location ^~ /maven/ { try_files $uri =404; }`。该 location 自己不加任何 `add_header`，
从而继承 server 级的安全响应头（见该文件里已有的注释）。

### 版本号

`0.1.0-SNAPSHOT` 不适合外部宿主：SNAPSHOT 会被 Gradle 反复重解析，且无法锁定。v0.2 起
版本号在 `sdks/android-feedback/gradle.properties` 里作为 `missiongoVersion` 单点定义，
默认 `0.2.0`，`-PmissiongoVersion=` 可覆盖。宿主永远钉死一个具体版本。

## 三、B：宿主接入契约收敛（P0）

外部宿主和仓库内宿主的差别在于"配置可能不存在"：新克隆的仓库、别人的机器、没有 Secret
的 CI，都拿不到 endpoint 和 Token。当前 `apps/android` 用一个假 Token 占位兜底，这在自家
验证 App 里没问题，放到外部宿主就是错的——它会让 SDK 带着必然 401 的 Token 初始化。

v0.2 的契约：

1. 宿主从 gitignore 的属性文件或环境变量读取 endpoint 和 Token，两者缺一即视为未配置；
2. 未配置时宿主 **不调用** `MissionGo.initialize`，并隐藏反馈入口；
3. `MissionGo` 的所有公开方法在未初始化时必须是安全的空操作，绝不抛异常、绝不崩宿主；
4. 文档给出这套写法作为标准接入姿势，而不是只给"配好了"的happy path。

第 3 条要逐个方法核对现有实现并补测试。这是 SDK 面对陌生宿主时最容易出事的地方：宿主的
崩溃永远算 SDK 的锅。

## 四、C：打开反馈时可选截图（P1）

### 为什么它是 P1 而不是路线图里排的第三

看一眼 MissionGo 自己的记录：AND-4 到 AND-14 几乎每一条都带一张手工截的图，而且描述里
写的是"见截图圈中位置"。也就是说当前的真实流程是：遇到问题 → 按电源+音量截图 → 打开
反馈 → 从相册里翻出刚才那张 → 上传。Hermes GO 已经报出来的 HG-9 到 HG-16 也全是这个路径。

`openFeedback` 拿得到 Activity，那一刻的屏幕就是用户想说的东西。省掉的是每一条反馈里
最烦的三步。

### 做法

- `FeedbackOptions` 增加 `captureScreenshot: Boolean = false`，默认关，宿主显式开启；
- 在 `openFeedback` 里、跳转 H5 之前，从 Activity 的 window 抓一帧（API 26+ 用
  `PixelCopy`，失败则降级为 `View.draw` 到 Bitmap），压成 JPEG 存到 SDK 自己的
  `noBackupFilesDir`，纳入现有的 24 小时快照清理；
- 作为一个"待上传附件"交给 H5，H5 里可预览、可删除、可走已有的 `ImageAnnotator` 涂鸦
  圈选（AND-2 已经把标注做进 H5 了，截图正好接上）；
- 默认不进相册，也不申请任何存储权限。

### 必须注意的边界

- 截图里可能有 Token、验证码、私信。所以默认关闭、用户在 H5 里能看到并删除，是这个功能
  可接受的前提，不是可选项；
- 带 `FLAG_SECURE` 的窗口抓不到，`PixelCopy` 会返回错误——这时静默跳过，不提示、不重试；
- 抓帧发生在主线程可见帧上，压缩和落盘必须在后台线程，不能卡住入口打开。

## 五、D：后台队列状态查询与通知（P1）

`enqueueFeedback` 返回一个 queueId，然后宿主就再也问不到任何事情了：不知道排队中、
不知道成功、不知道失败原因，只能盲目 `retryQueuedFeedback`。

v0.2 补最小的一层：

- `MissionGo.queuedFeedbackStatus(queueId): QueuedFeedbackStatus`（Pending / Running /
  Succeeded(itemKey) / Failed(code, message) / Cancelled / Expired）；
- `MissionGo.observeQueuedFeedback(queueId)`，基于 WorkManager 的 `WorkInfo` LiveData 转
  Flow，宿主可选订阅；
- 终态结果写进已有的本地快照目录，跟随同一套 24 小时过期，进程重启后仍可查询。

不做跨进程回调，也不做 SDK 自己弹通知——通知长什么样是宿主的事，SDK 只负责给出状态。

## 六、E：配额与审计（P2）

现在只有按 Token + 操作类型的频率限制。多一个外部宿主就多一个可被反编译提取的公开
Token，需要补：

- 按 Token 的日/月条数配额和字节配额，超出返回 429 并在管理端可见；
- `access_tokens` 增加最近使用 IP 和调用计数的聚合，让"这把 Token 还有没有流量"可判断
  ——没有这个数据就永远不敢吊销任何一把旧 Token；
- 管理端按 Token 封禁单个 `install_id` 的能力。

放 P2 是因为当前只有两个自己的宿主，风险还没兑现。但 Token 轮换所依赖的"最后使用时间 +
调用量"应该和 A 一起先埋数据，否则以后补不上历史。

## 七、Hermes GO 集成落地顺序

1. **MissionGo 管理端**：给 Hermes GO 产品建一个 `android` 类型的模块，再建一把限定到该
   产品和模块的 SDK Token。明文只显示一次。
2. **本机私密配置**：Token 和 endpoint 写进 Hermes 仓库里 gitignore 的
   `android/missiongo.properties`，CI 用 `MISSIONGO_ENDPOINT` / `MISSIONGO_SDK_TOKEN`
   环境变量。两者都没有时，Hermes 正常构建，只是反馈入口不出现。
3. **Gradle 接线**：`settings.gradle.kts` 加私有 Maven，版本目录加依赖，
   `app/build.gradle.kts` 生成两个 BuildConfig 字段。
4. **初始化**：`HermesApp.onCreate()` 中在配置齐备时 `MissionGo.initialize`。
5. **现场接线**：Hermes 已有的 `DebugLog` 滚动日志转发给 `MissionGo.log`，导航目的地转发
   给 `setCurrentScreen`，网关连接状态作为一个 context namespace。
6. **入口**：设置页加一条"反馈问题"，调用 `openFeedback`。UI 需遵循
   `hermes-remote/docs/DESIGN.md`。
7. **验收**：按 `getting-started.md` 第 7 节逐条过，重点是 Token 撤销后返回 401、
   R8 之后仍可用、SDK 网络错误不会让 Hermes 崩。

## 八、验收标准

v0.2 完成的判据是这一句：**在一台没有 MissionGo 源码的机器上克隆 hermes-remote，配好两个
环境变量，构建出的 APK 能把一条带截图的反馈提交到 Hermes GO 产品下。**
