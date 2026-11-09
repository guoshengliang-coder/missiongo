package io.missiongo.android.release

/** Unknown, failed and expired signals must never present as a running update. */
object ReleaseAvailability {
    enum class State { UPDATING, FAILED, EXPIRED, IDLE, UNAVAILABLE }
    fun classify(version: Int, phase: String, expiresAt: Long, now: Long): State {
        if (version != 1) return State.UNAVAILABLE
        if (phase == "idle") return State.IDLE
        if (phase != "upgrading" && phase != "failed") return State.UNAVAILABLE
        if (expiresAt <= now) return State.EXPIRED
        if (expiresAt > now + 15 * 60_000) return State.UNAVAILABLE
        return if (phase == "upgrading") State.UPDATING else State.FAILED
    }
    fun isUpdating(version: Int, phase: String, expiresAt: Long, now: Long): Boolean =
        classify(version, phase, expiresAt, now) == State.UPDATING

    /** A manual GET retry needs no recovery claim; active upgrades still block it. */
    fun shouldRetryMainFrame(state: State, manual: Boolean, sawUpdate: Boolean): Boolean =
        state != State.UPDATING && (manual || state == State.IDLE && sawUpdate)

    /** Only public enum codes survive; no server-provided free text enters the UI. */
    fun failureReason(stage: String, reason: String, occurredAt: Long, now: Long): String? =
        if (stage in setOf("restart", "health") && occurredAt > 0 && occurredAt <= now + 60_000 &&
            reason in setOf("restart_check_failed", "health_timeout", "health_unavailable", "health_mismatch", "health_invalid")) reason else null
}
