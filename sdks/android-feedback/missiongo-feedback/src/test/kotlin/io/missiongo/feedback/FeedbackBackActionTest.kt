package io.missiongo.feedback

import org.junit.Assert.assertEquals
import org.junit.Test

class FeedbackBackActionTest {
    @Test fun returnsOnlyTheTopLayerBeforeConsideringDiscard() {
        assertEquals(FeedbackBackAction.PopLayer, feedbackBackAction(true, false, 2, false))
        assertEquals(FeedbackBackAction.PopLayer, feedbackBackAction(true, false, 1, true))
        assertEquals(FeedbackBackAction.ConfirmDiscard, feedbackBackAction(true, false, 0, false))
    }

    @Test fun cannotDiscardASubmitOrAttachmentRetryInFlight() {
        assertEquals(FeedbackBackAction.Wait, feedbackBackAction(true, false, 0, true))
        assertEquals(FeedbackBackAction.Wait, feedbackBackAction(true, true, 0, true))
        assertEquals(FeedbackBackAction.Close, feedbackBackAction(true, true, 0, false))
        assertEquals(FeedbackBackAction.Close, feedbackBackAction(false, false, 0, false))
    }
}
