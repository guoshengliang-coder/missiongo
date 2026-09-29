package io.missiongo.android.update

import java.io.ByteArrayInputStream
import java.io.File
import java.security.MessageDigest
import kotlin.test.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertTrue

/**
 * The rules a download must satisfy before it may become an install prompt
 * (AND-258): the path stays on this app's own download prefix, and the bytes
 * have to hash to what the manifest promised or the file is thrown away.
 */
class ApkUpdateTest {
    private fun digestOf(bytes: ByteArray): String =
        MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { byte -> "%02x".format(byte) }

    @Test
    fun onlyTheProductsOwnApkIsDownloadable() {
        assertTrue(ApkUpdate.isAllowedDownloadPath("/downloads/missiongo-android-latest.apk"))
        // Anything that could leave the prefixed path or the app's own origin.
        assertFalse(ApkUpdate.isAllowedDownloadPath("https://evil.invalid/x.apk"))
        assertFalse(ApkUpdate.isAllowedDownloadPath("//evil.invalid/x.apk"))
        assertFalse(ApkUpdate.isAllowedDownloadPath("/downloads/../secret.apk"))
        assertFalse(ApkUpdate.isAllowedDownloadPath("/downloads/x.apk?u=https://evil.invalid"))
        assertFalse(ApkUpdate.isAllowedDownloadPath("/downloads/x.apk#fragment"))
        assertFalse(ApkUpdate.isAllowedDownloadPath("/downloads/notes.txt"))
        assertFalse(ApkUpdate.isAllowedDownloadPath(""))
    }

    @Test
    fun aDigestMustBeLowercaseHexOfTheRightLength() {
        assertTrue(ApkUpdate.isHexDigest("a".repeat(64)))
        assertTrue(ApkUpdate.isHexDigest("0123456789abcdef".repeat(4)))
        assertFalse(ApkUpdate.isHexDigest("A".repeat(64)))
        assertFalse(ApkUpdate.isHexDigest("a".repeat(63)))
        assertFalse(ApkUpdate.isHexDigest("g".repeat(64)))
    }

    @Test
    fun aVerifiedDownloadIsKeptAndItsProgressReported() {
        val payload = "apk-bytes".toByteArray()
        val destination = File.createTempFile("missiongo-update", ".apk")
        val progress = mutableListOf<Pair<Long, Long>>()
        try {
            val result = ApkUpdate.copyVerified(
                ByteArrayInputStream(payload),
                destination,
                digestOf(payload),
                payload.size.toLong(),
            ) { copied, total -> progress += copied to total }

            assertIs<ApkUpdate.Result.Success>(result)
            assertContentEquals(payload, destination.readBytes())
            assertEquals(listOf(payload.size.toLong() to payload.size.toLong()), progress)
        } finally {
            destination.delete()
        }
    }

    @Test
    fun aDownloadThatDoesNotMatchItsDigestIsDiscarded() {
        val payload = "apk-bytes".toByteArray()
        val destination = File.createTempFile("missiongo-update", ".apk")
        try {
            val result = ApkUpdate.copyVerified(ByteArrayInputStream(payload), destination, "0".repeat(64))
            assertIs<ApkUpdate.Result.DigestMismatch>(result)
            // Not left behind: the installer is only ever handed a file this kept.
            assertFalse(destination.exists())
        } finally {
            destination.delete()
        }
    }
}
