package io.missiongo.android.badge

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.annotation.SuppressLint
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import io.missiongo.android.MainActivity
import io.missiongo.android.R
import java.util.concurrent.Executor
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference

/**
 * The number on the home-screen icon (AND-185): how many conversations wait
 * for the person, straight from the summary's `agent.attention`. One or more
 * draws the number, zero removes it, and a fetch that failed or never happened
 * leaves whatever is there alone -- the callers only reach this on a success.
 *
 * Two mechanisms, because neither covers the phones this app runs on by itself:
 *
 *  - **AOSP.** A channel with `showBadge` gets a dot for free once a
 *    notification is posted, and launchers that draw numbers read
 *    `Notification.number`. The number cannot exist without a notification to
 *    carry it, so while the count is at least one this keeps one silent
 *    low-importance notification alive (the trade-off settled on AND-185:
 *    every launcher gets the number, the shade carries one extra entry) and
 *    cancels it at zero. The attention announcements of AND-150 deliberately
 *    carry no number of their own: launchers sum the numbers of all posted
 *    notifications, so a second `setNumber` there would double the icon.
 *  - **Huawei / HONOR.** EMUI and MagicOS do not draw the AOSP dot at all. The
 *    count has to be handed to the launcher's own provider, and nothing
 *    appears until the app asks for it.
 *
 * The OEM path is measured behavior, not theory: on a HONOR CLK-AN00 (MagicOS,
 * Android 14) every channel's `showBadge` was on and a notification was posted
 * and visible, and still no badge appeared until this call existed (Hermes
 * GO's `LauncherBadge`, the verified implementation this follows).
 */
internal object LauncherBadge {
    /** One fixed id: the carrier is replaced, never stacked, and cancelled at zero. */
    const val CARRIER_NOTIFICATION_ID = 1850

    private const val CHANNEL_ID = "missiongo_badge"
    private const val CARRIER_REQUEST_CODE = 1850

    /** Bound to the first caller's application context, whose life is the process's. */
    @Volatile
    private var publisher: LatestCountPublisher? = null

    /** Publishes [count]; zero cancels the carrier and tells the OEM launchers nothing waits. */
    fun apply(context: Context, count: Int) {
        val appContext = context.applicationContext
        updateCarrier(appContext, count)
        if (!supportsOemBadge) return
        val current = publisher
            ?: LatestCountPublisher(push = { pushOemBadge(appContext, it) }).also { publisher = it }
        current.offer(count)
    }

    /**
     * The AOSP half. With notifications off, `notify` would silently show
     * nothing; checking first also skips building the carrier. What the icon
     * does in that state is then simply nothing, on every AOSP launcher -- the
     * OEM providers below do not go through the notification system and keep
     * working.
     */
    private fun updateCarrier(context: Context, count: Int) {
        val manager = NotificationManagerCompat.from(context)
        if (count <= 0) {
            manager.cancel(CARRIER_NOTIFICATION_ID)
            return
        }
        if (!manager.areNotificationsEnabled()) return
        ensureChannel(context)
        // Lint wants a POST_NOTIFICATIONS check here; areNotificationsEnabled
        // above is that check, and a denied permission makes notify a no-op
        // rather than an exception.
        @SuppressLint("MissingPermission")
        manager.notify(CARRIER_NOTIFICATION_ID, carrier(context, count))
    }

    private fun ensureChannel(context: Context) {
        // Below O there are no channels to configure; the carrier posts as-is.
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        manager.createNotificationChannel(
            NotificationChannel(
                CHANNEL_ID,
                context.getString(R.string.badge_channel_name),
                NotificationManager.IMPORTANCE_LOW,
            ).apply {
                description = context.getString(R.string.badge_channel_description)
                // The whole point of the channel: without this the carrier draws nothing.
                setShowBadge(true)
            },
        )
    }

    private fun carrier(context: Context, count: Int) =
        NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_attention)
            .setContentTitle(context.getString(R.string.badge_carrier_title, count))
            .setContentText(context.getString(R.string.badge_carrier_text))
            .setContentIntent(open(context))
            // The count is current for as long as the carrier stands; letting it be
            // swiped away would erase the number while conversations still wait.
            .setOngoing(true)
            // The channel is LOW and never alerts; this also keeps an update from
            // making a sound on the rare launcher that promotes the channel.
            .setOnlyAlertOnce(true)
            // The number the icon draws. The one place it is set -- see the class doc.
            .setNumber(count)
            .build()

    private fun open(context: Context): PendingIntent =
        PendingIntent.getActivity(
            context,
            CARRIER_REQUEST_CODE,
            MainActivity.openFromWidget(context, MainActivity.WidgetTarget.Console(null, null, true)),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

    /** True when some launcher accepted the count. */
    private fun pushOemBadge(context: Context, count: Int): Boolean {
        val launcher = context.packageManager
            .getLaunchIntentForPackage(context.packageName)?.component?.className
            ?: return false
        val extras = Bundle().apply {
            putString("package", context.packageName)
            putString("class", launcher)
            putInt("badgenumber", count)
        }
        // HONOR split from Huawei and kept the interface under its own authority; a
        // HONOR phone answers on `hihonor` and an older Huawei one on `huawei`. Try
        // both -- the wrong one is a failed call, not a wrong badge. `call` throws
        // on an unknown authority, which is the normal case on every other brand
        // and must never escape into the publisher's thread.
        var delivered = false
        for (authority in OEM_AUTHORITIES) {
            runCatching {
                context.contentResolver.call(Uri.parse("content://$authority/badge/"), "change_badge", null, extras)
            }.onSuccess { delivered = true }
        }
        return delivered
    }

    private val supportsOemBadge: Boolean
        get() = OEM_BRANDS.any { brand ->
            Build.MANUFACTURER.contains(brand, ignoreCase = true) ||
                Build.BRAND.contains(brand, ignoreCase = true)
        }

    private val OEM_AUTHORITIES = listOf(
        "com.hihonor.android.launcher.settings",
        "com.huawei.android.launcher.settings",
    )
    private val OEM_BRANDS = listOf("honor", "huawei")
}

/**
 * Hands counts to a launcher one at a time, newest first, and skips a count
 * the launcher already holds.
 *
 * A plain `apply` per count is two binder calls racing each other when two
 * fetches land close together: `apply(1)` then `apply(0)`, and if the 1 reaches
 * the HONOR launcher last the icon keeps it while the dedup believes 0 is out,
 * so every later `apply(0)` is skipped as a duplicate -- a badge that would not
 * come down after the person handled the work (HG-103 on the reference
 * implementation). One consumer over a single pending slot keeps the calls in
 * order and drops counts that were already superseded.
 *
 * The dedup compares against what the launcher actually accepted. A failed
 * push forgets itself, so the next offer of the same count tries again instead
 * of being suppressed.
 *
 * The app module carries no coroutines, so the channel-based original becomes
 * an [Executor]: the default is one background thread, and tests inject one
 * that runs in place, where every offer settles before `offer` returns.
 */
internal class LatestCountPublisher(
    private val push: (Int) -> Boolean,
    private val executor: Executor = Executors.newSingleThreadExecutor { runnable ->
        Thread(runnable, THREAD_NAME).apply { isDaemon = true }
    },
) {
    /** The newest offered count nobody has picked up yet, or null when the slot is empty. */
    private val pending = AtomicReference<Int?>(null)

    /** The count the launcher last accepted, or [NOT_PUBLISHED] when there is none to compare. */
    private val published = AtomicInteger(NOT_PUBLISHED)

    // Guards "a drain is queued", so a burst of offers schedules one drain, not N.
    private val drainLock = Any()

    @Volatile
    private var drainQueued = false

    fun offer(count: Int) {
        pending.set(count)
        synchronized(drainLock) {
            if (drainQueued) return
            drainQueued = true
            executor.execute(::drain)
        }
    }

    private fun drain() {
        synchronized(drainLock) { drainQueued = false }
        while (true) {
            val count = pending.getAndSet(null) ?: return
            if (count == published.get()) continue
            published.set(if (push(count)) count else NOT_PUBLISHED)
        }
    }

    private companion object {
        const val THREAD_NAME = "missiongo-badge-publisher"
        const val NOT_PUBLISHED = -1
    }
}
