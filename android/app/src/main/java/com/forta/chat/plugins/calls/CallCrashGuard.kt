package com.forta.chat.plugins.calls

/**
 * Shared crash-guard helper for the incoming-call native path (WEE-31).
 *
 * The callee process used to die "наглухо" on mobile→mobile incoming calls
 * because any throw inside the chain
 * `FortaFirebaseMessagingService.onMessageReceived` → `IncomingCallActivity.
 * onCreate` → `CallConnectionService.onCreateIncomingConnection` →
 * `CallForegroundService.startForeground` → `NativeWebRTCManager.initialize`
 * bubbled into a Telecom IPC frame or an FGS boundary the OS treats as
 * unrecoverable. The diagnostic + defensive pattern below is identical at
 * each call site: run a step, and if it throws, log a marker that names
 * the failing step plus a tag-scoped log emit, then either rethrow (to let
 * an outer activity-level catch take over) or swallow (when the step is
 * non-critical and the rest of the path can still succeed).
 *
 * Extracted so the wrapping logic can be unit-tested without instantiating
 * Activity / Service / Telecom shadows.
 */
object CallCrashGuard {

    /** Per-step log line shape, also used as a substring assertion in tests. */
    fun marker(step: String): String = "[callee-crash-guard] step=$step failed"

    /**
     * Run [block], invoke [onFailure] with the named step + throwable, and
     * rethrow. Use this for critical steps where the outer activity body
     * should abort and run its graceful-finish path.
     */
    inline fun <R> safeStep(
        step: String,
        onFailure: (step: String, error: Throwable) -> Unit,
        block: () -> R,
    ): R {
        try {
            return block()
        } catch (t: Throwable) {
            onFailure(step, t)
            throw t
        }
    }

    /**
     * Run [block], invoke [onFailure] with the named step + throwable, and
     * return [fallback] without rethrowing. Use this for non-critical
     * decorations (notification dismiss, animation start) where a failure
     * should leave the rest of the call surface intact.
     */
    inline fun <R> tryStep(
        step: String,
        fallback: R,
        onFailure: (step: String, error: Throwable) -> Unit,
        block: () -> R,
    ): R {
        return try {
            block()
        } catch (t: Throwable) {
            onFailure(step, t)
            fallback
        }
    }
}
