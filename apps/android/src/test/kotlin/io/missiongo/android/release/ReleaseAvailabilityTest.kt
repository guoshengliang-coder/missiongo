package io.missiongo.android.release

import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class ReleaseAvailabilityTest {
    @Test fun onlyCurrentBoundedDeploymentSignalsAreUpdates() {
        val now = 1_000_000L
        assertTrue(ReleaseAvailability.isUpdating(1, "upgrading", now + 600_000, now))
        assertFalse(ReleaseAvailability.isUpdating(1, "upgrading", now, now))
        assertFalse(ReleaseAvailability.isUpdating(1, "upgrading", now + 900_001, now))
        assertFalse(ReleaseAvailability.isUpdating(1, "failed", now + 600_000, now))
        assertFalse(ReleaseAvailability.isUpdating(1, "idle", 0, now))
        assertFalse(ReleaseAvailability.isUpdating(2, "upgrading", now + 600_000, now))
    }
    @Test fun failedExpiredUnknownAndRecoveryRemainDistinct() {
        val now = 1_000_000L
        kotlin.test.assertEquals(ReleaseAvailability.State.FAILED, ReleaseAvailability.classify(1, "failed", now + 1000, now))
        kotlin.test.assertEquals(ReleaseAvailability.State.EXPIRED, ReleaseAvailability.classify(1, "upgrading", now, now))
        kotlin.test.assertEquals(ReleaseAvailability.State.IDLE, ReleaseAvailability.classify(1, "idle", 0, now))
        kotlin.test.assertEquals(ReleaseAvailability.State.UNAVAILABLE, ReleaseAvailability.classify(1, "unknown", now + 1000, now))
        kotlin.test.assertEquals("health_timeout", ReleaseAvailability.failureReason("health", "health_timeout", now, now))
        kotlin.test.assertNull(ReleaseAvailability.failureReason("health", "secret raw log", now, now))
        kotlin.test.assertNull(ReleaseAvailability.failureReason("command", "health_timeout", now, now))
        kotlin.test.assertNull(ReleaseAvailability.failureReason("health", "health_timeout", now + 60001, now))
    }
}
