package com.forta.chat.plugins.calls

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/**
 * Regression coverage for the WEE-31 callee crash-guard. The two-mode
 * helper (rethrow vs swallow) replaces what used to be raw try/catch
 * blocks scattered across IncomingCallActivity / CallConnectionService /
 * CallForegroundService — failures there used to process-kill the callee
 * "наглухо" on mobile→mobile incoming calls because the throw bubbled
 * into a Telecom IPC frame or an FGS boundary.
 *
 * Pure JVM tests — no Android dependencies, runs under
 * `./gradlew testDebugUnitTest`.
 */
class CallCrashGuardTest {

    @Test
    fun `marker exposes the failing step name for logcat grep`() {
        val text = CallCrashGuard.marker("setContentView")
        assertTrue("marker must contain step name", text.contains("setContentView"))
        assertTrue(
            "marker must keep stable [callee-crash-guard] prefix",
            text.contains("[callee-crash-guard]"),
        )
    }

    @Test
    fun `safeStep returns block result on success`() {
        var failureCalled = false
        val result = CallCrashGuard.safeStep(
            step = "ok",
            onFailure = { _, _ -> failureCalled = true },
            block = { 42 },
        )
        assertEquals(42, result)
        assertTrue("onFailure must not fire on success", !failureCalled)
    }

    @Test
    fun `safeStep rethrows after logging the step`() {
        val boom = IllegalStateException("boom")
        var loggedStep: String? = null
        var loggedError: Throwable? = null

        try {
            CallCrashGuard.safeStep<Unit>(
                step = "setLockScreenFlags",
                onFailure = { step, error ->
                    loggedStep = step
                    loggedError = error
                },
                block = { throw boom },
            )
            fail("safeStep must rethrow so the outer activity catch can run finish() (WEE-31)")
        } catch (t: Throwable) {
            assertSame("must rethrow the exact same throwable, not wrap it", boom, t)
        }

        assertEquals("setLockScreenFlags", loggedStep)
        assertSame(boom, loggedError)
    }

    @Test
    fun `safeStep also captures Error subclasses (UnsatisfiedLinkError on ARMv7)`() {
        // H3 hypothesis: NativeWebRTCManager.initialize throws
        // UnsatisfiedLinkError, which is an Error, not an Exception. The
        // guard must catch it so the failing step is still surfaced and
        // the outer activity can finish gracefully instead of letting the
        // JVM process die.
        val link = UnsatisfiedLinkError("libwebrtc.so")
        var loggedStep: String? = null

        try {
            CallCrashGuard.safeStep<Unit>(
                step = "PeerConnectionFactory.initialize",
                onFailure = { step, _ -> loggedStep = step },
                block = { throw link },
            )
            fail("UnsatisfiedLinkError must propagate")
        } catch (e: UnsatisfiedLinkError) {
            assertSame(link, e)
        }
        assertEquals("PeerConnectionFactory.initialize", loggedStep)
    }

    @Test
    fun `tryStep returns block result on success and never invokes onFailure`() {
        var failureCalled = false
        val result = CallCrashGuard.tryStep(
            step = "dismissPushFsi",
            fallback = "fallback-value",
            onFailure = { _, _ -> failureCalled = true },
            block = { "ok" },
        )
        assertEquals("ok", result)
        assertTrue("onFailure must not fire on success", !failureCalled)
    }

    @Test
    fun `tryStep returns fallback and logs step on failure`() {
        var loggedStep: String? = null
        var loggedError: Throwable? = null

        val result = CallCrashGuard.tryStep(
            step = "startRingtone",
            fallback = -1,
            onFailure = { step, error ->
                loggedStep = step
                loggedError = error
            },
            block = { throw RuntimeException("ringer broke") },
        )

        assertEquals(-1, result)
        assertEquals("startRingtone", loggedStep)
        assertNotNull(loggedError)
        assertEquals("ringer broke", loggedError!!.message)
    }

    @Test
    fun `tryStep swallows Error subclasses too`() {
        // Defence in depth: e.g. NoClassDefFoundError on a vendor build
        // that strips a class from R8 dead-code analysis. Non-critical
        // decorations should never crash the call surface.
        val result = CallCrashGuard.tryStep(
            step = "startVibration",
            fallback = Unit,
            onFailure = { _, _ -> },
            block = { throw NoClassDefFoundError("android.os.VibratorManager") },
        )
        assertEquals(Unit, result)
    }
}
