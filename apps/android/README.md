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

## 应用身份

正式 App 的 applicationId 是 `io.missiongo.android`，名称取自 `@string/app_name`，图标与 `apps/web/public/icon.svg` 同源。这些值在 `product.json` 里声明一次，`npm run check` 会校验各处没有跑偏。

> **一次性过渡**：该 ID 此前是 `io.missiongo.feedback.sample`，与 SDK 验证 Sample 相同，两者在同一台手机上会互相顶掉。
>
> 改为正式 ID 后，Android 会把新版当作**另一个应用**，而不是升级——不卸载旧版的话，两个都叫 MissionGo、图标相同的条目会同时留在桌面上，且不会有任何报错提示。所以**已装旧版的手机必须先卸载再安装**。工作条目都在服务端，卸载不丢数据。
>
> 网页下载入口已加了对应提示（`androidReinstallNotice`）。确认试用者都已切到新包名后，可以把该提示、它的两个文案键和 `.download-note` 一并删掉——`apps/web/src/App.tsx` 里有标注。此后原地升级恢复正常。

## 签名

Android 用**包名 + 签名密钥**共同标识一个应用：签名密钥变了，已安装的版本就无法原地升级，只能卸载重装。而 Android SDK 默认的 `~/.android/debug.keystore` 是**每台机器各自生成**的——换台机器打包，签名就变了。

所以 MissionGo 使用一把共享密钥，放在私密配置目录里，与 `production.env`、`android-sdk-token.json` 同处：

```text
${XDG_CONFIG_HOME:-~/.config}/missiongo/
├── missiongo-android.jks           # 密钥库
└── android-signing.properties      # storeFile / keyAlias / storePassword / keyPassword
```

当前密钥证书指纹（SHA-256，公开信息，可用于核对下载到的 APK）：

```text
cce2861e3f9ee67f2c164c1cec818537342cddcaa11b8327dbee149b700ddea0
```

**换一台机器打包**：把上面整个目录拷过去即可，`storeFile` 按相对路径解析，不依赖绝对路径。

**没有这把密钥时**：`./gradlew` 仍可正常构建和真机调试，自动回退到本机默认 debug 密钥；只有 `npm run publish:android-internal` 会拒绝执行，因为只有对外发布的包才需要互相兼容。

> ⚠️ **这把密钥丢了就换不回来**：届时所有已安装的手机都必须卸载重装，且此后签名再次改变。请离线备份 `missiongo-android.jks` 和 `android-signing.properties`。密钥**不得进入 Git**（AGENTS.md 规则，`npm run check` 会校验仓库里没有被跟踪的密钥文件，也不允许 `build.gradle.kts` 里出现密码字面量）。

首次创建（仅在没有任何一台机器持有密钥时）：

```bash
CFG="${XDG_CONFIG_HOME:-$HOME/.config}/missiongo"
PW=$(openssl rand -base64 24 | tr -d '\n')
keytool -genkeypair -keystore "$CFG/missiongo-android.jks" -storetype PKCS12 \
  -alias missiongo -keyalg RSA -keysize 2048 -validity 10000 \
  -storepass "$PW" -keypass "$PW" -dname "CN=MissionGo Internal, O=MissionGo, C=CN"
umask 077 && printf 'storeFile=missiongo-android.jks\nkeyAlias=missiongo\nstorePassword=%s\nkeyPassword=%s\n' "$PW" "$PW" \
  > "$CFG/android-signing.properties"
```

该密钥面向内部分发。将来若要上架应用商店，还需另行处理商店的签名托管方案。

SDK 的独立验证入口保留在 `sdks/android-feedback/sample`，不得发布到 MissionGo 正式下载链接。
