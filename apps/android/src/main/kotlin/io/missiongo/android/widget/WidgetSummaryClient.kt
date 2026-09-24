package io.missiongo.android.widget

import android.net.Uri
import android.util.Log
import android.webkit.CookieManager
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

internal sealed interface WidgetFetchResult {
    data class Success(val summary: WidgetSummary) : WidgetFetchResult
    /** The server does not know who is asking: the page's sign-in has lapsed or never happened. */
    data object SignedOut : WidgetFetchResult
    data object Failed : WidgetFetchResult
}

/** What a device-token registration call came to (AND-150). */
internal enum class DeviceRegistration { DONE, NOT_SIGNED_IN, FAILED }

/**
 * Reads the summary with the sign-in the WebView already holds. The app has no
 * credential of its own, and inventing one for the widget would be a second
 * sign-in to keep alive; the page's session cookie is the one that is already
 * kept fresh by using the app.
 */
internal object WidgetSummaryClient {
    // A manual refresh runs inside a broadcast, which has to finish in about ten
    // seconds; two four-second limits keep it inside that.
    private const val TIMEOUT_MS = 4_000

    fun fetch(endpoint: String): WidgetFetchResult {
        val base = endpoint.trimEnd('/')
        val connection = runCatching { URL("$base/api/v1/widget/summary").openConnection() as HttpURLConnection }
            .getOrElse { return WidgetFetchResult.Failed }
        return try {
            connection.connectTimeout = TIMEOUT_MS
            connection.readTimeout = TIMEOUT_MS
            connection.instanceFollowRedirects = false
            connection.useCaches = false
            connection.setRequestProperty("Accept", "application/json")
            applyCookie(connection, base)
            when (connection.responseCode) {
                HttpURLConnection.HTTP_OK -> WidgetFetchResult.Success(
                    WidgetSummary.parse(connection.inputStream.bufferedReader().use { it.readText() }),
                )
                HttpURLConnection.HTTP_UNAUTHORIZED -> WidgetFetchResult.SignedOut
                else -> WidgetFetchResult.Failed
            }
        } catch (error: Exception) {
            // Offline, a timeout, or a body that is not the summary. The widget
            // keeps its last numbers either way. Nothing from the response is
            // logged: it describes the person's work.
            Log.w(TAG, "Widget summary refresh failed: ${error.javaClass.simpleName}")
            WidgetFetchResult.Failed
        } finally {
            connection.disconnect()
        }
    }

    /**
     * Binds this install's FCM token to the signed-in account. Re-registering is
     * the whole point: a token outliving its account keeps receiving that
     * account's signals, so the server rebinds on every PUT (AND-150).
     */
    fun registerDeviceToken(endpoint: String, token: String): DeviceRegistration =
        write("/api/v1/widget/device", "PUT", endpoint, """{"token":${quote(token)}}""")

    /** The notification's "no action needed": the revision guards against dismissing a newer change. */
    fun dismissAttention(endpoint: String, sessionId: String, revision: String): Boolean =
        write(
            "/api/v1/agent-sessions/${Uri.encode(sessionId)}/attention/dismiss",
            "POST",
            endpoint,
            """{"revision":${quote(revision)}}""",
        ) == DeviceRegistration.DONE

    private fun write(path: String, method: String, endpoint: String, body: String): DeviceRegistration {
        val base = endpoint.trimEnd('/')
        val connection = runCatching { URL("$base$path").openConnection() as HttpURLConnection }
            .getOrElse { return DeviceRegistration.FAILED }
        return try {
            connection.connectTimeout = TIMEOUT_MS
            connection.readTimeout = TIMEOUT_MS
            connection.instanceFollowRedirects = false
            connection.useCaches = false
            connection.requestMethod = method
            connection.doOutput = true
            connection.setRequestProperty("Accept", "application/json")
            connection.setRequestProperty("Content-Type", "application/json")
            applyCookie(connection, base)
            connection.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
            when (connection.responseCode) {
                HttpURLConnection.HTTP_OK, HttpURLConnection.HTTP_NO_CONTENT -> DeviceRegistration.DONE
                HttpURLConnection.HTTP_UNAUTHORIZED -> DeviceRegistration.NOT_SIGNED_IN
                else -> DeviceRegistration.FAILED
            }
        } catch (error: Exception) {
            Log.w(TAG, "Widget device call failed: ${error.javaClass.simpleName}")
            DeviceRegistration.FAILED
        } finally {
            connection.disconnect()
        }
    }

    private fun applyCookie(connection: HttpURLConnection, base: String) {
        // No cookie is not taken as signed out on the spot: the server is the one
        // that knows, and asking it keeps "unreachable" from reading as "signed out".
        val cookie = runCatching { CookieManager.getInstance().getCookie(base) }.getOrNull()
        if (!cookie.isNullOrBlank()) connection.setRequestProperty("Cookie", cookie)
    }

    private fun quote(value: String): String =
        JSONObject().put("v", value).toString().removePrefix("{\"v\":").removeSuffix("}")

    private const val TAG = "MissionGoWidget"
}
