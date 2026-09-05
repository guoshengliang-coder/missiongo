package io.missiongo.feedback

/** Configuration supplied once from the host Application. */
public data class MissionGoOptions(
    public val endpoint: String,
    public val sdkToken: String,
    public val sourceRevision: String? = null,
    public val buildFlavor: String? = null,
    public val distributionChannel: String? = null,
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
            "allowInsecureHttp=$allowInsecureHttp, maxNetworkRetries=$maxNetworkRetries)"
}
