package io.missiongo.feedback

import android.app.Activity
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * A host that never calls [MissionGo.initialize] is a supported state, not a misuse: a fresh
 * clone or a CI runner has no endpoint and no SDK token. These tests pin the promise that such a
 * host cannot be crashed by the SDK, so nobody has to re-derive it by wrapping every call site in
 * defensive code.
 *
 * [MissionGo] is a process-wide object, so these tests depend on no other test in this module
 * initializing it.
 */
class UninitializedMissionGoTest {
    @Test
    fun reportsThatItIsNotInitialized() {
        assertFalse(MissionGo.isInitialized)
    }

    @Test
    fun recordingIsDroppedSilently() {
        MissionGo.setCurrentScreen("search_result")
        MissionGo.setContext("search", mapOf("resultCount" to "0"))
        MissionGo.clearContext("search")
        MissionGo.addBreadcrumb("search_submitted")
        MissionGo.log(MissionGoLogLevel.Error, "Search failed", IllegalStateException("boom"))
    }

    @Test
    fun openFeedbackReportsFailureInsteadOfThrowing() {
        var result: FeedbackResult? = null
        MissionGo.openFeedback(Activity(), FeedbackOptions(title = "Search failed")) { result = it }

        val failure = result as? FeedbackResult.Failed
        assertTrue(failure != null, "expected a Failed result, got $result")
        assertEquals("not_initialized", failure.code)
    }

    @Test
    fun openFeedbackWithoutCallbackDoesNothing() {
        MissionGo.openFeedback(Activity(), FeedbackOptions(title = "Search failed"))
    }

    @Test
    fun enqueueFeedbackReturnsNoQueueId() {
        assertNull(MissionGo.enqueueFeedback(FeedbackOptions(title = "Index sync failed")))
    }

    @Test
    fun queueMaintenanceDoesNothing() {
        MissionGo.cancelQueuedFeedback("missing-queue-id")
        MissionGo.retryQueuedFeedback("missing-queue-id")
    }

    @Test
    fun suspendingSubmissionFailsWithATypedCode() = runTest {
        val failure = runCatching { MissionGo.submitFeedback(FeedbackOptions(title = "Search failed")) }
            .exceptionOrNull()

        val missionGoFailure = failure as? MissionGoException
        assertTrue(missionGoFailure != null, "expected a MissionGoException, got $failure")
        assertEquals("not_initialized", missionGoFailure.code)
    }
}
