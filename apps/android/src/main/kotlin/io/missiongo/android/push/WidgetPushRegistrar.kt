package io.missiongo.android.push

import android.content.Context
import com.google.firebase.FirebaseApp
import com.google.firebase.messaging.FirebaseMessaging
import io.missiongo.android.BuildConfig
import io.missiongo.android.MissionGoApplication
import io.missiongo.android.widget.DeviceRegistration
import io.missiongo.android.widget.WidgetSummaryClient
import kotlin.concurrent.thread

/**
 * Keeps this install's FCM token bound to the signed-in account (AND-150).
 *
 * firebase-messaging is compiled into every build so the source builds
 * everywhere, but a build that shipped without google-services.json has no
 * Firebase resources and no initialised FirebaseApp -- that check is the
 * off-switch for the whole push path.
 */
internal object WidgetPushRegistrar {
    /** Called from the activity's onResume: cheap, and retries after sign-in or connectivity problems. */
    fun ensureRegistered(context: Context) {
        if (FirebaseApp.getApps(context).isEmpty()) return
        if (!MissionGoApplication.isConfiguredEndpoint(BuildConfig.MISSIONGO_ENDPOINT)) return
        FirebaseMessaging.getInstance().token.addOnSuccessListener { token ->
            register(context, token)
        }
    }

    /** Sends the PUT on a background thread; the network never touches the caller's thread. */
    fun register(context: Context, token: String) {
        if (FirebaseApp.getApps(context).isEmpty()) return
        val appContext = context.applicationContext
        thread(name = THREAD_NAME) {
            when (WidgetSummaryClient.registerDeviceToken(BuildConfig.MISSIONGO_ENDPOINT, token)) {
                DeviceRegistration.DONE, DeviceRegistration.NOT_SIGNED_IN -> Unit
                // A failed registration retries on the next onResume, which is
                // frequent enough; a token that never registers costs a
                // notification, not data.
                DeviceRegistration.FAILED -> Unit
            }
        }
    }

    private const val THREAD_NAME = "missiongo-push-register"
}
