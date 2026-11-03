package com.forta.chat.plugins.calls

/**
 * Which call may stop the audio routing (calls review 2026-10-04, C02).
 *
 * JS stops routing from a queued executor, so call A's stop can run after
 * call B has already taken the router over. Without an owner check that stop
 * reset B's audio mode and route while B stayed connected.
 */
object AudioRouterOwnership {
    /**
     * A stop without a call id (legacy callers, cold-start sweeps), a stop
     * when nobody owns the router, and a stop by the owning call go ahead.
     * A stop sent for another call is dropped.
     */
    fun shouldStop(requestCallId: String?, ownerCallId: String?): Boolean =
        requestCallId.isNullOrEmpty() || ownerCallId.isNullOrEmpty() || requestCallId == ownerCallId

    /**
     * A start for a new call while the router is still active takes the
     * ownership over, so the previous call's queued stop no longer applies.
     * A start without a call id keeps the current owner.
     */
    fun ownerAfterStart(currentOwner: String?, startCallId: String?): String? =
        if (startCallId.isNullOrEmpty()) currentOwner else startCallId
}
