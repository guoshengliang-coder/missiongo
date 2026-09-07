package io.missiongo.feedback

import io.missiongo.feedback.internal.utcTimestamp
import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * The two things a host needs to send a complete diagnostic history: its own timestamps, and its
 * own files. Both exist because the first report filed through this SDK arrived with 500 log
 * lines carrying 16 distinct timestamps -- the SDK stamped them all at the moment the host handed
 * its buffer over -- and with no way to send the rolling log file that had the real history.
 */
class FeedbackOptionsTest {
    @Test
    fun aHostCanSayWhenALineWasWritten() {
        val whenItHappened = 1_757_000_000_000L
        assertEquals("2025-09-04T15:33:20.000Z", utcTimestamp(whenItHappened))
        // Distinct moments stay distinct, which is the whole point: a buffer handed over in one
        // call must not collapse onto a single instant.
        assertTrue(utcTimestamp(whenItHappened) != utcTimestamp(whenItHappened + 60_000))
    }

    @Test
    fun attachmentsDefaultToNone() {
        assertEquals(emptyList(), FeedbackOptions().attachments)
    }

    @Test
    fun attachmentsAreCarriedOnTheOptions() {
        val log = File.createTempFile("missiongo-test", ".log").apply { writeText("line\n"); deleteOnExit() }
        val options = FeedbackOptions(title = "Sync failed", attachments = listOf(log))
        assertEquals(listOf(log), options.attachments)
        assertEquals(1, options.attachments.size)
    }
}
