package io.missiongo.android.push

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import androidx.core.app.NotificationManagerCompat
import io.missiongo.android.BuildConfig
import io.missiongo.android.widget.WidgetRefresher
import io.missiongo.android.widget.WidgetSummaryClient
import kotlin.concurrent.thread

/**
 * The notification's 「无需处理」button (AND-150): dismisses the session's
 * attention server-side. The revision it carries is the one the notification
 * was built from, so a session that has since changed is not dismissed by
 * accident -- the server rejects the stale revision and the state stays.
 */
internal class DismissReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val sessionId = intent.getStringExtra(EXTRA_SESSION_ID) ?: return
        val revision = intent.getStringExtra(EXTRA_REVISION) ?: return
        val appContext = context.applicationContext
        NotificationManagerCompat.from(appContext).cancel(WidgetNotifier.NOTIFICATION_ID)
        // goAsync would be tighter, but the call can outlive its window; a plain
        // thread keeps the process alive for it the way the widget's refreshes do.
        thread(name = THREAD_NAME) {
            WidgetSummaryClient.dismissAttention(BuildConfig.MISSIONGO_ENDPOINT, sessionId, revision)
            // The server announces the dismissal it just recorded, which refreshes
            // the widget through this same push path; refresh anyway so a device
            // without push credentials still catches up promptly.
            WidgetRefresher.refreshInBackground(appContext)
        }
    }

    companion object {
        const val ACTION_DISMISS = "io.missiongo.android.action.DISMISS_ATTENTION"
        const val EXTRA_SESSION_ID = "io.missiongo.android.extra.SESSION_ID"
        const val EXTRA_REVISION = "io.missiongo.android.extra.REVISION"
        private const val THREAD_NAME = "missiongo-attention-dismiss"
    }
}
