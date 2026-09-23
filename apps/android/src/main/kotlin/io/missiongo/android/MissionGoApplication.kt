package io.missiongo.android

import android.app.Application
import androidx.work.Configuration
import io.missiongo.feedback.MissionGo
import io.missiongo.feedback.MissionGoOptions

/**
 * Provides WorkManager's configuration so it starts on first use instead of at
 * process start. The manifest removes the startup provider that would otherwise
 * initialise it on every launch; only the home-screen widget's periodic refresh
 * needs it (AND-149).
 */
class MissionGoApplication : Application(), Configuration.Provider {
    override val workManagerConfiguration: Configuration
        get() = Configuration.Builder().build()

    override fun onCreate() {
        super.onCreate()
        if (isConfiguredEndpoint(BuildConfig.MISSIONGO_ENDPOINT) && !isPlaceholderToken(BuildConfig.MISSIONGO_SDK_TOKEN)) {
            MissionGo.initialize(
                application = this,
                options = MissionGoOptions(
                    endpoint = BuildConfig.MISSIONGO_ENDPOINT.trimEnd('/'),
                    sdkToken = BuildConfig.MISSIONGO_SDK_TOKEN,
                    buildFlavor = BuildConfig.BUILD_TYPE,
                    distributionChannel = "missiongo-direct-download",
                    allowInsecureHttp = false,
                ),
            )
            MissionGo.setCurrentScreen("missiongo_android")
            MissionGo.setContext(
                "host",
                mapOf(
                    "hostApp" to "MissionGo",
                    "version" to BuildConfig.VERSION_NAME,
                ),
            )
        }
    }

    private fun isPlaceholderToken(token: String): Boolean = token.startsWith("mg_sdk_AAAAA")

    companion object {
        fun isConfiguredEndpoint(endpoint: String): Boolean =
            endpoint.startsWith("https://") && !endpoint.endsWith(".invalid")
    }
}
