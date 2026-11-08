package com.forta.chat.plugins.calls

import java.util.concurrent.atomic.AtomicBoolean

/**
 * Whether this is the first [CallPlugin.load] in the process: the only one
 * that is a cold start. Every later load is a new bridge in a process whose
 * calls, ringer and audio routing are live and still owned by it.
 */
object ColdStartSweep {
    private val done = AtomicBoolean(false)

    fun firstInProcess(): Boolean = done.compareAndSet(false, true)

    /** Tests only. */
    internal fun resetForTest() = done.set(false)
}
