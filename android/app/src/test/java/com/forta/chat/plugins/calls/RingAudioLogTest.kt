package com.forta.chat.plugins.calls

import org.junit.Assert.assertEquals
import org.junit.Test

class RingAudioLogTest {

    private fun ring(callId: String, atMs: Long) = RingAudioLog.Record(
        atMs = atMs,
        callId = callId,
        modeAtArm = "MODE_IN_COMMUNICATION",
        modeReset = true,
        telecom = "none",
    )

    @Test
    fun keepsTheLastRingsOldestFirst() {
        val log = RingAudioLog(maxRecords = 2)
        log.armed(ring("a", 1))
        log.armed(ring("b", 2))
        log.armed(ring("c", 3))
        assertEquals(listOf("b", "c"), log.snapshot().map { it.callId })
    }

    @Test
    fun theSampleLandsOnTheRingItWasTakenFor() {
        val log = RingAudioLog()
        log.armed(ring("a", 1))
        // The same call rang again (a second ringer instance): only that arm gets the sample.
        log.armed(ring("a", 5))
        log.sampled("a", 5, "MODE_NORMAL", "RINGING")
        assertEquals(listOf("", "MODE_NORMAL"), log.snapshot().map { it.modeInRing })
        // The push armed the ringer before Telecom made the connection.
        assertEquals(listOf("none", "RINGING"), log.snapshot().map { it.telecom })
    }

    @Test
    fun aSampleForARingNoLongerKeptIsDropped() {
        val log = RingAudioLog(maxRecords = 1)
        log.armed(ring("a", 1))
        log.armed(ring("b", 2))
        log.sampled("a", 1, "MODE_RINGTONE", "RINGING")
        assertEquals(listOf(""), log.snapshot().map { it.modeInRing })
    }

    @Test
    fun theWireMapCarriesEveryField() {
        val wire = ring("a", 7).copy(modeInRing = "MODE_RINGTONE").toWireMap()
        assertEquals(
            mapOf(
                "atMs" to 7L,
                "callId" to "a",
                "modeAtArm" to "MODE_IN_COMMUNICATION",
                "modeReset" to true,
                "telecom" to "none",
                "modeInRing" to "MODE_RINGTONE",
            ),
            wire,
        )
    }
}
