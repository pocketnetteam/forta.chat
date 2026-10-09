package com.forta.chat.plugins.webrtc

/**
 * What a close made for an ended call may take down (N1, 2026-10-08).
 *
 * The SDK builds an incoming call's PeerConnection as soon as the invite
 * arrives, long before the call service starts for it. A close for the
 * previous call that ran a few hundred milliseconds later — the JS finalize's
 * step, or the call service's media-release worker — took that connection
 * down too: `setRemoteDescription: no PeerConnection`, the SDK dropped the
 * invite and the phone never rang. A close now carries the moment the call
 * ended; what was created before it belongs to that call, what was created
 * after belongs to the next one.
 */
object ReleaseScopePolicy {
    /**
     * Whether a connection created at [createdAt] goes down with a close for a
     * call that ended at [createdBefore]. A close without a mark (dispose, an
     * older caller) and a connection without a creation time both close, as
     * before.
     *
     * Wall clock on both sides (JS Date.now and System.currentTimeMillis read
     * the same system clock), so a clock stepped back inside the few hundred
     * milliseconds between the end and the next invite would close the new
     * connection again. Accepted: JS has no monotonic clock shared with native,
     * and the old rule closed it every time (review 2026-10-08, AND2).
     */
    fun closes(createdAt: Long?, createdBefore: Long?): Boolean =
        createdBefore == null || createdAt == null || createdAt < createdBefore

    /**
     * Whether the local tracks go too. With nothing newer left they always do.
     * With a newer connection kept they go only when the ended call made them;
     * tracks made after the mark are the newer call's.
     */
    fun releasesLocalMedia(keptConnections: Int, localMediaCreatedAt: Long?, createdBefore: Long?): Boolean =
        keptConnections == 0 || closes(localMediaCreatedAt, createdBefore)
}
