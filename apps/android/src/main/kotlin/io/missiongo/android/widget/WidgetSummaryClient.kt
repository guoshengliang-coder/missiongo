package io.missiongo.android.widget

import android.util.Log
import android.webkit.CookieManager
import java.net.HttpURLConnection
import java.net.URL

internal sealed interface WidgetFetchResult {
    data class Success(val summary: WidgetSummary) : WidgetFetchResult
    /** The server does not know who is asking: the page's sign-in has lapsed or never happened. */
    data object SignedOut : WidgetFetchResult
    data object Failed : WidgetFetchResult
}

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
        // No cookie is not taken as signed out on the spot: the server is the one
        // that knows, and asking it keeps "unreachable" from reading as "signed out".
        val cookie = runCatching { CookieManager.getInstance().getCookie(base) }.getOrNull()
        val connection = runCatching { URL("$base/api/v1/widget/summary").openConnection() as HttpURLConnection }
            .getOrElse { return WidgetFetchResult.Failed }
        return try {
            connection.connectTimeout = TIMEOUT_MS
            connection.readTimeout = TIMEOUT_MS
            connection.instanceFollowRedirects = false
            connection.useCaches = false
            connection.setRequestProperty("Accept", "application/json")
            if (!cookie.isNullOrBlank()) connection.setRequestProperty("Cookie", cookie)
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

    private const val TAG = "MissionGoWidget"
}
