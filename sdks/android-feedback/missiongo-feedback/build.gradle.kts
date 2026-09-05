plugins {
    id("com.android.library")
    `maven-publish`
}

group = "io.missiongo"
version = providers.gradleProperty("missiongoVersion").orElse("0.1.0-SNAPSHOT").get()

android {
    namespace = "io.missiongo.feedback"
    compileSdk = 36

    defaultConfig {
        minSdk = 23
        consumerProguardFiles("consumer-rules.pro")
    }

    buildFeatures {
        buildConfig = false
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    testOptions {
        unitTests.isIncludeAndroidResources = true
    }

    publishing {
        singleVariant("release") {
            withSourcesJar()
        }
    }
}

dependencies {
    implementation("androidx.activity:activity-ktx:1.11.0")
    implementation("androidx.work:work-runtime:2.11.2")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.11.0")
    testImplementation("org.jetbrains.kotlin:kotlin-test-junit:2.3.21")
    testImplementation("org.json:json:20240303")
}

publishing {
    publications {
        register<MavenPublication>("release") {
            afterEvaluate {
                from(components["release"])
            }
            artifactId = "missiongo-feedback"
            pom {
                name.set("MissionGo Android Feedback SDK")
                description.set("Capture structured Android feedback for a self-hosted MissionGo server.")
                licenses {
                    license {
                        name.set("Apache License 2.0")
                        url.set("https://www.apache.org/licenses/LICENSE-2.0")
                    }
                }
            }
        }
    }

    val repositoryUrl = providers.gradleProperty("missiongoMavenUrl")
        .orElse(providers.environmentVariable("MISSIONGO_MAVEN_URL"))
    if (repositoryUrl.isPresent) {
        repositories {
            maven {
                name = "missiongo"
                url = uri(repositoryUrl.get())
                credentials {
                    username = providers.gradleProperty("missiongoMavenUsername")
                        .orElse(providers.environmentVariable("MISSIONGO_MAVEN_USERNAME"))
                        .orNull
                    password = providers.gradleProperty("missiongoMavenPassword")
                        .orElse(providers.environmentVariable("MISSIONGO_MAVEN_PASSWORD"))
                        .orNull
                }
            }
        }
    }
}
