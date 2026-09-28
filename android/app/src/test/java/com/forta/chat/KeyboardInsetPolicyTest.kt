package com.forta.chat

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * Regression: after fb0e6650 removed @capacitor-community/safe-area, nothing lifted the
 * edge-to-edge WebView above the soft keyboard, and the keyboard covered the composer
 * (Samsung, 2026-09-28: input at 748–792 of 800 CSS px with a 306 px keyboard).
 */
class KeyboardInsetPolicyTest {

    @Test
    fun `content ends above the keyboard while it is shown`() {
        assertEquals(918, KeyboardInsetPolicy.contentBottomPadding(imeVisible = true, imeBottomPx = 918))
    }

    @Test
    fun `no padding once the keyboard is hidden`() {
        assertEquals(0, KeyboardInsetPolicy.contentBottomPadding(imeVisible = false, imeBottomPx = 918))
        assertEquals(0, KeyboardInsetPolicy.contentBottomPadding(imeVisible = false, imeBottomPx = 0))
    }

    @Test
    fun `mainActivity pads the content view from the insets listener`() {
        val source = listOf(
            "src/main/java/com/forta/chat/MainActivity.kt",
            "android/app/src/main/java/com/forta/chat/MainActivity.kt",
        ).map { File(it) }.first { it.exists() }.readText()
        val listener = source.substring(
            source.indexOf("ViewCompat.setOnApplyWindowInsetsListener(rootView)"),
            source.indexOf("WindowInsetsCompat.CONSUMED"),
        )
        assertTrue(listener.contains("KeyboardInsetPolicy.contentBottomPadding("))
        assertTrue(listener.contains("view.setPadding("))
    }
}
