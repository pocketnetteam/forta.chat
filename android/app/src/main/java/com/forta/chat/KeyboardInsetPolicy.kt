package com.forta.chat

/**
 * How far the app content must end above the bottom of the window.
 *
 * The window is edge-to-edge (`setDecorFitsSystemWindows(false)`), so
 * `adjustResize` no longer shrinks it for the soft keyboard: the WebView stays
 * full height and the keyboard covers the composer. Until 2026-09-03 the
 * native part of `@capacitor-community/safe-area` padded the decor view by the
 * IME inset; removing that dependency (fb0e6650, thought unused because no JS
 * called it) took the lift away. MainActivity now pads the content view itself.
 *
 * The IME inset is measured from the bottom of the window, so it already
 * includes the navigation bar behind the keyboard. With the keyboard hidden
 * the nav bar stays a CSS concern (`--safe-area-inset-bottom`).
 */
object KeyboardInsetPolicy {
    fun contentBottomPadding(imeVisible: Boolean, imeBottomPx: Int): Int =
        if (imeVisible) imeBottomPx.coerceAtLeast(0) else 0
}
