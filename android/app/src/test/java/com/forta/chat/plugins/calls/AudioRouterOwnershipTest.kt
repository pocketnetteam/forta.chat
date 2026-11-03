package com.forta.chat.plugins.calls

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AudioRouterOwnershipTest {
    @Test
    fun stopForTheOwningCallGoesAhead() {
        assertTrue(AudioRouterOwnership.shouldStop("A", "A"))
    }

    @Test
    fun stopForAnotherCallIsDropped() {
        // C02: call A's queued stop runs after call B took the router over.
        assertFalse(AudioRouterOwnership.shouldStop("A", "B"))
    }

    @Test
    fun stopWithoutCallIdAlwaysGoesAhead() {
        assertTrue(AudioRouterOwnership.shouldStop(null, "B"))
        assertTrue(AudioRouterOwnership.shouldStop("", "B"))
    }

    @Test
    fun stopWhenNobodyOwnsTheRouterGoesAhead() {
        assertTrue(AudioRouterOwnership.shouldStop("A", null))
    }

    @Test
    fun startForANewCallTakesOwnership() {
        assertEquals("B", AudioRouterOwnership.ownerAfterStart("A", "B"))
        assertEquals("B", AudioRouterOwnership.ownerAfterStart(null, "B"))
    }

    @Test
    fun startWithoutCallIdKeepsTheOwner() {
        assertEquals("A", AudioRouterOwnership.ownerAfterStart("A", null))
    }
}
