package io.missiongo.android.widget

import android.content.Context

/**
 * What the widget last knew. Kept on disk because every entry point -- a tap,
 * the periodic worker, leaving the app, the launcher asking for a redraw -- may
 * run in a fresh process, and each has to draw the same widget.
 */
internal class WidgetStore(context: Context) {
    enum class Outcome { NONE, OK, FAILED, SIGNED_OUT }

    data class Snapshot(
        /** The last numbers that arrived. Null before the first success and after signing out. */
        val summary: WidgetSummary?,
        /** When [summary] arrived, in wall-clock milliseconds; 0 when there is none. */
        val updatedAt: Long,
        val outcome: Outcome,
        /** When the refresh under way started; 0 when none is. */
        val refreshingSince: Long,
    )

    // Writes use commit, not apply: the redraw right after each one reads the
    // file back, and a refresh inside a broadcast may lose its process as soon
    // as it finishes, taking a pending apply with it.
    private val prefs = context.applicationContext.getSharedPreferences(FILE, Context.MODE_PRIVATE)

    fun read(): Snapshot = Snapshot(
        summary = prefs.getString(KEY_SUMMARY, null)?.let { runCatching { WidgetSummary.parse(it) }.getOrNull() },
        updatedAt = prefs.getLong(KEY_UPDATED_AT, 0),
        outcome = prefs.getString(KEY_OUTCOME, null)
            ?.let { runCatching { Outcome.valueOf(it) }.getOrNull() }
            ?: Outcome.NONE,
        refreshingSince = prefs.getLong(KEY_REFRESHING_SINCE, 0),
    )

    fun markRefreshing(now: Long) {
        prefs.edit().putLong(KEY_REFRESHING_SINCE, now).commit()
    }

    fun saveSuccess(summary: WidgetSummary, now: Long) {
        prefs.edit()
            .putString(KEY_SUMMARY, summary.toJson())
            .putLong(KEY_UPDATED_AT, now)
            .putString(KEY_OUTCOME, Outcome.OK.name)
            .remove(KEY_REFRESHING_SINCE)
            .commit()
    }

    /** Keeps the last numbers: a failed refresh says so beside them rather than hiding them. */
    fun saveFailure() {
        prefs.edit()
            .putString(KEY_OUTCOME, Outcome.FAILED.name)
            .remove(KEY_REFRESHING_SINCE)
            .commit()
    }

    /**
     * Drops the numbers. They belong to a sign-in that no longer holds, and a
     * stale 0 would read as "nothing needs you".
     */
    fun saveSignedOut() {
        prefs.edit()
            .remove(KEY_SUMMARY)
            .remove(KEY_UPDATED_AT)
            .putString(KEY_OUTCOME, Outcome.SIGNED_OUT.name)
            .remove(KEY_REFRESHING_SINCE)
            .commit()
    }

    private companion object {
        const val FILE = "missiongo_widget"
        const val KEY_SUMMARY = "summary"
        const val KEY_UPDATED_AT = "updated_at"
        const val KEY_OUTCOME = "outcome"
        const val KEY_REFRESHING_SINCE = "refreshing_since"
    }
}
