plugins {
    id("com.android.library")
    `maven-publish`
}

group = "io.missiongo"
version = providers.gradleProperty("missiongoVersion").orElse("0.2.3").get()

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
        // Let the android.jar stubs return defaults instead of throwing, so the
        // uninitialized-SDK contract can be asserted on a plain JVM test without pulling in
        // Robolectric for paths that never reach a real Android API.
        unitTests.isReturnDefaultValues = true
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
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.11.0")
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

    repositories {
        // The website already distributes the internal APK and the AI Skill from
        // apps/web/public. Publishing the AAR into the same tree makes it reachable at
        // <origin>/maven with no new infrastructure and no credentials: the artifact
        // holds no secret, because the endpoint and the SDK token are injected by each
        // host at its own build time. The directory is gitignored like the APK, so no
        // binary enters the repository; it ships with the next website deployment.
        maven {
            name = "website"
            url = uri(rootProject.layout.projectDirectory.dir("../../apps/web/public/maven"))
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
