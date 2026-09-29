package com.forta.chat.plugins.push

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Regression: after logout the Pixel kept ringing for the old account
 * (TEST3, 2026-09-24) — the FCM service showed every push without asking
 * whether anyone was signed in.
 */
class PushSessionPolicyTest {

    @Test
    fun `drops pushes after logout`() {
        assertFalse(PushSessionPolicy.shouldDeliver(PushSessionPolicy.LOGGED_OUT))
    }

    @Test
    fun `delivers pushes while signed in`() {
        assertTrue(PushSessionPolicy.shouldDeliver(PushSessionPolicy.ACTIVE))
    }

    @Test
    fun `delivers pushes on an install whose JS has not reported yet`() {
        assertTrue(PushSessionPolicy.shouldDeliver(null))
    }
}
