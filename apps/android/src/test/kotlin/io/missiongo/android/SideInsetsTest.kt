package io.missiongo.android

import kotlin.test.Test
import kotlin.test.assertEquals

/**
 * The WebView's padding against the system (A8, AND-259): the bars on every
 * side, the keyboard at the bottom, and the display cutout only where it shares
 * an edge with the bars.
 */
class SideInsetsTest {
    private val none = SideInsets(0, 0, 0, 0)

    @Test
    fun keepsTheBarsAndTheKeyboardClearOnEverySide() {
        assertEquals(
            SideInsets(30, 96, 12, 48),
            webViewPadding(
                systemBars = SideInsets(30, 96, 12, 40),
                cutout = none,
                keyboardBottom = 48,
            ),
        )
    }

    @Test
    fun letsTheCutoutPushTheTopDownButNeverTheSides() {
        // An unfolded phone in landscape: the punch-hole lands on the right
        // edge. The page must reach that edge. Reserving the column here is
        // what left the blank band AND-259 reported.
        assertEquals(
            SideInsets(0, 0, 0, 0),
            webViewPadding(systemBars = none, cutout = SideInsets(0, 0, 96, 0), keyboardBottom = 0),
        )
        assertEquals(
            SideInsets(0, 0, 0, 0),
            webViewPadding(systemBars = none, cutout = SideInsets(96, 0, 0, 0), keyboardBottom = 0),
        )
    }

    @Test
    fun keepsThePageClearOfTheCutoutUnderTheStatusBarInPortrait() {
        // Portrait: the cutout is deeper than the status bar, so the larger of
        // the two is what the page has to stay below.
        assertEquals(
            SideInsets(0, 96, 0, 40),
            webViewPadding(
                systemBars = SideInsets(0, 72, 0, 40),
                cutout = SideInsets(0, 96, 0, 0),
                keyboardBottom = 0,
            ),
        )
    }
}
