package io.missiongo.feedback

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class WebViewSupportTest {
    @Test
    fun readsTheChromiumMajorFromAWebViewUserAgent() {
        val current = "Mozilla/5.0 (Linux; Android 15; Pixel 9 Build/AP3A; wv) AppleWebKit/537.36 " +
            "(KHTML, like Gecko) Version/4.0 Chrome/140.0.7339.51 Mobile Safari/537.36"
        assertEquals(140, WebViewSupport.chromiumMajor(current))

        // The kind of WebView a phone without Google services can be left on.
        val stale = "Mozilla/5.0 (Linux; Android 9; VOG-AL00 Build/HUAWEIVOG-AL00; wv) AppleWebKit/537.36 " +
            "(KHTML, like Gecko) Version/4.0 Chrome/78.0.3904.108 Mobile Safari/537.36"
        assertEquals(78, WebViewSupport.chromiumMajor(stale))
    }

    @Test
    fun namesNoVersionWhenTheUserAgentHasNone() {
        assertNull(WebViewSupport.chromiumMajor("Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36"))
        assertNull(WebViewSupport.chromiumMajor(""))
    }

    @Test
    fun followsTheSystemFontSize() {
        assertEquals(100, WebViewSupport.textZoomFor(1.0f))
        assertEquals(130, WebViewSupport.textZoomFor(1.3f))
        assertEquals(85, WebViewSupport.textZoomFor(0.85f))
        assertEquals(100, WebViewSupport.textZoomFor(Float.NaN))
        assertEquals(100, WebViewSupport.textZoomFor(0f))
    }
}
