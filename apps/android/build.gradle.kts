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
val missionGoVersionName = providers.gradleProperty("missiongoAndroidVersionName").orElse("0.1.0")

fun buildConfigString(value: String): String =
    "\"${value.replace("\\", "\\\\").replace("\"", "\\\"")}\""

android {
    namespace = "io.missiongo.android"
    compileSdk = 36

    defaultConfig {
        // Keep the first internal sample package ID so website downloads upgrade in place.
        applicationId = "io.missiongo.feedback.sample"
        minSdk = 23
        targetSdk = 36
        versionCode = missionGoVersionCode.get().toInt()
        versionName = missionGoVersionName.get()
        buildConfigField("String", "MISSIONGO_ENDPOINT", buildConfigString(missionGoEndpoint.get()))
        buildConfigField("String", "MISSIONGO_SDK_TOKEN", buildConfigString(missionGoSdkToken.get()))
    }

    buildTypes {
        debug {}
        release {
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
