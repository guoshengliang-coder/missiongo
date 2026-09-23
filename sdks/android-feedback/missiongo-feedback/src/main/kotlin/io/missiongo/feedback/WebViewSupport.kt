package io.missiongo.feedback

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.webkit.WebSettings
import kotlin.math.roundToInt

/**
 * What the WebView on this device can be trusted with, shared by the feedback
 * editor and the MissionGo app, which both host pages built from apps/web.
 *
 * Not part of the feedback API a host app integrates with; it is public for
 * the same reason [WebViewFilePicker] is -- the MissionGo app reuses it.
 */
public object WebViewSupport {
    /**
     * The oldest Chromium the pages are built for. Keep in step with
     * `build.target` in apps/web/vite.config.ts (`chrome90`).
     *
     * minSdk is 23, and the WebView is updated separately from the system, so
     * the two say nothing about each other: a phone without Google services, or
     * one whose WebView was never updated, can be far behind. Below the target
     * the page may not parse at all, and the person saw a blank screen or a
     * generic "could not connect" with no way to know why (C5 in
     * docs/ui-ue-review-2026-09.md).
     */
    public const val MIN_CHROMIUM_MAJOR: Int = 90

    private const val WEBVIEW_PACKAGE = "com.google.android.webview"

    /** The Chromium major version in a WebView user agent, or null when it names none. */
    public fun chromiumMajor(userAgent: String): Int? =
        Regex("""\bChrome/(\d+)\.""").find(userAgent)?.groupValues?.get(1)?.toIntOrNull()

    /**
     * The installed WebView's Chromium major version, or null when it cannot be
     * told. Read from the default user agent because that works on every API
     * level this SDK supports; the package API needs 26.
     */
    public fun installedChromiumMajor(context: Context): Int? =
        runCatching { chromiumMajor(WebSettings.getDefaultUserAgent(context)) }.getOrNull()

    /**
     * False only when the version is known and too old. An unreadable version is
     * let through: refusing to open on a guess would lock out working devices.
     */
    public fun isSupported(context: Context): Boolean =
        installedChromiumMajor(context)?.let { it >= MIN_CHROMIUM_MAJOR } ?: true

    /** Open the store page for Android System WebView, falling back to the web. */
    public fun openUpdate(context: Context) {
        val store = Intent(Intent.ACTION_VIEW, Uri.parse("market://details?id=$WEBVIEW_PACKAGE"))
        val web = Intent(Intent.ACTION_VIEW, Uri.parse("https://play.google.com/store/apps/details?id=$WEBVIEW_PACKAGE"))
        try {
            context.startActivity(store)
        } catch (_: ActivityNotFoundException) {
            runCatching { context.startActivity(web) }
        }
    }

    /**
     * The WebView text zoom for the system font size. A WebView ignores the
     * system setting on its own, so someone who had enlarged text everywhere
     * else found the pages at the default size, and pinch-zoom is off.
     */
    public fun textZoomFor(fontScale: Float): Int =
        if (fontScale.isFinite() && fontScale > 0f) (fontScale * 100).roundToInt() else 100
}
