package com.forta.chat.plugins.calls

/**
 * The audio state of the last incoming rings, for the bug report.
 *
 * A "rings very quietly" report needs the audio mode the ringtone played in
 * and whether Telecom held the call: the snapshot taken when the user opens
 * the report form shows neither. Each ring records the mode when the ringer
 * armed, whether it dropped a stranded VoIP mode ([RingerModePolicy]), and
 * the mode and the Telecom slot [IncomingRinger] samples a moment into the
 * ring, after Telecom had its chance to set `MODE_RINGTONE`.
 *
 * Process lifetime, like [InviteThrottleTracker]. Pure Kotlin for JVM tests.
 */
class RingAudioLog(private val maxRecords: Int = 5) {

    data class Record(
        val atMs: Long,
        val callId: String,
        /** [RingerModePolicy.modeName] when the ringer armed. */
        val modeAtArm: String,
        /** The ringer dropped a stranded `MODE_IN_COMMUNICATION` before it rang. */
        val modeReset: Boolean,
        /**
         * [RingerModePolicy.slotLabel] a moment into the ring, or when the
         * ringer armed if the ring ended first. A push can arm the ringer
         * before Telecom creates the connection (SM-A528B, 2026-10-15).
         */
        val telecom: String,
        /** The mode a moment into the ring; empty when the ring ended first. */
        val modeInRing: String = "",
    ) {
        fun toWireMap(): Map<String, Any> = mapOf(
            "atMs" to atMs,
            "callId" to callId,
            "modeAtArm" to modeAtArm,
            "modeReset" to modeReset,
            "telecom" to telecom,
            "modeInRing" to modeInRing,
        )
    }

    private val records: ArrayDeque<Record> = ArrayDeque(maxRecords)
    private val lock = Any()

    fun armed(record: Record) = synchronized(lock) {
        if (records.size >= maxRecords) records.removeFirst()
        records.addLast(record)
    }

    /** Fills the in-ring sample of the ring armed for [callId] at [atMs]. */
    fun sampled(callId: String, atMs: Long, modeInRing: String, telecom: String) = synchronized(lock) {
        val index = records.indexOfLast { it.callId == callId && it.atMs == atMs }
        if (index >= 0) records[index] = records[index].copy(modeInRing = modeInRing, telecom = telecom)
    }

    fun snapshot(): List<Record> = synchronized(lock) { records.toList() }
}
