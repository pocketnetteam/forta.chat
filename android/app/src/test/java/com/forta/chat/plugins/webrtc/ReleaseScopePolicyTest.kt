package com.forta.chat.plugins.webrtc

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** N1 (2026-10-08): a close for an ended call leaves what the next call created after it. */
class ReleaseScopePolicyTest {
    private val ended = 1_791_462_201_539L

    @Test
    fun theEndedCallsConnection_closes() {
        assertTrue(ReleaseScopePolicy.closes(createdAt = ended - 60_000, createdBefore = ended))
    }

    @Test
    fun aConnectionTheNextInviteBuiltAfterTheEnd_stays() {
        // Samsung run 2026-10-08: the invite's connection came 330 ms after the end.
        assertFalse(ReleaseScopePolicy.closes(createdAt = ended + 329, createdBefore = ended))
    }

    @Test
    fun withoutAMark_everythingCloses() {
        assertTrue(ReleaseScopePolicy.closes(createdAt = ended + 329, createdBefore = null))
    }

    @Test
    fun aConnectionWithoutACreationTime_closes() {
        assertTrue(ReleaseScopePolicy.closes(createdAt = null, createdBefore = ended))
    }

    @Test
    fun localMedia_goesWhenNothingIsKept() {
        assertTrue(ReleaseScopePolicy.releasesLocalMedia(keptConnections = 0, localMediaCreatedAt = ended + 5_000, createdBefore = ended))
    }

    @Test
    fun theEndedCallsTracks_goEvenWithANewerConnectionKept() {
        assertTrue(ReleaseScopePolicy.releasesLocalMedia(keptConnections = 1, localMediaCreatedAt = ended - 30_000, createdBefore = ended))
    }

    @Test
    fun tracksTheNewerCallMade_stay() {
        assertFalse(ReleaseScopePolicy.releasesLocalMedia(keptConnections = 1, localMediaCreatedAt = ended + 2_000, createdBefore = ended))
    }
}
