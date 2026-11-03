package com.forta.chat

/**
 * One-shot permission for MainActivity to show over the keyguard.
 *
 * A lock-screen Accept has to put MainActivity above the keyguard so the
 * WebView keeps running and the Matrix answer completes (see
 * MainActivity.liftKeyguardForCallAccept). That used to follow from a plain
 * `push_call_accept` intent extra, and MainActivity is exported: any caller —
 * `am start --ez push_call_accept true`, another app, a stale intent replayed
 * after `recreate()` — put the chat list over a PIN-locked screen, where it
 * stayed for the activity's life (Samsung, 2026-10-04).
 *
 * IncomingCallActivity arms the gate in-process right before it starts
 * MainActivity; MainActivity consumes it once. Nothing outside the process
 * can arm it, and a replayed intent finds it consumed.
 */
object KeyguardLiftGate {
    /** An Accept tap reaches MainActivity within a second or two; anything older is not that tap. */
    const val WINDOW_MS = 15_000L

    @Volatile
    private var armedAtMs: Long = 0L

    fun arm(nowMs: Long) {
        armedAtMs = nowMs
    }

    /** True once for an arm made within [WINDOW_MS]; every later call is false until re-armed. */
    @Synchronized
    fun consume(nowMs: Long): Boolean {
        val armed = armedAtMs
        armedAtMs = 0L
        return armed != 0L && nowMs >= armed && nowMs - armed <= WINDOW_MS
    }
}
