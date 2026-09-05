package io.missiongo.feedback.internal

import io.missiongo.feedback.FeedbackOptions
import io.missiongo.feedback.FeedbackPriority
import io.missiongo.feedback.FeedbackType
import java.nio.file.Files
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class FeedbackLaunchStoreTest {
    @Test
    fun restoresCapturedPayloadAndDraftId() {
        val directory = Files.createTempDirectory("missiongo-launch-store").toFile()
        try {
            val store = FeedbackLaunchStore(directory)
            val pending = PendingFeedback(
                options = FeedbackOptions(
                    title = "Search failed",
                    description = "Cached results disappeared.",
                    type = FeedbackType.Bug,
                    priority = FeedbackPriority.High,
                    context = mapOf("unused-after-snapshot" to "true"),
                    clientDraftId = "search-draft-0001",
                ),
                environment = FeedbackEnvironment(
                    appVersion = "1.2.0",
                    buildNumber = "42",
                    sourceRevision = "abc123",
                    osVersion = "Android 16 (API 36)",
                    deviceModel = "Example device",
                    metadata = mapOf("locale" to "zh-CN"),
                ),
                context = mapOf("screen" to "search_result"),
                logs = listOf(FeedbackLogEntry("2026-09-04T10:00:00Z", "error", "timeout")),
            )

            val id = store.put(pending)
            assertEquals(pending.copy(options = pending.options.copy(context = emptyMap())), store.get(id))

            store.setDraftId(id, "server-draft-id")
            assertEquals("server-draft-id", store.get(id)?.draftId)

            store.remove(id)
            assertNull(store.get(id))
            assertNull(store.get("../outside"))
        } finally {
            directory.deleteRecursively()
        }
    }
}
