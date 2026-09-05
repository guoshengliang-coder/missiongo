package io.missiongo.feedback.internal

import io.missiongo.feedback.FeedbackOptions
import io.missiongo.feedback.MissionGoException
import io.missiongo.feedback.MissionGoOptions
import kotlinx.coroutines.delay
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL

internal class FeedbackApiClient(private val options: MissionGoOptions) {
    suspend fun upsertDraft(
        options: FeedbackOptions,
        environment: FeedbackEnvironment,
        context: Map<String, String>,
        logs: List<FeedbackLogEntry>,
    ): DraftResponse = request("/api/v1/sdk/drafts", draftBody(options, environment, context, logs))

    suspend fun prepareEditor(
        options: FeedbackOptions,
        environment: FeedbackEnvironment,
        context: Map<String, String>,
        logs: List<FeedbackLogEntry>,
    ): PreparedEditorResponse {
        val json = requestJson("/api/v1/sdk/editor-session", draftBody(options, environment, context, logs))
        return PreparedEditorResponse(
            draft = parseDraftResponse(json.toString()),
            sessionToken = json.optString("sessionToken").takeIf(String::isNotBlank),
        )
    }

    suspend fun finalizeDraft(draftId: String): DraftResponse {
        require(draftId.isNotBlank()) { "draftId cannot be blank." }
        return request("/api/v1/sdk/drafts/${encodePathSegment(draftId)}/finalize", JSONObject())
    }

    suspend fun getDraft(draftId: String): DraftResponse {
        require(draftId.isNotBlank()) { "draftId cannot be blank." }
        return parseDraftResponse(
            requestJson("/api/v1/sdk/drafts/${encodePathSegment(draftId)}", null, "GET").toString(),
        )
    }

    suspend fun createWebSession(draftId: String): FeedbackWebSession {
        require(draftId.isNotBlank()) { "draftId cannot be blank." }
        val json = requestJson("/api/v1/sdk/drafts/${encodePathSegment(draftId)}/web-session", JSONObject())
        return FeedbackWebSession(json.getString("token"), json.getString("expiresAt"))
    }

    private suspend fun request(path: String, body: JSONObject): DraftResponse =
        parseDraftResponse(requestJson(path, body).toString())

    private suspend fun requestJson(path: String, body: JSONObject?, method: String = "POST"): JSONObject {
        var lastFailure: MissionGoException? = null
        repeat(options.maxNetworkRetries + 1) { attempt ->
            try {
                return requestJsonOnce(path, body, method)
            } catch (failure: RetryableRequestFailure) {
                lastFailure = failure.failure
                if (attempt == options.maxNetworkRetries) throw failure.failure
                delay(options.initialRetryDelayMillis * (1L shl attempt))
            }
        }
        throw lastFailure ?: MissionGoException("network_error", "Could not reach the MissionGo server.")
    }

    private suspend fun requestJsonOnce(path: String, body: JSONObject?, method: String): JSONObject = withContext(Dispatchers.IO) {
        val connection = (URL(options.endpoint + path).openConnection() as HttpURLConnection).apply {
            requestMethod = method
            connectTimeout = options.connectTimeoutMillis
            readTimeout = options.readTimeoutMillis
            doOutput = body != null
            instanceFollowRedirects = false
            setRequestProperty("Accept", "application/json")
            if (body != null) setRequestProperty("Content-Type", "application/json; charset=utf-8")
            setRequestProperty("Authorization", "Bearer ${options.sdkToken}")
        }
        try {
            if (body != null) {
                val bytes = body.toString().toByteArray(Charsets.UTF_8)
                connection.setFixedLengthStreamingMode(bytes.size)
                connection.outputStream.use { it.write(bytes) }
            }
            val status = connection.responseCode
            val responseBody = (if (status in 200..299) connection.inputStream else connection.errorStream)
                ?.bufferedReader(Charsets.UTF_8)
                ?.use { it.readText() }
                .orEmpty()
            if (status !in 200..299) {
                val failure = responseException(status, responseBody)
                if (isRetryableHttpStatus(status)) throw RetryableRequestFailure(failure)
                throw failure
            }
            JSONObject(responseBody)
        } catch (error: RetryableRequestFailure) {
            throw error
        } catch (error: MissionGoException) {
            throw error
        } catch (error: IOException) {
            throw RetryableRequestFailure(
                MissionGoException("network_error", "Could not reach the MissionGo server.", error, retryable = true),
            )
        } catch (error: Exception) {
            throw MissionGoException("invalid_server_response", "MissionGo returned an invalid response.", error)
        } finally {
            connection.disconnect()
        }
    }

    private fun parseDraftResponse(body: String): DraftResponse {
        val json = JSONObject(body)
        return DraftResponse(
            id = json.getString("id"),
            clientDraftId = json.getString("clientDraftId"),
            expiresAt = json.getString("expiresAt"),
            itemKey = json.optString("itemKey").takeIf(String::isNotBlank),
        )
    }

    private fun draftBody(
        options: FeedbackOptions,
        environment: FeedbackEnvironment,
        context: Map<String, String>,
        logs: List<FeedbackLogEntry>,
    ): JSONObject = JSONObject().apply {
        put("clientDraftId", options.clientDraftId)
        put("type", options.type.wireValue)
        put("priority", options.priority.wireValue)
        put("title", options.title)
        put("description", options.description)
        put("environment", environment.toJson())
        put("context", JSONObject(context))
        put("logs", JSONArray().apply { logs.forEach { put(it.toJson()) } })
    }

    private fun responseException(status: Int, body: String): MissionGoException {
        val problem = runCatching { JSONObject(body) }.getOrNull()
        val code = problem?.optString("code")?.takeIf(String::isNotBlank) ?: "http_$status"
        val message = problem?.optString("title")?.takeIf(String::isNotBlank)
            ?: "MissionGo request failed with HTTP $status."
        return MissionGoException(code, message, retryable = isRetryableHttpStatus(status))
    }
}

private class RetryableRequestFailure(val failure: MissionGoException) : Exception(failure)

internal fun isRetryableHttpStatus(status: Int): Boolean = status == 408 || status == 429 || status in 500..599

private fun FeedbackEnvironment.toJson(): JSONObject = JSONObject().apply {
    put("platform", "android")
    appVersion?.let { put("appVersion", it) }
    buildNumber?.let { put("buildNumber", it) }
    sourceRevision?.let { put("sourceRevision", it) }
    put("osVersion", osVersion)
    put("deviceModel", deviceModel)
    put("metadata", JSONObject(metadata))
}

private fun FeedbackLogEntry.toJson(): JSONObject = JSONObject().apply {
    put("timestamp", timestamp)
    put("level", level)
    put("message", message)
    if (attributes.isNotEmpty()) put("attributes", JSONObject(attributes))
}

private fun encodePathSegment(value: String): String =
    java.net.URLEncoder.encode(value, Charsets.UTF_8.name()).replace("+", "%20")
