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
}
