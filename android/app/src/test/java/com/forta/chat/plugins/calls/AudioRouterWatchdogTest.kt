package com.forta.chat.plugins.calls

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Regression tests for Session 54 — AudioManager mode orphan watchdog.
 *
 * The watchdog must restore MODE_NORMAL when the call is dead (process killed
 * by OEM between hangup and `stopAudioRouting`) but AudioRouter still thinks
 * it owns audio. Logic is exposed as a pure predicate so it can be covered
 * in a JVM unit test without Robolectric / mockk.
 */
class AudioRouterWatchdogTest {

    @Test
    fun deadCall_andActiveRouter_triggersForceStop() {
        assertTrue(
            "router active + call dead → must force stop",
            AudioRouter.shouldForceStopForWatchdog(callAlive = false, isRouterActive = true),
        )
    }

    @Test
    fun aliveCall_doesNotTriggerForceStop() {
        assertFalse(
            "call still alive → watchdog should rearm, not stop",
            AudioRouter.shouldForceStopForWatchdog(callAlive = true, isRouterActive = true),
        )
    }

    @Test
    fun inactiveRouter_isNoOp_evenIfCallDead() {
        assertFalse(
            "router already stopped → watchdog is a no-op",
            AudioRouter.shouldForceStopForWatchdog(callAlive = false, isRouterActive = false),
        )
    }

    @Test
    fun inactiveRouter_aliveCall_isNoOp() {
        assertFalse(
            AudioRouter.shouldForceStopForWatchdog(callAlive = true, isRouterActive = false),
        )
    }
}
