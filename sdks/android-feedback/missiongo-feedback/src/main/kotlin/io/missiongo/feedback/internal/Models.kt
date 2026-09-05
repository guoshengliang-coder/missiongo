package io.missiongo.feedback.internal

import io.missiongo.feedback.MissionGoOptions

internal data class FeedbackEnvironment(
    val appVersion: String?,
    val buildNumber: String?,
    val sourceRevision: String?,
    val osVersion: String,
    val deviceModel: String,
    val metadata: Map<String, String>,
)

internal data class FeedbackLogEntry(
    val timestamp: String,
    val level: String,
    val message: String,
    val attributes: Map<String, String> = emptyMap(),
)

internal data class FeedbackSnapshot(
    val context: Map<String, String>,
    val logs: List<FeedbackLogEntry>,
)

internal data class DraftResponse(
    val id: String,
    val clientDraftId: String,
    val expiresAt: String,
    val itemKey: String?,
)

internal data class FeedbackWebSession(
    val token: String,
    val expiresAt: String,
)

internal data class PreparedEditorResponse(
    val draft: DraftResponse,
    val sessionToken: String?,
)

internal data class FeedbackEditorSession(
    val endpoint: String,
    val draftId: String,
    val token: String?,
    val submittedItemKey: String? = null,
)

internal data class PendingFeedback(
    val options: io.missiongo.feedback.FeedbackOptions,
    val environment: FeedbackEnvironment,
    val context: Map<String, String>,
    val logs: List<FeedbackLogEntry>,
    val draftId: String? = null,
)

internal data class SdkRuntime(
    val application: android.app.Application,
    val options: MissionGoOptions,
    val environment: FeedbackEnvironment,
    val context: ContextStore,
    val api: FeedbackApiClient,
    val launches: FeedbackLaunchStore,
    val queue: FeedbackLaunchStore,
)
