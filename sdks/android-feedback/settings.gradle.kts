pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "missiongo-android-feedback"
include(":missiongo-feedback")
include(":sample")
include(":missiongo-android-app")
project(":missiongo-android-app").projectDir = file("../../apps/android")
