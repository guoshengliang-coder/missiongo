package io.missiongo.feedback.internal

internal class ContextStore(private val normalizer: DiagnosticNormalizer) {
    private val lock = Any()
    private val contexts = linkedMapOf<String, Map<String, String>>()
    private val logs = ArrayDeque<FeedbackLogEntry>()
    private var logBytes: Int = 0
    private var currentScreen: String? = null

    fun setCurrentScreen(name: String?) = synchronized(lock) {
        currentScreen = name?.trim()?.takeIf(String::isNotEmpty)?.let(normalizer::normalizeText)?.take(200)
    }

    fun setContext(namespace: String, values: Map<String, String>) = synchronized(lock) {
        val normalizedNamespace = namespace.trim()
        require(normalizedNamespace.matches(Regex("^[A-Za-z][A-Za-z0-9_.-]{0,49}$"))) {
            "Context namespace must contain 1-50 safe characters and start with a letter."
        }
        require(values.size <= 20) { "A context namespace can contain at most 20 entries." }
        contexts[normalizedNamespace] = normalizer.normalizeMap(values)
    }

    fun clearContext(namespace: String) = synchronized(lock) {
        contexts.remove(namespace.trim())
    }

    fun addLog(entry: FeedbackLogEntry, maxEntries: Int, maxBytes: Int) = synchronized(lock) {
        val normalized = entry.copy(
            message = normalizer.normalizeText(entry.message).take(4_000),
            attributes = normalizer.normalizeMap(entry.attributes).entries.take(20).associate { it.toPair() },
        )
        if (normalized.message.isBlank()) return@synchronized
        val bytes = normalized.estimatedBytes()
        if (bytes > maxBytes) return@synchronized
        logs.addLast(normalized)
        logBytes += bytes
        while (logs.size > maxEntries || logBytes > maxBytes) {
            logBytes -= logs.removeFirst().estimatedBytes()
        }
    }

    fun snapshot(oneShotContext: Map<String, String>): FeedbackSnapshot = synchronized(lock) {
        val flattened = linkedMapOf<String, String>()
        currentScreen?.let { flattened["screen"] = it }
        for ((namespace, values) in contexts) {
            for ((key, value) in values) flattened["$namespace.$key"] = value
        }
        for ((key, value) in normalizer.normalizeMap(oneShotContext)) flattened[key] = value
        FeedbackSnapshot(flattened.entries.toList().takeLast(50).associate { it.toPair() }, logs.toList())
    }
}

private fun FeedbackLogEntry.estimatedBytes(): Int =
    timestamp.length + level.length + message.length + attributes.entries.sumOf { it.key.length + it.value.length } + 64
