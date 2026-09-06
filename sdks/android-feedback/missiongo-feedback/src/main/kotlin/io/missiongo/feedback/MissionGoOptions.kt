package io.missiongo.feedback

/**
 * Which light/dark appearance the feedback editor should use.
 *
 * [FollowSystem] is right for a host that has no theme setting of its own. A host that does —
 * most Compose apps offer light / dark / follow-system in their own settings — must pass its
 * own choice, because an in-app theme does not change the Android resource configuration: the
 * SDK cannot see it, and a user who chose dark inside a light system would otherwise land on a
 * white editor.
 */
public enum class MissionGoAppearance(internal val wireValue: String) {
    FollowSystem("system"),
    Light("light"),
    Dark("dark"),
}

/** Configuration supplied once from the host Application. */
public data class MissionGoOptions(
    public val endpoint: String,
    public val sdkToken: String,
    public val sourceRevision: String? = null,
    public val buildFlavor: String? = null,
    public val distributionChannel: String? = null,
    public val editorAppearance: MissionGoAppearance = MissionGoAppearance.FollowSystem,
    public val allowInsecureHttp: Boolean = false,
    public val connectTimeoutMillis: Int = 10_000,
    public val readTimeoutMillis: Int = 20_000,
    public val maxNetworkRetries: Int = 2,
    public val initialRetryDelayMillis: Long = 500,
    public val maxLogEntries: Int = 500,
    public val maxLogBytes: Int = 256 * 1024,
) {
    override fun toString(): String =
        "MissionGoOptions(endpoint=$endpoint, sdkToken=[REDACTED], sourceRevision=$sourceRevision, " +
            "buildFlavor=$buildFlavor, distributionChannel=$distributionChannel, " +
            "editorAppearance=$editorAppearance, " +
            "allowInsecureHttp=$allowInsecureHttp, maxNetworkRetries=$maxNetworkRetries)"
}
