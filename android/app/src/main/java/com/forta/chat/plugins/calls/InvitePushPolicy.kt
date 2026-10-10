package com.forta.chat.plugins.calls

/**
 * What became of a call invite push, and what the user sees for it
 * (docs/plans/2026-10-10-missed-push-calls.md).
 *
 * A tester's phone, app closed, missed four calls in a row with nothing on
 * screen. One of the ways that happens inside the app: an invite that reached
 * the phone after its lifetime (Doze, a lowered FCM priority, a slow network)
 * is not rung — the call is over (S4) — and was dropped without a trace.
 * It now leaves an ordinary "missed call" notice. Every outcome is also kept
 * in the invite history of the bug report, so "the push came, the ringer did
 * not, because X" can be read from a report.
 *
 * Pure Kotlin so it is unit-testable without an emulator.
 */
object InvitePushPolicy {

    enum class Outcome(val wire: String) {
        /** The ringer came up. */
        RANG("rang"),
        /** Older than the invite lifetime: not rung, a missed-call notice instead. */
        STALE("stale"),
        /** No session on this device (PushSessionPolicy). */
        SIGNED_OUT("signed-out"),
        /** The user turned incoming calls off (#1388). */
        INCOMING_CALLS_OFF("incoming-calls-off"),
        /** A conversation holds the Telecom slot; the caller gets busy. */
        ESTABLISHED("established"),
        /** Another call rings on the incoming screen (SecondRingPolicy). */
        SECOND_RING("second-ring"),
    }

    /**
     * Whether this invite push leaves a "missed call" notice: only a stale
     * invite does, only with a room to open, and once per call — the caller
     * resends the invite, and a flushed backlog brings the copies together.
     * Never for [liveCallId], the call this device holds in Telecom: a late
     * copy of its invite does not make it missed.
     */
    fun showsMissedCallNotice(
        outcome: Outcome,
        roomId: String?,
        callId: String?,
        lastNoticedCallId: String?,
        liveCallId: String? = null,
    ): Boolean {
        if (outcome != Outcome.STALE) return false
        if (roomId.isNullOrEmpty()) return false
        if (!callId.isNullOrEmpty() && callId == liveCallId) return false
        return callId.isNullOrEmpty() || callId != lastNoticedCallId
    }

    /**
     * Whether a later push withdraws the missed-call notice: only the caller's
     * select_answer naming the noticed call, which means another device of the
     * user answered it. A hangup or reject leaves the call missed.
     */
    fun retractsMissedCallNotice(msgType: String, endedCallId: String?, noticedCallId: String?): Boolean =
        msgType == "m.call.select_answer" && !endedCallId.isNullOrEmpty() && endedCallId == noticedCallId

    /** `RemoteMessage.priority` / `originalPriority` as a word for logs and reports. */
    fun priorityName(priority: Int?): String = when (priority) {
        PRIORITY_HIGH -> "high"
        PRIORITY_NORMAL -> "normal"
        else -> "unknown"
    }

    /** Values of `RemoteMessage.PRIORITY_HIGH` / `PRIORITY_NORMAL`, kept here so tests need no Firebase. */
    const val PRIORITY_HIGH = 1
    const val PRIORITY_NORMAL = 2
}
