package io.missiongo.feedback.internal

import kotlin.test.Test
import kotlin.test.assertEquals

class DiagnosticNormalizerTest {
    private val normalizer = DiagnosticNormalizer()

    @Test
    fun preservesSensitiveKeysAndBearerValues() {
        val result = normalizer.normalizeMap(
            mapOf(
                "authorization" to "Bearer secret-value",
                "request.api_key" to "plain-secret",
                "message" to "failed with Bearer abc.def-123",
            ),
        )

        assertEquals("Bearer secret-value", result["authorization"])
        assertEquals("plain-secret", result["request.api_key"])
        assertEquals("failed with Bearer abc.def-123", result["message"])
    }

    @Test
    fun preservesJwtLikeValues() {
        val jwt = "eyJabcdefghijk.abcdefghijkl.abcdefghijkl"
        assertEquals("session=$jwt", normalizer.normalizeText("session=$jwt"))
    }
}
