package io.missiongo.feedback

import android.app.Application
import android.app.Activity
import android.content.Intent
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.Data
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequest
import androidx.work.WorkManager
import io.missiongo.feedback.internal.ContextStore
import io.missiongo.feedback.internal.EnvironmentCollector
import io.missiongo.feedback.internal.FeedbackApiClient
import io.missiongo.feedback.internal.FeedbackLogEntry
import io.missiongo.feedback.internal.FeedbackEditorSession
import io.missiongo.feedback.internal.FeedbackLaunchCallbacks
import io.missiongo.feedback.internal.FeedbackLaunchStore
import io.missiongo.feedback.internal.FeedbackSubmissionWorker
import io.missiongo.feedback.internal.PendingFeedback
import io.missiongo.feedback.internal.DiagnosticNormalizer
import io.missiongo.feedback.internal.SdkRuntime
import io.missiongo.feedback.internal.utcTimestamp
import java.io.File
import java.util.concurrent.TimeUnit

/**
 * Process-wide entry point. Initialization is safe to call more than once with the same options.
 *
 * ## Behaviour before [initialize]
 *
 * A host may legitimately never initialize: a fresh clone, another developer's machine, or a CI
 * runner has no endpoint and no SDK token, and the documented contract is that such a build works
 * normally with the feature simply absent. An SDK whose every method throws in that state forces
 * each host to wrap all of it in defensive code, and a host that forgets crashes for a feature it
 * never configured. So the uninitialized state is handled here, once, rather than by every caller:
 *
 * - **Recording** ([setCurrentScreen], [setContext], [clearContext], [addBreadcrumb], [log]) is
 *   dropped silently. These are called from dozens of places across a host; requiring a guard at
 *   each one buys nothing, because there is no report to attach the data to anyway.
 * - **[openFeedback]** never throws. With a callback it reports
 *   [FeedbackResult.Failed] `not_initialized`; without one there is nowhere to report, so it does
 *   nothing. This differs from a failure to start the editor Activity, which stays loud: that is a
 *   runtime anomaly, whereas not initializing is a configuration the host chose.
 * - **[enqueueFeedback]** returns null instead of a queue id.
 * - **[cancelQueuedFeedback]** and [retryQueuedFeedback] do nothing — with no runtime there is no
 *   queued work to act on.
 * - **Suspending submission** ([createDraft], [finalizeDraft], [submitFeedback]) throws
 *   [MissionGoException] `not_initialized`. A coroutine caller is already handling failure, and
 *   silently returning no work-item key would be worse than saying why.
 *
 * Hosts that want to hide their own entry point can read [isInitialized].
 */
public object MissionGo {
    @Volatile
    private var runtime: SdkRuntime? = null

    /** True once [initialize] has succeeded. Hosts use it to decide whether to offer a feedback entry. */
    @JvmStatic
    public val isInitialized: Boolean
        get() = runtime != null

    @JvmStatic
    public fun initialize(application: Application, options: MissionGoOptions) {
        val normalized = options.validate()
        synchronized(this) {
            val current = runtime
            if (current != null && current.options == normalized) {
                current.launches.cleanup()
                return
            }
            runtime = SdkRuntime(
                application = application,
                options = normalized,
                environment = EnvironmentCollector.collect(application, normalized),
                context = ContextStore(DiagnosticNormalizer()),
                api = FeedbackApiClient(normalized),
                launches = FeedbackLaunchStore(File(application.noBackupFilesDir, "missiongo-feedback/pending")),
                queue = FeedbackLaunchStore(File(application.noBackupFilesDir, "missiongo-feedback/queue")),
            )
        }
    }

    @JvmStatic
    public fun setCurrentScreen(name: String?) {
        val current = runtime ?: return
        current.context.setCurrentScreen(name)
    }

    @JvmStatic
    public fun setContext(namespace: String, values: Map<String, String>) {
        val current = runtime ?: return
        current.context.setContext(namespace, values)
    }

    @JvmStatic
    public fun clearContext(namespace: String) {
        val current = runtime ?: return
        current.context.clearContext(namespace)
    }

    @JvmStatic
    @JvmOverloads
    public fun addBreadcrumb(name: String, attributes: Map<String, String> = emptyMap()) {
        addLog(MissionGoLogLevel.Info, "breadcrumb:$name", null, attributes)
    }

    @JvmStatic
    @JvmOverloads
    public fun log(
        level: MissionGoLogLevel,
        message: String,
        throwable: Throwable? = null,
        attributes: Map<String, String> = emptyMap(),
    ) {
        addLog(level, message, throwable, attributes)
    }

    /** Creates or updates an idempotent server draft without making it a work item. */
    @JvmStatic
    public suspend fun createDraft(options: FeedbackOptions = FeedbackOptions()): FeedbackDraft {
        val current = requireRuntime()
        val snapshot = current.context.snapshot(options.context)
        val response = current.api.upsertDraft(
            options = options,
            environment = current.environment,
            context = snapshot.context,
            logs = snapshot.logs,
        )
        return FeedbackDraft(response.id, response.clientDraftId, response.expiresAt)
    }

    /** Finalizes a draft. Calling this repeatedly returns the same work-item key. */
    @JvmStatic
    public suspend fun finalizeDraft(draftId: String): FeedbackSubmission {
        val response = requireRuntime().api.finalizeDraft(draftId)
        val itemKey = response.itemKey
            ?: throw MissionGoException("invalid_server_response", "MissionGo did not return a work-item key.")
        return FeedbackSubmission(response.id, itemKey)
    }

    /** Programmatic end-to-end path used by automation and the sample app. */
    @JvmStatic
    public suspend fun submitFeedback(options: FeedbackOptions): FeedbackSubmission {
        val draft = createDraft(options)
        return finalizeDraft(draft.id)
    }

    /**
     * Persists a headless submission and lets WorkManager deliver it when a network is available.
     *
     * Returns the queue id, or null when the SDK was never initialized.
     */
    @JvmStatic
    public fun enqueueFeedback(options: FeedbackOptions): String? {
        val current = runtime ?: return null
        val snapshot = current.context.snapshot(options.context)
        val queueId = current.queue.put(
            PendingFeedback(options.copy(context = emptyMap()), current.environment, snapshot.context, snapshot.logs),
        )
        scheduleQueuedFeedback(current, queueId, ExistingWorkPolicy.KEEP)
        return queueId
    }

    /** Cancels pending background delivery and removes its app-private snapshot. */
    @JvmStatic
    public fun cancelQueuedFeedback(queueId: String) {
        val current = runtime ?: return
        WorkManager.getInstance(current.application).cancelUniqueWork(queueWorkName(queueId))
        current.queue.remove(queueId)
    }

    /** Re-enqueues a still-present snapshot after a terminal worker/configuration failure was corrected. */
    @JvmStatic
    public fun retryQueuedFeedback(queueId: String) {
        val current = runtime ?: return
        require(current.queue.get(queueId) != null) { "Queued feedback is missing or expired." }
        scheduleQueuedFeedback(current, queueId, ExistingWorkPolicy.REPLACE)
    }

    /** Opens the shared MissionGo H5 editor after creating a short-lived, draft-scoped session. */
    @JvmStatic
    @JvmOverloads
    public fun openFeedback(
        activity: Activity,
        options: FeedbackOptions = FeedbackOptions(),
        callback: FeedbackResultCallback? = null,
    ) {
        val current = runtime
        if (current == null) {
            // Not a crash: the host never configured MissionGo, which is a supported state. Say so
            // through the channel the caller already handles, and stay silent when there is none.
            callback?.onResult(
                FeedbackResult.Failed(
                    "not_initialized",
                    "MissionGo.initialize() was never called.",
                    retryable = false,
                ),
            )
            return
        }
        val snapshot = current.context.snapshot(options.context)
        val launchId = current.launches.put(
            PendingFeedback(options.copy(context = emptyMap()), current.environment, snapshot.context, snapshot.logs),
        )
        FeedbackLaunchCallbacks.register(launchId, callback)
        val launchFailure = runCatching {
            activity.startActivity(Intent(activity, MissionGoFeedbackActivity::class.java).putExtra("launchId", launchId))
        }.exceptionOrNull()
        if (launchFailure != null) {
            current.launches.remove(launchId)
            FeedbackLaunchCallbacks.complete(
                launchId,
                FeedbackResult.Failed(
                    "activity_launch_failed",
                    launchFailure.message ?: "Could not open feedback.",
                    retryable = false,
                ),
            )
            if (callback == null) throw launchFailure
        }
    }

    internal suspend fun prepareFeedbackEditor(launchId: String): FeedbackEditorSession {
        val current = requireRuntime()
        val pending = current.launches.get(launchId)
            ?: throw MissionGoException("feedback_expired", "The local feedback draft is missing or expired.")
        if (pending.draftId == null) {
            val prepared = current.api.prepareEditor(
                options = pending.options,
                environment = pending.environment,
                context = pending.context,
                logs = pending.logs,
            )
            val draft = prepared.draft
            current.launches.setDraftId(launchId, draft.id)
            return FeedbackEditorSession(
                current.options.endpoint,
                draft.id,
                prepared.sessionToken,
                draft.itemKey,
            )
        }
        val draft = current.api.getDraft(pending.draftId)
        if (draft.itemKey != null) {
            return FeedbackEditorSession(current.options.endpoint, draft.id, null, draft.itemKey)
        }
        val session = current.api.createWebSession(draft.id)
        return FeedbackEditorSession(current.options.endpoint, draft.id, session.token)
    }

    internal fun hasFeedbackLaunch(launchId: String?): Boolean = runtime?.launches?.get(launchId) != null

    // The launch store may be gone (process recreated without initialization), but the in-process
    // callback registry is not, so a waiting host still hears the outcome either way.
    internal fun completeFeedbackLaunch(launchId: String, result: FeedbackResult) {
        runtime?.launches?.remove(launchId)
        FeedbackLaunchCallbacks.complete(launchId, result)
    }

    internal fun discardFeedbackLaunch(launchId: String) {
        runtime?.launches?.remove(launchId)
        FeedbackLaunchCallbacks.discard(launchId)
    }

    internal suspend fun processQueuedFeedback(queueId: String): FeedbackSubmission {
        val current = requireRuntime()
        val pending = current.queue.get(queueId)
            ?: throw MissionGoException("queued_feedback_missing", "The queued feedback is missing or expired.")
        val draft = pending.draftId?.let { current.api.getDraft(it) } ?: current.api.upsertDraft(
            options = pending.options,
            environment = pending.environment,
            context = pending.context,
            logs = pending.logs,
        ).also { current.queue.setDraftId(queueId, it.id) }
        val submitted = if (draft.itemKey != null) draft else current.api.finalizeDraft(draft.id)
        val itemKey = submitted.itemKey
            ?: throw MissionGoException("invalid_server_response", "MissionGo did not return a work-item key.")
        current.queue.remove(queueId)
        return FeedbackSubmission(submitted.id, itemKey)
    }

    private fun scheduleQueuedFeedback(current: SdkRuntime, queueId: String, policy: ExistingWorkPolicy) {
        val request = OneTimeWorkRequest.Builder(FeedbackSubmissionWorker::class.java)
            .setInputData(Data.Builder().putString(FeedbackSubmissionWorker.QUEUE_ID_KEY, queueId).build())
            .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
            .addTag("missiongo-feedback")
            .build()
        WorkManager.getInstance(current.application).enqueueUniqueWork(queueWorkName(queueId), policy, request)
    }

    private fun queueWorkName(queueId: String): String = "missiongo-feedback-$queueId"

    private fun addLog(
        level: MissionGoLogLevel,
        message: String,
        throwable: Throwable?,
        attributes: Map<String, String>,
    ) {
        val current = runtime ?: return
        val completeMessage = if (throwable == null) message else "$message\n${throwable.stackTraceToString()}"
        current.context.addLog(
            FeedbackLogEntry(
                timestamp = utcTimestamp(),
                level = level.wireValue,
                message = completeMessage,
                attributes = attributes,
            ),
            current.options.maxLogEntries,
            current.options.maxLogBytes,
        )
    }

    private fun requireRuntime(): SdkRuntime = runtime
        ?: throw MissionGoException("not_initialized", "MissionGo.initialize() must be called before using the SDK.")
}

private fun MissionGoOptions.validate(): MissionGoOptions {
    val endpoint = endpoint.trim().trimEnd('/')
    val uri = try {
        java.net.URI(endpoint)
    } catch (error: Exception) {
        throw IllegalArgumentException("MissionGo endpoint must be a valid HTTP(S) origin.", error)
    }
    require(uri.scheme == "https" || (allowInsecureHttp && uri.scheme == "http")) {
        "MissionGo endpoint must use HTTPS unless allowInsecureHttp is explicitly enabled."
    }
    require(!uri.host.isNullOrBlank() && uri.userInfo == null && uri.query == null && uri.fragment == null) {
        "MissionGo endpoint must not contain credentials, a query, or a fragment."
    }
    require(uri.path.isNullOrEmpty() || uri.path == "/") { "MissionGo endpoint must be an origin without a path." }
    require(sdkToken.matches(Regex("^mg_sdk_[A-Za-z0-9_-]{43}$"))) { "MissionGo SDK token has an invalid format." }
    require(connectTimeoutMillis in 1_000..60_000) { "connectTimeoutMillis must be between 1000 and 60000." }
    require(readTimeoutMillis in 1_000..120_000) { "readTimeoutMillis must be between 1000 and 120000." }
    require(maxNetworkRetries in 0..4) { "maxNetworkRetries must be between 0 and 4." }
    require(initialRetryDelayMillis in 100..5_000) { "initialRetryDelayMillis must be between 100 and 5000." }
    require(maxLogEntries in 1..500) { "maxLogEntries must be between 1 and 500." }
    require(maxLogBytes in 4 * 1024..256 * 1024) { "maxLogBytes must be between 4 KiB and 256 KiB." }
    return copy(endpoint = endpoint)
}
