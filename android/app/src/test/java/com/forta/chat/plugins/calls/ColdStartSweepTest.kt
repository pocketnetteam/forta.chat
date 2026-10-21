package com.forta.chat.plugins.calls

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * Regression: CallPlugin.load() runs for every new bridge, and its COLD_START
 * sweep stops the ringer unconditionally. Opening the app while a push call
 * rang in a process that outlived its activity silenced the ring.
 */
class ColdStartSweepTest {

    @Test
    fun onlyTheFirstLoadInAProcessIsAColdStart() {
        ColdStartSweep.resetForTest()
        assertTrue(ColdStartSweep.firstInProcess())
        assertFalse(ColdStartSweep.firstInProcess())
        assertFalse(ColdStartSweep.firstInProcess())
        ColdStartSweep.resetForTest()
    }

    @Test
    fun loadGatesTheSweepOnTheFirstLoad() {
        val source = listOf(
            "src/main/java/com/forta/chat/plugins/calls/CallPlugin.kt",
            "android/app/src/main/java/com/forta/chat/plugins/calls/CallPlugin.kt",
        ).map { File(it) }.first { it.exists() }.readText()
        val start = source.indexOf("override fun load()")
        val sweep = source.indexOf("Reason.COLD_START", start)
        val gate = source.indexOf("ColdStartSweep.firstInProcess()", start)
        assertTrue(gate in start until sweep)
    }
}
