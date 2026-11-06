package io.missiongo.android.release

/** Unknown, failed and expired signals must never present as a running update. */
object ReleaseAvailability {
    fun isUpdating(version: Int, phase: String, expiresAt: Long, now: Long): Boolean =
        version == 1 && phase == "upgrading" && expiresAt > now && expiresAt <= now + 15 * 60_000
}
