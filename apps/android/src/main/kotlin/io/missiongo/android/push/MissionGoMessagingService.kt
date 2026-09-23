package io.missiongo.android.push

import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import io.missiongo.android.widget.WidgetFetchResult
import io.missiongo.android.widget.WidgetRefresher
import kotlin.concurrent.thread

/**
 * The receiving half of AND-150. The server sends a data-only message -- nothing
 * but "the widget may be stale" -- so nothing about the person's work transits
 * Google: this service refetches the summary itself, redraws the widget, and
 * decides locally whether a notification is due.
 *
 * Data-only messages arrive here whether the app is foreground, background, or
 * freshly started for this delivery, which is why the server chose them over
 * notification messages.
 */
class MissionGoMessagingService : FirebaseMessagingService() {
    override fun onMessageReceived(message: RemoteMessage) {
        if (message.data[KEY_SIGNAL] != SIGNAL_REFRESH) return
        // The fetch blocks for seconds; onMessageReceived's own thread should not.
        thread(name = THREAD_NAME) {
            when (val result = WidgetRefresher.refreshForPush(applicationContext)) {
                is WidgetFetchResult.Success -> WidgetNotifier.onSummaryFetched(applicationContext, result.summary)
                // Signed out or unreachable: the widget already carries the state,
                // and a notification with nothing behind it is noise.
                else -> Unit
            }
        }
    }

    /**
     * FCM rotates tokens; the new one must be bound to the account again or this
     * install stops hearing about changes. Registration only works while the
     * WebView holds a sign-in; without one the next app open retries it.
     */
    override fun onNewToken(token: String) {
        WidgetPushRegistrar.register(applicationContext, token)
    }

    private companion object {
        const val KEY_SIGNAL = "widget"
        const val SIGNAL_REFRESH = "refresh"
        const val THREAD_NAME = "missiongo-push-refresh"
    }
}
