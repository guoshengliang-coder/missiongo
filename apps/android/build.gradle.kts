import java.util.Properties

plugins {
    id("com.android.application")
}

val missionGoEndpoint = providers.gradleProperty("missiongoAndroidEndpoint")
    .orElse(providers.environmentVariable("MISSIONGO_ANDROID_ENDPOINT"))
    .orElse("https://missiongo.example.invalid")
val missionGoSdkToken = providers.gradleProperty("missiongoAndroidSdkToken")
    .orElse(providers.environmentVariable("MISSIONGO_ANDROID_SDK_TOKEN"))
    .orElse("mg_sdk_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")
val missionGoVersionCode = providers.gradleProperty("missiongoAndroidVersionCode").orElse("1")
// No fallback on purpose: the version name is declared once, in
// sdks/android-feedback/gradle.properties. A literal default here would stamp a
// different version on any build that forgot to pass the property.
val missionGoVersionName = providers.gradleProperty("missiongoAndroidVersionName")

// Android identifies an app by package name *and* signing key, so a build signed
// with a different key cannot upgrade one already installed. The default debug
// keystore is generated per machine, which makes every workstation produce a
// mutually incompatible APK. Sign with a shared key kept beside the rest of the
// private publishing configuration instead; copying that directory to another
// machine is all it takes for its builds to upgrade in place.
//
// AGENTS.md forbids committing signing keys, so this only ever reads a path.
// A checkout without the key still builds and still runs on a device, falling
// back to the machine's debug key: scripts/publish-android-internal.sh is what
// insists on the shared one, because only published builds have to interoperate.
val missionGoSigningPath = providers.gradleProperty("missiongoAndroidSigningProperties")
    .orElse(providers.environmentVariable("MISSIONGO_ANDROID_SIGNING_PROPERTIES"))
    .orElse(
        providers.environmentVariable("XDG_CONFIG_HOME")
            .orElse(providers.systemProperty("user.home").map { "$it/.config" })
            .map { "$it/missiongo/android-signing.properties" },
    )
val missionGoSigningFile = file(missionGoSigningPath.get())
val missionGoSigning: Properties? = missionGoSigningFile.takeIf { it.isFile }?.let { source ->
    Properties().apply { source.inputStream().use { load(it) } }
}

fun buildConfigString(value: String): String =
    "\"${value.replace("\\", "\\\\").replace("\"", "\\\"")}\""

android {
    namespace = "io.missiongo.android"
    compileSdk = 36

    defaultConfig {
        // Declared in product.json and enforced by scripts/check-product-identity.mjs.
        // This was io.missiongo.feedback.sample, shared with the SDK validation
        // sample, so the two apps overwrote each other on a device and the
        // product identified itself as the sample everywhere Android shows a
        // package name. Changing it costs existing installs one uninstall.
        applicationId = "io.missiongo.android"
        minSdk = 23
        targetSdk = 36
        versionCode = missionGoVersionCode.get().toInt()
        versionName = missionGoVersionName.get()
        buildConfigField("String", "MISSIONGO_ENDPOINT", buildConfigString(missionGoEndpoint.get()))
        buildConfigField("String", "MISSIONGO_SDK_TOKEN", buildConfigString(missionGoSdkToken.get()))
    }

    signingConfigs {
        if (missionGoSigning != null) {
            create("missiongo") {
                // Resolved against the properties file so the whole private
                // configuration directory stays portable as one unit.
                storeFile = missionGoSigningFile.parentFile.resolve(missionGoSigning.getProperty("storeFile"))
                storePassword = missionGoSigning.getProperty("storePassword")
                keyAlias = missionGoSigning.getProperty("keyAlias")
                keyPassword = missionGoSigning.getProperty("keyPassword")
            }
        }
    }

    buildTypes {
        debug {
            if (missionGoSigning != null) signingConfig = signingConfigs.getByName("missiongo")
        }
        release {
            if (missionGoSigning != null) signingConfig = signingConfigs.getByName("missiongo")
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
        }
    }

    buildFeatures {
        buildConfig = true
    }

    lint {
        // API 36 is the SDK project's supported compile/target baseline.
        disable += "OldTargetApi"
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

dependencies {
    implementation(project(":missiongo-feedback"))
    implementation("androidx.activity:activity-ktx:1.11.0")
}
