package io.missiongo.feedback.internal

import kotlin.test.Test
import kotlin.test.assertEquals

class ContextStoreTest {
    @Test
    fun snapshotsNamespacedContextAndKeepsNewestLogsWithinBounds() {
        val store = ContextStore(DiagnosticNormalizer())
        store.setCurrentScreen("search_result")
        store.setContext("search", mapOf("resultCount" to "3"))
        repeat(3) { index ->
            store.addLog(
                FeedbackLogEntry("2026-09-04T10:00:0$index.000Z", "info", "event-$index"),
                maxEntries = 2,
                maxBytes = 4 * 1024,
            )
        }

        val snapshot = store.snapshot(mapOf("filter" to "recent"))

        assertEquals("search_result", snapshot.context["screen"])
        assertEquals("3", snapshot.context["search.resultCount"])
        assertEquals("recent", snapshot.context["filter"])
        assertEquals(listOf("event-1", "event-2"), snapshot.logs.map { it.message })
    }
}
