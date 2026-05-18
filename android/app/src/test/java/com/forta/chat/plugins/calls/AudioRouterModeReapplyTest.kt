package com.forta.chat.plugins.calls

import android.media.AudioManager
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Regression tests for WEE-16 — extended OEM mode re-apply window.
 *
 * Forta runs on aggressive Chinese OEM ROMs (MIUI / HyperOS / EMUI / HarmonyOS
 * / RealmeUI / XOS) that reset `AudioManager.mode` from `MODE_IN_COMMUNICATION`
 * back to `MODE_NORMAL` asynchronously after call accept. The original AudioRouter
 * only re-applied once after 500 ms, which catches the fast reset window but
 * misses slower OEM resets observed on Huawei P70 / Xiaomi 12X (reset at 1–5 s)
 * — peer hears silence because audio capture lands in media stream context
 * instead of voice-call context.
 *
 * Logic is exposed as pure predicates so they can be covered in a JVM unit
 * test without Robolectric / mockk.
 */
class AudioRouterModeReapplyTest {

    @Test
    fun activeRouter_withWrongMode_triggersReapply() {
        assertTrue(
            "active + MODE_NORMAL → must re-apply MODE_IN_COMMUNICATION",
            AudioRouter.shouldReapplyMode(
                currentMode = AudioManager.MODE_NORMAL,
                isActive = true,
            ),
        )
    }

    @Test
    fun activeRouter_withCorrectMode_doesNotReapply() {
        assertFalse(
            "active + MODE_IN_COMMUNICATION → must NOT re-apply (no-op)",
            AudioRouter.shouldReapplyMode(
                currentMode = AudioManager.MODE_IN_COMMUNICATION,
                isActive = true,
            ),
        )
    }

    @Test
    fun inactiveRouter_doesNotReapply_evenWithWrongMode() {
        assertFalse(
            "router stopped → must NOT re-apply (would clobber a fresh call)",
            AudioRouter.shouldReapplyMode(
                currentMode = AudioManager.MODE_NORMAL,
                isActive = false,
            ),
        )
    }

    @Test
    fun inactiveRouter_doesNotReapply_evenWithCorrectMode() {
        assertFalse(
            AudioRouter.shouldReapplyMode(
                currentMode = AudioManager.MODE_IN_COMMUNICATION,
                isActive = false,
            ),
        )
    }

    @Test
    fun activeRouter_inCallScreening_triggersReapply() {
        // MODE_IN_CALL (cellular) is also wrong context for VoIP — re-apply.
        assertTrue(
            AudioRouter.shouldReapplyMode(
                currentMode = AudioManager.MODE_IN_CALL,
                isActive = true,
            ),
        )
    }

    @Test
    fun reapplySchedule_coversExpectedOemResetWindows() {
        // The schedule must include the original 500 ms catch (fast OEMs) and
        // extend to ≥ 5 s to cover slow OEM resets observed on Huawei P70 /
        // Xiaomi 12X. Each delay must be strictly increasing so cancellation
        // semantics stay simple.
        val schedule = AudioRouter.modeReapplyScheduleMs()
        assertTrue("schedule must include the original 500ms tick", schedule.contains(500L))
        assertTrue(
            "schedule must extend to >= 5000ms to cover slow OEM resets",
            schedule.last() >= 5_000L,
        )
        assertTrue(
            "schedule must be strictly increasing — duplicates would post duplicate handler callbacks",
            schedule.zipWithNext().all { (a, b) -> a < b },
        )
        assertTrue(
            "schedule must have at least 3 ticks to span the OEM reset window",
            schedule.size >= 3,
        )
    }
}
