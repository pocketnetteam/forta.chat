package com.forta.chat

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.io.File

/**
 * Regression: `am start -n com.forta.chat/.MainActivity --ez push_call_accept true` on a
 * PIN-locked Samsung put the chat list over the keyguard, and it stayed there after the
 * screen was locked and woken again (2026-10-04). Only an Accept tap in this process may
 * lift the keyguard, once, and the lift ends when the window leaves the screen.
 */
class KeyguardLiftGateTest {

    @Before
    fun reset() {
        KeyguardLiftGate.consume(0L)
    }

    @Test
    fun `an intent extra alone does not lift the keyguard`() {
        assertFalse(KeyguardLiftGate.consume(1_000L))
    }

    @Test
    fun `a fresh Accept tap lifts it exactly once`() {
        KeyguardLiftGate.arm(10_000L)
        assertTrue(KeyguardLiftGate.consume(11_000L))
        assertFalse("a replayed intent must not lift it again", KeyguardLiftGate.consume(11_500L))
    }

    @Test
    fun `an old arm does not count`() {
        KeyguardLiftGate.arm(10_000L)
        assertFalse(KeyguardLiftGate.consume(10_000L + KeyguardLiftGate.WINDOW_MS + 1))
    }

    private val mainActivity: String by lazy {
        listOf(
            "src/main/java/com/forta/chat/MainActivity.kt",
            "android/app/src/main/java/com/forta/chat/MainActivity.kt",
        ).map { File(it) }.first { it.exists() }.readText()
    }

    @Test
    fun `mainActivity consults the gate and restores the keyguard on stop`() {
        val lift = mainActivity.substring(
            mainActivity.indexOf("private fun liftKeyguardForCallAccept"),
            mainActivity.indexOf("override fun onNewIntent"),
        )
        assertTrue(lift.contains("KeyguardLiftGate.consume("))
        assertTrue(lift.indexOf("KeyguardLiftGate.consume(") < lift.indexOf("setShowWhenLocked(true)"))
        val onStop = mainActivity.substring(mainActivity.indexOf("override fun onStop()"))
        assertTrue(onStop.substring(0, onStop.indexOf("}")).contains("restoreKeyguard()"))
        assertTrue(mainActivity.contains("setShowWhenLocked(false)"))
    }
}
