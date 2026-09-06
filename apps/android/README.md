# MissionGo Android App

这是 MissionGo 正式 Android 管理端，不是 SDK 测试工具。App 使用原生 WebView 打开 MissionGo 管理界面，网页功能发布后会自动生效；Android 反馈 SDK 作为宿主能力通过源码模块接入，不在首页显示测试控件。

## 产品行为

- 启动后直接打开 MissionGo 管理界面；
- 登录 Cookie 和网页本地数据由系统 WebView 持久保存；
- 支持网页文件选择与多附件上传；
- Android 返回键优先返回网页历史；
- 外部域名交给系统浏览器处理；
- 加载失败时只显示产品级重试页面，不暴露服务地址或 SDK 配置。

## SDK 接入

App 直接引用仓库内的 Android SDK 源码模块：

```kotlin
implementation(project(":missiongo-feedback"))
```

生产内部包在构建时从开发机私密配置注入服务地址和 SDK Token。真实配置只存在于开发机和构建产物中，不写入 Git 跟踪文件。普通本地构建使用无效占位配置；也可以通过以下环境变量或同名 Gradle 属性传入：

```text
MISSIONGO_ANDROID_ENDPOINT
MISSIONGO_ANDROID_SDK_TOKEN
```

## 构建

从 Android SDK 的 Gradle 根目录运行：

```bash
cd sdks/android-feedback
./gradlew :missiongo-android-app:assembleDebug
./gradlew :missiongo-android-app:assembleRelease
```

Debug APK 位于：

```text
apps/android/build/outputs/apk/debug/missiongo-android-app-debug.apk
```

## 发布

```bash
npm run publish:android-internal
```

该命令读取开发机私密配置，生成递增 `versionCode` 的内部签名 APK，原子替换网站的固定下载文件，把版本号记录到同目录的 `missiongo-android-latest.release`，并重新构建 Web。版本名只在 `sdks/android-feedback/gradle.properties` 的 `missiongoAndroidVersionName` 里声明一次，Gradle 和发布脚本都读它，改版本只改那一处。APK 被 Git 忽略；网站的“下载安卓版”始终指向 `/downloads/missiongo-android-latest.apk`。

生产环境的下载文件由宿主机反向代理从自己的目录提供，`scripts/deploy.sh` 会在部署时把本次快照携带的 APK 发布到那里并原子切换软链接。因此请先执行上面的发布命令，再执行部署；否则部署会把过期的 APK 当作最新版发布出去。详见[部署说明](../../deploy/README.md)。

当前保留早期 APK 的应用 ID 和调试签名，确保测试手机可以直接覆盖升级。正式对外分发前，需要另行迁移到正式应用 ID 和仓库外保存的发布签名。

SDK 的独立验证入口保留在 `sdks/android-feedback/sample`，不得发布到 MissionGo 正式下载链接。
