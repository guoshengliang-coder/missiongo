package io.missiongo.android.widget

import org.json.JSONArray
import org.json.JSONObject

/**
 * One conversation waiting for the person, as the summary's `attentionEntries`
 * carries it (AND-150). Enough to write a notification -- the item key, what
 * kind of attention it needs, a one-line excerpt, and the revision that guards
 * a "no action needed" against racing a newer change.
 */
internal data class WidgetAttentionEntry(
    val sessionId: String,
    val itemKeys: List<String>,
    val productId: String?,
    val kind: String,
    val reason: String?,
    val excerpt: String,
    val revision: String,
)

/**
 * What `GET /api/v1/widget/summary` returns (AND-149), and what the widget
 * keeps between refreshes so a failed one can still show the last numbers.
 */
internal data class WidgetSummary(
    val attention: Int,
    val active: Int,
    val failed: Int,
    val attentionProductId: String?,
    val attentionSessionId: String?,
    val ready: Int,
    val readyProductId: String?,
    val attentionEntries: List<WidgetAttentionEntry> = emptyList(),
) {
    fun toJson(): String = JSONObject()
        .put(
            "agent",
            JSONObject()
                .put("attention", attention)
                .put("active", active)
                .put("failed", failed)
                .put("attentionProductId", attentionProductId ?: JSONObject.NULL)
                .put("attentionSessionId", attentionSessionId ?: JSONObject.NULL),
        )
        .put(
            "items",
            JSONObject()
                .put("ready", ready)
                .put("readyProductId", readyProductId ?: JSONObject.NULL),
        )
        .toString()

    companion object {
        fun parse(json: String): WidgetSummary {
            val root = JSONObject(json)
            val agent = root.getJSONObject("agent")
            val items = root.getJSONObject("items")
            return WidgetSummary(
                attention = agent.getInt("attention"),
                active = agent.getInt("active"),
                failed = agent.getInt("failed"),
                attentionProductId = agent.stringOrNull("attentionProductId"),
                attentionSessionId = agent.stringOrNull("attentionSessionId"),
                ready = items.getInt("ready"),
                readyProductId = items.stringOrNull("readyProductId"),
                attentionEntries = root.optJSONArray("attentionEntries")?.let(::parseEntries) ?: emptyList(),
            )
        }

        // The entry list is for notifications and re-derived on every fetch, so
        // the cached copy toJson writes keeps only the numbers the widget draws.
        private fun parseEntries(entries: JSONArray): List<WidgetAttentionEntry> =
            (0 until entries.length()).mapNotNull { index ->
                val entry = entries.optJSONObject(index) ?: return@mapNotNull null
                WidgetAttentionEntry(
                    sessionId = entry.optString("sessionId"),
                    itemKeys = entry.optJSONArray("itemKeys")?.let { keys ->
                        (0 until keys.length()).map { keys.optString(it) }.filter { it.isNotEmpty() }
                    } ?: emptyList(),
                    productId = entry.stringOrNull("productId"),
                    kind = entry.optString("kind").ifEmpty { "uncertain" },
                    reason = entry.stringOrNull("reason"),
                    excerpt = entry.optString("excerpt"),
                    revision = entry.optString("revision"),
                )
            }

        // optString turns a JSON null into the text "null", so ask isNull first.
        private fun JSONObject.stringOrNull(key: String): String? =
            if (isNull(key)) null else optString(key).ifEmpty { null }
    }
}
