plugins {
    id("com.android.library")
    `maven-publish`
}

group = "io.missiongo"
version = providers.gradleProperty("missiongoVersion").orElse("0.2.5").get()

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
    testImplementation("org.json:json:20260814")
}

// A published version is immutable: every release verifies the older artifacts byte for
// byte, and hosts pin an exact version. Publishing over one that already exists would break
// that silently -- a host resolving the same number on a clean CI would get different code.
//
// It nearly happened: two changes landed in the SDK after 0.2.3 shipped without the version
// being bumped, and the next publish would have overwritten it. Nothing warned, because the
// convention lived only in whoever remembered it.
//
// Bump missiongoVersion in gradle.properties. Pass -PmissiongoAllowRepublish=true only to
// republish deliberately, knowing what already carries that number.
val publishedVersionDirectory = rootProject.layout.projectDirectory
    .dir("../../apps/web/public/maven/io/missiongo/missiongo-feedback/$version")
    .asFile
val allowRepublish = providers.gradleProperty("missiongoAllowRepublish")
    .map(String::toBoolean)
    .getOrElse(false)

tasks.matching { it.name == "publishReleasePublicationToWebsiteRepository" }.configureEach {
    doFirst {
        if (publishedVersionDirectory.isDirectory && !allowRepublish) {
            throw GradleException(
                "Version $version is already published at ${publishedVersionDirectory.path}.\n" +
                    "Bump missiongoVersion in gradle.properties, or pass " +
                    "-PmissiongoAllowRepublish=true to overwrite it on purpose.",
            )
        }
    }
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
