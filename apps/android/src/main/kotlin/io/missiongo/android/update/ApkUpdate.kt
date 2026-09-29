package io.missiongo.android.update

import java.io.File
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest

/**
 * Downloading the app's own APK and proving it is the file the server promised
 * (AND-258).
 *
 * The page decides *whether* an update exists and shows its notes; this is the
 * half a page cannot do. Everything here is deliberately unable to reach an
 * arbitrary host or accept an arbitrary file:
 *
 *  - the caller rebuilds the URL from this app's configured endpoint, so only
 *    [isAllowedDownloadPath] and nothing from the manifest chooses a host;
 *  - the download is hashed while it streams and discarded unless the SHA-256
 *    matches, which catches a truncated or corrupted transfer. It is not a
 *    second line of defence against a compromised server -- the manifest and
 *    the APK come from the same origin over the same TLS connection -- but it
 *    is what stops a half-finished file from ever reaching the installer.
 *
 * Kept free of Android types so the path, digest and streaming rules are
 * ordinary JVM unit tests; the activity owns the dialog and the intent.
 */
internal object ApkUpdate {
    /** The only prefix the app downloads from. The APK is always served from here. */
    const val DOWNLOAD_PATH_PREFIX = "/downloads/"

    private const val CONNECT_TIMEOUT_MS = 15_000
    private const val READ_TIMEOUT_MS = 60_000
    private const val BUFFER_BYTES = 64 * 1024

    /** A ceiling, not a size check: the published APK is ~320 KB. */
    private const val MAX_BYTES = 200L * 1024 * 1024

    sealed interface Result {
        data class Success(val file: File) : Result

        /** The bytes did not hash to what the manifest said. The file is deleted. */
        data object DigestMismatch : Result

        data class Failed(val reason: String) : Result
    }

    /**
     * Whether [path] is something this app will fetch. A path, never a URL:
     * the caller prefixes its own endpoint. Refuses traversal, a query or
     * fragment (which could redirect the fetch elsewhere), and anything that is
     * not an APK under the download prefix.
     */
    fun isAllowedDownloadPath(path: String): Boolean {
        if (!path.startsWith(DOWNLOAD_PATH_PREFIX)) return false
        if (!path.endsWith(".apk")) return false
        if (path.contains("..") || path.contains('\\') || path.contains('?') || path.contains('#')) return false
        return true
    }

    /** Lowercase hex, 64 characters -- the shape the manifest promises. */
    fun isHexDigest(value: String): Boolean =
        value.length == 64 && value.all { it in '0'..'9' || it in 'a'..'f' }

    /**
     * Fetches [url] into [destination]. [onProgress] is called with bytes so far
     * and the total when the server declared one, or -1 when it did not.
     */
    fun download(
        url: URL,
        expectedSha256: String,
        destination: File,
        onProgress: (copied: Long, total: Long) -> Unit = { _, _ -> },
    ): Result {
        val connection = try {
            url.openConnection() as HttpURLConnection
        } catch (error: Exception) {
            return Result.Failed(error.javaClass.simpleName)
        }
        return try {
            connection.connectTimeout = CONNECT_TIMEOUT_MS
            connection.readTimeout = READ_TIMEOUT_MS
            connection.instanceFollowRedirects = false
            connection.useCaches = false
            val status = connection.responseCode
            if (status != HttpURLConnection.HTTP_OK) return Result.Failed("HTTP $status")
            copyVerified(connection.inputStream, destination, expectedSha256, connection.contentLengthLong, onProgress)
        } catch (error: Exception) {
            destination.delete()
            Result.Failed(error.javaClass.simpleName)
        } finally {
            connection.disconnect()
        }
    }

    /**
     * Streams [input] into [destination] while hashing it, and keeps the file
     * only when its SHA-256 is [expectedSha256]. Factored out of [download] so a
     * test can drive it with bytes instead of a server.
     */
    fun copyVerified(
        input: InputStream,
        destination: File,
        expectedSha256: String,
        expectedSize: Long = -1,
        onProgress: (copied: Long, total: Long) -> Unit = { _, _ -> },
    ): Result {
        val digest = MessageDigest.getInstance("SHA-256")
        var total = 0L
        try {
            destination.outputStream().use { output ->
                val buffer = ByteArray(BUFFER_BYTES)
                while (true) {
                    val read = input.read(buffer)
                    if (read < 0) break
                    total += read
                    if (total > MAX_BYTES) {
                        destination.delete()
                        return Result.Failed("too large")
                    }
                    digest.update(buffer, 0, read)
                    output.write(buffer, 0, read)
                    onProgress(total, expectedSize)
                }
            }
        } catch (error: Exception) {
            destination.delete()
            return Result.Failed(error.javaClass.simpleName)
        }
        val actual = digest.digest().joinToString("") { byte -> "%02x".format(byte) }
        if (actual != expectedSha256) {
            destination.delete()
            return Result.DigestMismatch
        }
        return Result.Success(destination)
    }
}
