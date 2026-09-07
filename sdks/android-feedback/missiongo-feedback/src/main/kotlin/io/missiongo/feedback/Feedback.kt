package io.missiongo.feedback

import java.io.File
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
    /**
     * Files to attach, uploaded by the SDK once the report exists.
     *
     * This is the way to send a complete diagnostic history. [MissionGo.log] carries a bounded
     * in-memory trail — 500 entries and 256 KiB, which the server rejects the whole report for
     * exceeding — while a host that already writes its own rolling log file can hand the file
     * over instead: no entry limit, its own line format, and its own true timestamps.
     *
     * Each file must exist and be readable when the report is submitted; the queue path can run
     * long after the call, so a file in a cache the host may clear is a poor choice. Uploads
     * happen after the work item is created, so a failed upload leaves the report itself intact
     * and is reported through [FeedbackResult.Failed] only for the interactive flow.
     */
    public val attachments: List<File> = emptyList(),
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

    /**
     * @param code one of the SDK's own codes, a code the server sent, or `http_<status>`.
     * @param retryable whether the same request could still succeed — the SDK already knows
     *   this (it decides its own retries from it), so a host offering a "try again" button
     *   should read it here rather than keep its own list of codes.
     */
    public data class Failed(
        public val code: String,
        public val message: String,
        public val retryable: Boolean = false,
    ) : FeedbackResult
}

public fun interface FeedbackResultCallback {
    public fun onResult(result: FeedbackResult)
}

/**
 * @param code one of the SDK's own codes, a code the server sent, or `http_<status>`.
 * @param retryable whether the same request could still succeed. Public because a host with an
 *   error-handling policy has to decide whether to offer a retry, and the alternative — copying
 *   the SDK's list of codes into the host — goes stale the moment the server adds one.
 */
public class MissionGoException(
    public val code: String,
    message: String,
    cause: Throwable? = null,
    public val retryable: Boolean = false,
) : Exception(message, cause)
