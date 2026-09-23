package io.missiongo.android.widget

import android.content.Context
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.NetworkType
import androidx.work.PeriodicWorkRequest
import androidx.work.WorkManager
import androidx.work.Worker
import androidx.work.WorkerParameters
import java.util.concurrent.TimeUnit

/** The periodic refresh while a widget is on a home screen. */
class WidgetRefreshWorker(context: Context, params: WorkerParameters) : Worker(context, params) {
    override fun doWork(): Result {
        WidgetRefresher.refresh(applicationContext)
        // A failed fetch is already on the widget. Retrying here would only
        // bunch requests up before the next period.
        return Result.success()
    }

    companion object {
        private const val UNIQUE_NAME = "missiongo-widget-refresh"

        // Android's floor for periodic work; the widget cannot ask for less.
        private const val PERIOD_MINUTES = 15L

        /** Idempotent: KEEP leaves an existing schedule alone, so it is safe on every update. */
        fun schedule(context: Context) {
            val request = PeriodicWorkRequest.Builder(WidgetRefreshWorker::class.java, PERIOD_MINUTES, TimeUnit.MINUTES)
                .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
                .build()
            WorkManager.getInstance(context)
                .enqueueUniquePeriodicWork(UNIQUE_NAME, ExistingPeriodicWorkPolicy.KEEP, request)
        }

        fun cancel(context: Context) {
            WorkManager.getInstance(context).cancelUniqueWork(UNIQUE_NAME)
        }
    }
}
