package io.missiongo.feedback.internal

import android.content.Context
import androidx.work.CoroutineWorker
import androidx.work.Data
import androidx.work.WorkerParameters
import io.missiongo.feedback.MissionGo
import io.missiongo.feedback.MissionGoException

internal class FeedbackSubmissionWorker(
    appContext: Context,
    parameters: WorkerParameters,
) : CoroutineWorker(appContext, parameters) {
    override suspend fun doWork(): Result {
        val queueId = inputData.getString(QUEUE_ID_KEY) ?: return Result.failure(problem("queued_feedback_id_missing"))
        return try {
            val submission = MissionGo.processQueuedFeedback(queueId)
            Result.success(
                Data.Builder()
                    .putString("draftId", submission.draftId)
                    .putString("itemKey", submission.itemKey)
                    .build(),
            )
        } catch (failure: MissionGoException) {
            if (failure.retryable) {
                Result.retry()
            } else {
                Result.failure(problem(failure.code, failure.message))
            }
        } catch (failure: IllegalStateException) {
            Result.failure(problem("sdk_not_initialized", failure.message))
        } catch (failure: Exception) {
            if (runAttemptCount < MAX_UNEXPECTED_RETRIES) Result.retry()
            else {
                Result.failure(problem("unexpected_error", failure.message))
            }
        }
    }

    private fun problem(code: String, message: String? = null): Data = Data.Builder()
        .putString("code", code)
        .putString("message", message)
        .build()

    internal companion object {
        const val QUEUE_ID_KEY = "queueId"
        private const val MAX_UNEXPECTED_RETRIES = 3
    }
}
