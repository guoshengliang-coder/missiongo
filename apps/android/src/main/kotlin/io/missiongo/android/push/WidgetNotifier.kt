package io.missiongo.android.push

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import io.missiongo.android.MainActivity
import io.missiongo.android.R
import io.missiongo.android.widget.WidgetAttentionEntry
import io.missiongo.android.widget.WidgetStore
import io.missiongo.android.widget.WidgetSummary

/**
 * Decides whether a fetched summary deserves a notification, and posts it
 * (AND-150).
 *
 * The rule is anti-noise first: the first signal a device ever receives only
 * records a baseline -- announcing the backlog that was already there when push
 * was set up would wake the person for old news. After that, a notification
 * appears only when a conversation *newly* waits (a pair of session and revision
 * the person has not been told about). Things that resolved update the baseline
 * silently.
 */
internal object WidgetNotifier {
    private const val CHANNEL_ID = "missiongo_attention"

    /** One fixed id: a new signal replaces the previous notification instead of stacking. */
    const val NOTIFICATION_ID = 1501

    fun onSummaryFetched(context: Context, summary: WidgetSummary) {
        val store = WidgetStore(context)
        val entries = summary.attentionEntries
        val waiting = entries.map { "${it.sessionId}:${it.revision}" }.toSet()
        val baseline = store.readAttentionBaseline()
        if (baseline == null) {
            store.saveAttentionBaseline(waiting)
            return
        }
        if (waiting == baseline) return
        store.saveAttentionBaseline(waiting)
        // Conversations that left the set are good news; only arrivals announce.
        if ((waiting - baseline).isEmpty()) return
        val appContext = context.applicationContext
        if (!NotificationManagerCompat.from(appContext).areNotificationsEnabled()) return
        post(appContext, entries)
    }

    private fun post(context: Context, entries: List<WidgetAttentionEntry>) {
        val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        manager.createNotificationChannel(
            NotificationChannel(
                CHANNEL_ID,
                context.getString(R.string.push_channel_name),
                NotificationManager.IMPORTANCE_DEFAULT,
            ).apply {
                description = context.getString(R.string.push_channel_description)
            },
        )
        val notification = if (entries.size == 1) single(context, entries.first()) else merged(context, entries)
        NotificationManagerCompat.from(context).notify(NOTIFICATION_ID, notification)
    }

    /** 「AND-7 待回答」+ excerpt, with the two actions the design settled on. */
    private fun single(context: Context, entry: WidgetAttentionEntry) =
        base(context)
            .setContentTitle(title(context, entry))
            .setContentText(entry.excerpt)
            .setContentIntent(open(context, MainActivity.WidgetTarget.Console(entry.productId, entry.sessionId, false)))
            .addAction(0, context.getString(R.string.push_attention_open), open(context, MainActivity.WidgetTarget.Console(entry.productId, entry.sessionId, false)))
            .addAction(0, context.getString(R.string.push_attention_dismiss), dismiss(context, entry))
            .build()

    /** The merged form: one line for all of them, opening the "needs me" filter. */
    private fun merged(context: Context, entries: List<WidgetAttentionEntry>): android.app.Notification {
        val first = title(context, entries.first())
        val text = if (entries.size > 1) {
            context.getString(R.string.push_attention_many_body, first, entries.size - 1)
        } else {
            first
        }
        return base(context)
            .setContentTitle(context.getString(R.string.push_attention_many_title, entries.size))
            .setContentText(text)
            .setStyle(NotificationCompat.BigTextStyle().bigText(text))
            .setContentIntent(open(context, MainActivity.WidgetTarget.Console(null, null, true)))
            .build()
    }

    private fun base(context: Context) = NotificationCompat.Builder(context, CHANNEL_ID)
        .setSmallIcon(R.drawable.ic_stat_attention)
        .setAutoCancel(true)
        .setOnlyAlertOnce(false)
        .setCategory(NotificationCompat.CATEGORY_MESSAGE)

    private fun title(context: Context, entry: WidgetAttentionEntry): String {
        val label = when (entry.kind) {
            "answer" -> R.string.attention_answer
            "approval" -> R.string.attention_approval
            "action" -> R.string.attention_action
            "instruction" -> R.string.attention_instruction
            else -> R.string.attention_uncertain
        }
        val kind = context.getString(label)
        val key = entry.itemKeys.firstOrNull()
        return if (key == null) kind else context.getString(R.string.push_attention_title, key, kind)
    }

    private fun open(context: Context, target: MainActivity.WidgetTarget): PendingIntent =
        PendingIntent.getActivity(
            context,
            target.hashCode(),
            MainActivity.openFromWidget(context, target),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

    private fun dismiss(context: Context, entry: WidgetAttentionEntry): PendingIntent =
        PendingIntent.getBroadcast(
            context,
            0,
            Intent(context, DismissReceiver::class.java).apply {
                setAction(DismissReceiver.ACTION_DISMISS)
                putExtra(DismissReceiver.EXTRA_SESSION_ID, entry.sessionId)
                putExtra(DismissReceiver.EXTRA_REVISION, entry.revision)
            },
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
}
