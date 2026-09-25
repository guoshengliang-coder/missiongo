package io.missiongo.android.widget

import android.content.Context
import io.missiongo.android.BuildConfig
import io.missiongo.android.badge.LauncherBadge
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.concurrent.thread

/**
 * The one refresh every entry point shares: the refresh button, the periodic
 * worker, leaving the app, and the push signal (AND-150). Sharing it is what
 * keeps them from drawing the widget three different ways -- and what lets the
 * launcher badge (AND-185) ride along on every fetch without each caller
 * remembering it.
 */
internal object WidgetRefresher {
    private val running = AtomicBoolean(false)

    /**
     * Fetches and redraws. Blocks, so never call it on the main thread. Returns
     * false, doing nothing, when a refresh is already under way in this process:
     * repeated taps on the button do not stack requests.
     */
    fun refresh(context: Context): Boolean {
        if (!running.compareAndSet(false, true)) return false
        refreshCycle(context)
        return true
    }

    /**
     * The same cycle for the push path, which also needs what the fetch
     * produced: the attention entries decide whether a notification is due.
     * Null when a refresh is already running -- its own result will reach the
     * notifier, so the caller needs nothing.
     */
    fun refreshForPush(context: Context): WidgetFetchResult? {
        if (!running.compareAndSet(false, true)) return null
        return refreshCycle(context)
    }

    private fun refreshCycle(context: Context): WidgetFetchResult {
        val appContext = context.applicationContext
        val store = WidgetStore(appContext)
        var result: WidgetFetchResult = WidgetFetchResult.Failed
        try {
            store.markRefreshing(System.currentTimeMillis())
            MissionGoWidgetProvider.redrawAll(appContext)
            result = when (val fetched = WidgetSummaryClient.fetch(BuildConfig.MISSIONGO_ENDPOINT)) {
                is WidgetFetchResult.Success -> {
                    store.saveSuccess(fetched.summary, System.currentTimeMillis())
                    // The badge tracks the fetched count, so it appears only after a
                    // real summary -- never on a guess -- and a failed fetch above or
                    // below leaves the last number standing instead of flashing 0.
                    LauncherBadge.apply(appContext, fetched.summary.attention)
                    fetched
                }
                WidgetFetchResult.SignedOut -> {
                    store.saveSignedOut()
                    // The sign-in that number belonged to is gone; the widget drops
                    // its numbers for the same reason (a stale count would read as
                    // "nothing needs you", or worse, as someone else's work).
                    LauncherBadge.apply(appContext, 0)
                    WidgetFetchResult.SignedOut
                }
                WidgetFetchResult.Failed -> {
                    store.saveFailure()
                    WidgetFetchResult.Failed
                }
            }
        } catch (error: Exception) {
            store.saveFailure()
            result = WidgetFetchResult.Failed
        } finally {
            running.set(false)
            MissionGoWidgetProvider.redrawAll(appContext)
        }
        return result
    }

    /**
     * For callers on the main thread. Refreshes regardless of whether a widget
     * is placed (AND-185): the badge needs the summary too, and "person just
     * left the app" is exactly when the count they cleared behind themselves
     * should come off the icon. The widget redraw inside the cycle is a no-op
     * when there is nothing to draw.
     */
    fun refreshInBackground(context: Context) {
        val appContext = context.applicationContext
        thread(name = "missiongo-widget-refresh") { refresh(appContext) }
    }
}
