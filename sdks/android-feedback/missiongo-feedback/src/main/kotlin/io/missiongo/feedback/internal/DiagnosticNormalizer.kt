package io.missiongo.feedback.internal

/** Keeps internal diagnostic content unchanged while applying storage length bounds. */
internal class DiagnosticNormalizer {
    fun normalizeMap(values: Map<String, String>): Map<String, String> = values.entries.associate { (key, value) ->
        key.take(100) to value.take(2_000)
    }

    fun normalizeText(value: String): String = value
}
