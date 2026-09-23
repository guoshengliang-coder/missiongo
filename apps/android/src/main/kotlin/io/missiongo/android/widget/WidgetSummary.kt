package io.missiongo.android.widget

import org.json.JSONObject

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
            )
        }

        // optString turns a JSON null into the text "null", so ask isNull first.
        private fun JSONObject.stringOrNull(key: String): String? =
            if (isNull(key)) null else optString(key).ifEmpty { null }
    }
}
