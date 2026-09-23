package io.missiongo.android.widget

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.view.View
import android.widget.RemoteViews
import io.missiongo.android.MainActivity
import io.missiongo.android.R
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import kotlin.concurrent.thread

/**
 * The 2x2 home-screen widget (AND-149): how many Agent conversations need the
 * person, how many items are ready, and a way into each.
 */
class MissionGoWidgetProvider : AppWidgetProvider() {
    override fun onEnabled(context: Context) {
        WidgetRefreshWorker.schedule(context)
    }

    override fun onDisabled(context: Context) {
        WidgetRefreshWorker.cancel(context)
    }

    override fun onUpdate(context: Context, manager: AppWidgetManager, appWidgetIds: IntArray) {
        // Also here and not only in onEnabled: an app update or a restored backup
        // brings widgets back without enabling them again. KEEP makes it free.
        WidgetRefreshWorker.schedule(context)
        manager.updateAppWidget(appWidgetIds, render(context, WidgetStore(context).read()))
        refreshAsync(context)
    }

    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action == ACTION_REFRESH) {
            refreshAsync(context)
            return
        }
        super.onReceive(context, intent)
    }

    private fun refreshAsync(context: Context) {
        val pending = goAsync()
        val appContext = context.applicationContext
        thread(name = "missiongo-widget-refresh") {
            try {
                WidgetRefresher.refresh(appContext)
            } finally {
                pending.finish()
            }
        }
    }

    companion object {
        private const val ACTION_REFRESH = "io.missiongo.android.widget.REFRESH"

        /**
         * A refresh that started this long ago and never finished belongs to a
         * process that died mid-request. Showing it as still running would leave
         * the button spinning forever.
         */
        private const val REFRESH_ABANDONED_AFTER_MS = 30_000L

        private const val REQUEST_REFRESH = 1
        private const val REQUEST_CONSOLE = 2
        private const val REQUEST_ITEMS = 3
        private const val REQUEST_SIGN_IN = 4

        fun redrawAll(context: Context) {
            val manager = AppWidgetManager.getInstance(context)
            val ids = manager.getAppWidgetIds(ComponentName(context, MissionGoWidgetProvider::class.java))
            if (ids.isNotEmpty()) manager.updateAppWidget(ids, render(context, WidgetStore(context).read()))
        }

        internal fun render(
            context: Context,
            snapshot: WidgetStore.Snapshot,
            now: Long = System.currentTimeMillis(),
        ): RemoteViews {
            val views = RemoteViews(context.packageName, R.layout.widget_missiongo)
            views.setOnClickPendingIntent(R.id.widget_refresh_target, refreshIntent(context))

            // Signed out: no numbers at all. The last ones belong to a sign-in
            // that no longer holds, and the only useful tap is into the app.
            val signedOut = snapshot.outcome == WidgetStore.Outcome.SIGNED_OUT
            views.setViewVisibility(R.id.widget_login_area, visibleIf(signedOut))
            views.setViewVisibility(R.id.widget_agent_area, visibleIf(!signedOut))
            views.setViewVisibility(R.id.widget_items_area, visibleIf(!signedOut))
            views.setViewVisibility(R.id.widget_refresh_target, visibleIf(!signedOut))
            if (signedOut) {
                views.setOnClickPendingIntent(
                    R.id.widget_login_area,
                    activityIntent(context, REQUEST_SIGN_IN, MainActivity.openFromWidget(context, null)),
                )
                return views
            }

            val refreshing = snapshot.refreshingSince > 0 &&
                now - snapshot.refreshingSince in 0 until REFRESH_ABANDONED_AFTER_MS
            val failed = !refreshing && snapshot.outcome == WidgetStore.Outcome.FAILED
            val updatedAt = snapshot.updatedAt.takeIf { it > 0 }?.let(::clockTime)
            renderRefreshPill(context, views, refreshing, failed, updatedAt)

            val summary = snapshot.summary
            val hasAttention = (summary?.attention ?: 0) > 0
            val attention = summary?.attention?.toString() ?: context.getString(R.string.widget_no_value)
            // Two views per state rather than setTextColor: a colour set in code is
            // fixed when drawn, while one from resources follows the system into
            // and out of dark mode without waiting for the next refresh.
            views.setTextViewText(R.id.widget_attention_count, attention)
            views.setTextViewText(R.id.widget_attention_count_idle, attention)
            views.setViewVisibility(R.id.widget_attention_count, visibleIf(hasAttention))
            views.setViewVisibility(R.id.widget_attention_count_idle, visibleIf(!hasAttention))
            views.setViewVisibility(R.id.widget_attention_chip, visibleIf(hasAttention))
            views.setViewVisibility(R.id.widget_attention_chip_idle, visibleIf(!hasAttention))

            when {
                summary == null -> {
                    views.setViewVisibility(R.id.widget_status_running, View.GONE)
                    views.setViewVisibility(R.id.widget_status_separator, View.GONE)
                    views.setViewVisibility(R.id.widget_status_failed, View.GONE)
                }
                failed && updatedAt != null -> {
                    views.setViewVisibility(R.id.widget_status_running, View.VISIBLE)
                    views.setTextViewText(R.id.widget_status_running, context.getString(R.string.widget_stale, updatedAt))
                    views.setViewVisibility(R.id.widget_status_separator, View.GONE)
                    views.setViewVisibility(R.id.widget_status_failed, View.GONE)
                }
                else -> {
                    views.setViewVisibility(R.id.widget_status_running, View.VISIBLE)
                    views.setTextViewText(
                        R.id.widget_status_running,
                        context.getString(R.string.widget_active_count, summary.active),
                    )
                    views.setViewVisibility(R.id.widget_status_separator, visibleIf(summary.failed > 0))
                    views.setViewVisibility(R.id.widget_status_failed, visibleIf(summary.failed > 0))
                    views.setTextViewText(
                        R.id.widget_status_failed,
                        context.getString(R.string.widget_failed_count, summary.failed),
                    )
                }
            }

            views.setTextViewText(
                R.id.widget_ready_count,
                summary?.ready?.toString() ?: context.getString(R.string.widget_no_value),
            )

            views.setOnClickPendingIntent(
                R.id.widget_agent_area,
                activityIntent(
                    context,
                    REQUEST_CONSOLE,
                    MainActivity.openFromWidget(
                        context,
                        MainActivity.WidgetTarget.Console(
                            productId = summary?.attentionProductId,
                            sessionId = summary?.attentionSessionId,
                            attentionOnly = hasAttention,
                        ),
                    ),
                ),
            )
            views.setOnClickPendingIntent(
                R.id.widget_items_area,
                activityIntent(
                    context,
                    REQUEST_ITEMS,
                    MainActivity.openFromWidget(context, MainActivity.WidgetTarget.ReadyItems(summary?.readyProductId)),
                ),
            )
            return views
        }

        private fun renderRefreshPill(
            context: Context,
            views: RemoteViews,
            refreshing: Boolean,
            failed: Boolean,
            updatedAt: String?,
        ) {
            views.setViewVisibility(R.id.widget_refresh_icon, visibleIf(!refreshing && !failed))
            views.setViewVisibility(R.id.widget_refresh_progress, visibleIf(refreshing))
            views.setViewVisibility(R.id.widget_refresh_alert, visibleIf(failed))
            views.setViewVisibility(R.id.widget_refresh_text, visibleIf(!failed))
            views.setViewVisibility(R.id.widget_refresh_error_text, visibleIf(failed))
            views.setInt(
                R.id.widget_refresh_pill,
                "setBackgroundResource",
                if (failed) R.drawable.widget_pill_error else R.drawable.widget_pill,
            )
            views.setTextViewText(
                R.id.widget_refresh_text,
                when {
                    refreshing -> context.getString(R.string.widget_refreshing)
                    updatedAt != null -> updatedAt
                    else -> context.getString(R.string.widget_no_value)
                },
            )
            views.setContentDescription(
                R.id.widget_refresh_target,
                when {
                    refreshing -> context.getString(R.string.widget_refreshing)
                    failed -> context.getString(R.string.widget_refresh_retry_description)
                    updatedAt != null -> context.getString(R.string.widget_refresh_description, updatedAt)
                    else -> context.getString(R.string.widget_refresh)
                },
            )
        }

        private fun refreshIntent(context: Context): PendingIntent = PendingIntent.getBroadcast(
            context,
            REQUEST_REFRESH,
            Intent(context, MissionGoWidgetProvider::class.java).setAction(ACTION_REFRESH),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

        private fun activityIntent(context: Context, requestCode: Int, intent: Intent): PendingIntent =
            PendingIntent.getActivity(
                context,
                requestCode,
                intent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            )

        private fun clockTime(millis: Long): String =
            SimpleDateFormat("HH:mm", Locale.getDefault()).format(Date(millis))

        private fun visibleIf(visible: Boolean): Int = if (visible) View.VISIBLE else View.GONE
    }
}
