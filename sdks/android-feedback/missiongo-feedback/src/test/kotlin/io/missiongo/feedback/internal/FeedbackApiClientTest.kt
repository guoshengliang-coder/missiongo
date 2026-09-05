package io.missiongo.feedback.internal

import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class FeedbackApiClientTest {
    @Test
    fun retriesOnlyTransientHttpFailures() {
        assertTrue(isRetryableHttpStatus(408))
        assertTrue(isRetryableHttpStatus(429))
        assertTrue(isRetryableHttpStatus(500))
        assertTrue(isRetryableHttpStatus(503))
        assertFalse(isRetryableHttpStatus(400))
        assertFalse(isRetryableHttpStatus(401))
        assertFalse(isRetryableHttpStatus(409))
    }
}
