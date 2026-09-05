package io.missiongo.feedback.sample

import android.app.Application
import io.missiongo.feedback.MissionGo
import io.missiongo.feedback.MissionGoOptions

class SampleApplication : Application() {
    override fun onCreate() {
        super.onCreate()
        MissionGo.initialize(
            application = this,
            options = MissionGoOptions(
                endpoint = BuildConfig.MISSIONGO_ENDPOINT,
                sdkToken = BuildConfig.MISSIONGO_SDK_TOKEN,
            ),
        )
    }
}
