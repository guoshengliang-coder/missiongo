package io.missiongo.feedback

internal enum class FeedbackBackAction { PopLayer, Wait, Close, ConfirmDiscard }

/** Topmost Web layer first; only the editor root can discard the draft. */
internal fun feedbackBackAction(hasEditor: Boolean, completed: Boolean, depth: Int, busy: Boolean): FeedbackBackAction = when {
    !hasEditor -> FeedbackBackAction.Close
    depth > 0 -> FeedbackBackAction.PopLayer
    busy -> FeedbackBackAction.Wait
    completed -> FeedbackBackAction.Close
    else -> FeedbackBackAction.ConfirmDiscard
}
