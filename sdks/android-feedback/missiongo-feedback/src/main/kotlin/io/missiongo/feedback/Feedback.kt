package io.missiongo.feedback

import java.util.UUID

public enum class FeedbackType(internal val wireValue: String) {
    Idea("idea"),
    Requirement("requirement"),
    Bug("bug"),
    Task("task"),
    Note("note"),
}

public enum class FeedbackPriority(internal val wireValue: String) {
    Urgent("urgent"),
    High("high"),
    Normal("normal"),
    Low("low"),
}

public enum class MissionGoLogLevel(internal val wireValue: String) {
    Debug("debug"),
    Info("info"),
    Warn("warn"),
    Error("error"),
}

/** Values suggested by the host for one feedback report. Users will be able to edit these in the H5 flow. */
public data class FeedbackOptions(
    public val title: String = "",
    public val description: String = "",
    public val type: FeedbackType = FeedbackType.Bug,
    public val priority: FeedbackPriority = FeedbackPriority.Normal,
    public val context: Map<String, String> = emptyMap(),
    public val clientDraftId: String = UUID.randomUUID().toString(),
)

public data class FeedbackDraft(
    public val id: String,
    public val clientDraftId: String,
    public val expiresAt: String,
)

public data class FeedbackSubmission(
    public val draftId: String,
    public val itemKey: String,
)

public sealed interface FeedbackResult {
    public data class Submitted(public val submission: FeedbackSubmission) : FeedbackResult

    public data object Cancelled : FeedbackResult

    public data class Failed(public val code: String, public val message: String) : FeedbackResult
}

public fun interface FeedbackResultCallback {
    public fun onResult(result: FeedbackResult)
}

public class MissionGoException(
    public val code: String,
    message: String,
    cause: Throwable? = null,
    internal val retryable: Boolean = false,
) : Exception(message, cause)
