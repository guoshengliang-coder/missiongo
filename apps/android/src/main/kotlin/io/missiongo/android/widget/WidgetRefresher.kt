package io.missiongo.android.widget

import android.appwidget.AppWidgetManager
import android.content.ComponentName
import android.content.Context
import io.missiongo.android.BuildConfig
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.concurrent.thread

/**
 * The one refresh every entry point shares: the refresh button, the periodic
 * worker, leaving the app, and the push signal (AND-150). Sharing it is what
 * keeps them from drawing the widget three different ways.
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
                    fetched
                }
                WidgetFetchResult.SignedOut -> {
                    store.saveSignedOut()
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

    /** For callers on the main thread. Does nothing when no widget is on a home screen. */
    fun refreshInBackground(context: Context) {
        val appContext = context.applicationContext
        if (!hasWidgets(appContext)) return
        thread(name = "missiongo-widget-refresh") { refresh(appContext) }
    }

    fun hasWidgets(context: Context): Boolean =
        AppWidgetManager.getInstance(context)
            .getAppWidgetIds(ComponentName(context, MissionGoWidgetProvider::class.java))
            .isNotEmpty()
}
