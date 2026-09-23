package io.missiongo.android.widget

import android.appwidget.AppWidgetManager
import android.content.ComponentName
import android.content.Context
import io.missiongo.android.BuildConfig
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.concurrent.thread

/**
 * The one refresh every entry point shares: the refresh button, the periodic
 * worker, and leaving the app. Sharing it is what keeps them from drawing the
 * widget three different ways.
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
        val appContext = context.applicationContext
        val store = WidgetStore(appContext)
        try {
            store.markRefreshing(System.currentTimeMillis())
            MissionGoWidgetProvider.redrawAll(appContext)
            when (val result = WidgetSummaryClient.fetch(BuildConfig.MISSIONGO_ENDPOINT)) {
                is WidgetFetchResult.Success -> store.saveSuccess(result.summary, System.currentTimeMillis())
                WidgetFetchResult.SignedOut -> store.saveSignedOut()
                WidgetFetchResult.Failed -> store.saveFailure()
            }
        } catch (error: Exception) {
            store.saveFailure()
        } finally {
            running.set(false)
            MissionGoWidgetProvider.redrawAll(appContext)
        }
        return true
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
