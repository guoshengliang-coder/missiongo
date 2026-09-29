package io.missiongo.android

import androidx.core.graphics.Insets

/** The four insets of one system element, in the window's own coordinates. */
internal data class SideInsets(val left: Int, val top: Int, val right: Int, val bottom: Int)

internal fun Insets.toSideInsets(): SideInsets = SideInsets(left, top, right, bottom)

/**
 * What the WebView has to keep clear of the system (A8, AND-259).
 *
 * The bars are honoured on all four sides, and the keyboard at the bottom,
 * because edge-to-edge no longer reserves it. The cutout is honoured vertically
 * but never sideways: portrait puts the punch-hole under the status bar, so the
 * larger of the two top insets is what clears it, while landscape puts the same
 * hole on the left or right edge. Reserving that whole column there pushed the
 * page in from one side and left a blank band down it -- visible on the list and
 * the status row, which reach that edge on every other device -- and nothing in
 * the page can compensate, because the WebView reports no safe-area insets.
 */
internal fun webViewPadding(systemBars: SideInsets, cutout: SideInsets, keyboardBottom: Int): SideInsets =
    SideInsets(
        left = systemBars.left,
        top = maxOf(systemBars.top, cutout.top),
        right = systemBars.right,
        bottom = maxOf(systemBars.bottom, cutout.bottom, keyboardBottom),
    )
