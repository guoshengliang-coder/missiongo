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
// A checkout without the key still builds: debug falls back to the machine's own
// debug key and runs on a device, while release comes out unsigned and therefore
// cannot be installed at all. Nothing can be released under the wrong key by
// accident, and publish-android-internal.sh refuses before it gets that far.
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

// AND-150: the widget's FCM push. google-services.json never enters the
// repository (see .gitignore); like the signing key above, the build reads it
// from the private configuration directory and copies it in when present. A
// checkout without it still builds and runs -- the plugin stays unapplied,
// Firebase never initialises, and the widget falls back to its three refresh
// paths (periodic worker, leaving the app, the refresh pill).
val missionGoGoogleServicesPath = providers.gradleProperty("missiongoAndroidGoogleServices")
    .orElse(providers.environmentVariable("MISSIONGO_ANDROID_GOOGLE_SERVICES"))
    .orElse(
        providers.environmentVariable("XDG_CONFIG_HOME")
            .orElse(providers.systemProperty("user.home").map { "$it/.config" })
            .map { "$it/missiongo/google-services.json" },
    )
val missionGoGoogleServices = file("google-services.json")
if (!missionGoGoogleServices.isFile) {
    file(missionGoGoogleServicesPath.get()).takeIf { it.isFile }?.copyTo(missionGoGoogleServices)
}
val pushConfigured = missionGoGoogleServices.isFile
if (pushConfigured) {
    apply(plugin = "com.google.gms.google-services")
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
        // Fires at registerForActivityResult because an old fragment version is
        // on the merged classpath (via the feedback SDK). That risk is about
        // FragmentActivity losing the callback; MainActivity is a
        // ComponentActivity, which dispatches activity results itself.
        disable += "InvalidFragmentVersionForActivityResult"
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

dependencies {
    implementation(project(":missiongo-feedback"))
    implementation("androidx.activity:activity-ktx:1.11.0")
    // The widget's periodic refresh. Already in the APK through the feedback SDK;
    // declared here because this module now calls it directly. Keep the versions equal.
    implementation("androidx.work:work-runtime:2.11.2")
    // AND-150: FCM data-only push signals. Always compiled in so the source
    // builds everywhere; at runtime the Firebase check in push/ turns it off on
    // builds that shipped without google-services.json.
    implementation("com.google.firebase:firebase-messaging:24.1.0")
}
