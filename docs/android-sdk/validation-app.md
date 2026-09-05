# Android SDK 独立验证工具

## 集成方式

SDK 的独立验证工具位于 `sdks/android-feedback/sample`，与 SDK 在同一个 Gradle 构建中，并通过 `implementation(project(":missiongo-feedback"))` 引用 SDK。它只用于开发验证，不是 MissionGo Android 管理 App，也不得发布到 MissionGo 的正式下载链接。

这就是正常的 Android SDK 模块集成，只是依赖来源是当前仓库源码。更新 SDK 后重新构建宿主即可，无需先发布 Maven 包，也不会改变将来切换为私有 Maven 版本号依赖时的 SDK API。

## 配置边界

- 验证配置由开发机本地 Gradle 属性传入，仓库默认值不可连接真实服务；
- SDK Token 只用于反馈提交，不提供管理端能力；
- 宿主仅主动传递页面、业务摘要、日志、breadcrumb 和本次反馈上下文；
- 宿主数据库、SharedPreferences、账号凭据、输入框内容及敏感设备数据不会被默认读取。

## 第一阶段验收清单

### 1. 基础接入

- 验证工具可启动，配置有效服务地址和 SDK Token 后可打开反馈页；
- SDK 初始化不要求宿主申请定位、通讯录、短信或存储等额外权限。

### 2. 交互式反馈

- 标题、描述、类型和优先级可预填并可编辑；
- 图片、视频或日志附件可选择、失败重试并随草稿恢复；
- 提交成功返回工作条目编号；
- 用户取消和最终失败能回调宿主 App。

### 3. 宿主上下文

- 反馈中包含宿主主动设置的当前页面和验证场景；
- 点击“写入测试日志”后，新反馈携带该日志和 breadcrumb；
- 不包含账号、Token、Cookie、输入框原文、宿主数据库或 SharedPreferences 内容。

### 4. 弱网与恢复

- 断网时交互式草稿保留，恢复网络后可以继续；
- 杀死并重启 App 后，未过期草稿仍能恢复；
- 后台反馈在断网时等待，联网后自动提交；
- 重启 App 或系统后，WorkManager 队列仍可继续执行。

### 5. 安全与发布构建

- 撤销 SDK Token 后，新提交被拒绝；
- Debug 可按显式配置连接 HTTP 开发环境，Release 不允许明文 HTTP；
- 启用 R8 和资源压缩的 Release 构建通过；
- APK/AAB 中不包含管理端凭据或开发人员账号凭据。

## 发布隔离

`npm run publish:android-internal` 只发布 `apps/android` 中的 MissionGo Android 管理 App。SDK 独立验证工具必须单独构建、单独命名和定向传递，不能覆盖 `/downloads/missiongo-android-latest.apk`。

## 本阶段通过标准

以上用例在至少一台 Android 设备或模拟器完成；服务端能看到正确的产品、Android 模块、宿主上下文与附件；宿主无新增敏感权限；Release 构建通过。问题应记录为 MissionGo 工作条目，由人工决定是否验收通过。
