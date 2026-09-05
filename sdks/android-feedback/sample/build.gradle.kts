plugins {
    id("com.android.application")
}

val sampleEndpoint = providers.gradleProperty("missiongoSampleEndpoint")
    .orElse("https://missiongo.example.invalid")
val sampleToken = providers.gradleProperty("missiongoSampleToken")
    .orElse("mg_sdk_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")

android {
    namespace = "io.missiongo.feedback.sample"
    compileSdk = 36

    defaultConfig {
        applicationId = "io.missiongo.feedback.sample"
        minSdk = 23
        targetSdk = 36
        versionCode = 2
        versionName = "0.1.1"
        buildConfigField("String", "MISSIONGO_ENDPOINT", "\"${sampleEndpoint.get()}\"")
        buildConfigField("String", "MISSIONGO_SDK_TOKEN", "\"${sampleToken.get()}\"")
    }

    buildFeatures {
        buildConfig = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

dependencies {
    implementation(project(":missiongo-feedback"))
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.11.0")
}
