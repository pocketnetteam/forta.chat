package com.forta.chat.plugins.calls

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * Pins the wiring around [PendingCallMarker].
 *
 * The marker's own behaviour is covered by [PendingCallMarkerTest]; what a
 * unit test cannot reach is the wiring, because [CallConnection] extends
 * android.telecom.Connection and will not load off-device. So this pins by
 * source text — as [CallSlotContractTest] does for the slot rule — that the
 * marker really is held atomically, that every write goes through it, and that
 * the bridge hands its write time to JS.
 */
class PendingMarkerStampContractTest {

    private fun source(relative: String): String {
        val candidates = listOf("src/main/java/$relative", "android/app/src/main/java/$relative")
        return candidates.map { File(it) }.firstOrNull { it.exists() }?.readText()
            ?: error("$relative not found. Tried: $candidates from ${File(".").absolutePath}")
    }

    private val service by lazy { (source("com/forta/chat/plugins/calls/CallConnectionService.kt") + "\n" + source("com/forta/chat/plugins/calls/CallConnection.kt")) }
    private val plugin by lazy { source("com/forta/chat/plugins/calls/CallPlugin.kt") }
    private val activity by lazy { source("com/forta/chat/plugins/calls/IncomingCallActivity.kt") }

    @Test
    fun markersAreHeldAtomically() {
        for (kind in listOf("Answer", "Reject")) {
            assertTrue(
                "pending$kind must live behind an AtomicReference — it is written from " +
                    "Telecom callbacks and read from Capacitor's plugin thread:\n$service",
                service.contains("private val pending${kind}Ref = AtomicReference(PendingCallMarker.NONE)"),
            )
            assertTrue(
                "takePending$kind must read and clear in one step, or a concurrent write is lost:\n$service",
                service.contains("pending${kind}Ref.getAndSet(PendingCallMarker.NONE)"),
            )
        }
    }

    @Test
    fun aFinishedCallRetiresBothOfItsMarkers() {
        // A marker only carries a decision across a process that was not alive
        // to act on it. Once JS finalizes the call it has acted, and anything
        // left behind reaches the next invite from that room through the
        // roomId fallback — auto-answering it or declining it unheard, both
        // seen on the Samsung bench 2026-09-09.
        val retire = functionBody(service, "fun\\s+retirePendingMarkersForCall\\s*\\(")
        for (kind in listOf("Answer", "Reject")) {
            assertTrue(
                "a finished call must retire its pending$kind marker:\n$retire",
                retire.contains("pending${kind}Ref.updateAndGet { it.clearedFor(callId, roomId) }"),
            )
        }
        // The room half is what makes the push path work at all: a connection
        // created from a push is keyed by an event_id that never equals the
        // Matrix callId a finalize carries. Narrowing this back to the callId
        // would make the retire inert on that path.
        assertTrue(
            "the retire must keep matching on the room:\n$retire",
            !retire.contains("clearedFor(callId, null)"),
        )

        val method = functionBody(plugin, "fun\\s+retirePendingMarkers\\s*\\(")
        assertTrue(
            "CallPlugin must hand JS's callId and roomId through:\n$method",
            method.contains("CallConnection.retirePendingMarkersForCall(") &&
                method.contains("call.getString(\"callId\")") &&
                method.contains("call.getString(\"roomId\")"),
        )
    }

    @Test
    fun noLooseMarkerFieldsSurvive() {
        // Three separate vars are what let a call's id sit next to another
        // call's room; nothing may reintroduce them.
        for (src in listOf(service, plugin, activity)) {
            for (field in listOf(
                "pendingAnswerCallId", "pendingAnswerRoomId",
                "pendingRejectCallId", "pendingRejectRoomId",
            )) {
                assertTrue(
                    "$field must not come back as a separate field",
                    !src.contains("var $field") && !src.contains("$field ="),
                )
            }
        }
    }

    @Test
    fun everyWriteGoesThroughTheMarkerAndCarriesAWriteTime() {
        for (fn in listOf("onAnswer", "onReject")) {
            val body = functionBody(service, "override\\s+fun\\s+$fn\\s*\\(")
            assertTrue(
                "$fn must write the marker whole, so the id and the room always name one call:\n$body",
                body.contains("PendingCallMarker.of(callId, roomId, System.currentTimeMillis())"),
            )
        }
        val clear = functionBody(service, "fun\\s+clearPendingFor\\s*\\(")
        assertTrue(
            "clearPendingFor must drop the marker whole, not one field:\n$clear",
            clear.contains("it.clearedFor(cid, rid)"),
        )
        for (seed in listOf("seedPendingAnswer", "seedPendingReject")) {
            assertTrue(
                "$seed must be the only belt-and-braces write, stamped:\n$activity",
                activity.contains("CallConnection.$seed("),
            )
            // The guard used to be `if (it.isEmpty)`, which cannot tell the
            // authoritative write for THIS call from a marker another call
            // left standing — and silently dropped the decision the user had
            // just made. The rule is a pure function so it can be tested.
            val body = functionBody(service, "fun\\s+$seed\\s*\\(")
            assertTrue(
                "$seed must decide through PendingCallMarker.seeded:\n$body",
                body.contains("PendingCallMarker.seeded("),
            )
        }
        assertTrue(
            "the belt-and-braces writes must stamp the clock:\n$activity",
            activity.contains("PendingCallMarker.of(callId, roomIdForPending, System.currentTimeMillis())"),
        )
    }

    @Test
    fun noRingerPathWipesTheMarkersOfEveryOtherCall() {
        // A blanket `pendingAnswer = NONE` reads as defence-in-depth and is
        // the opposite: this screen is shown by FCM independently of Telecom,
        // so it is routinely up for a DIFFERENT call than the one whose answer
        // is still queued for replay — a call answered from a headset or the
        // system call UI before JS was running. Declining the second one, or
        // the caller of the second one hanging up, then threw away the record
        // of the answer the user had already given, and JS never learned about
        // it. Every clear here must name the call it belongs to.
        assertFalse(
            "no path in the ringer may assign the answer marker wholesale:\n$activity",
            activity.contains("CallConnection.pendingAnswer = PendingCallMarker.NONE"),
        )
        for (fn in listOf("decline", "dismissByRemote")) {
            val body = functionBody(activity, "private\\s+fun\\s+$fn\\s*\\(")
            assertTrue(
                "$fn must retire the marker by the call it names:\n$body",
                Regex("retirePendingAnswerForCall\\((callId|shownCallId), null\\)")
                    .containsMatchIn(body),
            )
        }
    }

    @Test
    fun bothGettersHandTheWriteTimeToJs() {
        for (kind in listOf("Answer", "Reject")) {
            val body = functionBody(plugin, "fun\\s+getPending$kind\\s*\\(")
            assertTrue(
                "getPending$kind must take the marker atomically:\n$body",
                body.contains("CallConnection.takePending$kind()"),
            )
            assertTrue(
                "getPending$kind must hand the write time to JS:\n$body",
                body.contains("ret.put(\"atMs\", marker.atMs)"),
            )
        }
    }

    @Test
    fun aConnectedCallRetiresItsMarkersImmediately() {
        // The marker only ever has to carry a decision across a process that
        // was not alive to send it. Once the answer is on the wire it is spent,
        // and leaving it until finalizeCall means it survives any path where
        // teardown never runs — a task swipe — and gets replayed into the next
        // call from that room.
        val body = functionBody(plugin, "fun\\s+reportCallConnected\\s*\\(")
        val retire = body.indexOf("retirePendingMarkersForCall(")
        assertTrue("a connected call must retire its markers:\n$body", retire >= 0)
        // After the slot filter, so a stale report cannot retire another call's
        // markers, and keyed by the connection's own ids: a push-created
        // connection is keyed by the event_id, which no JS-side caller has.
        val owns = body.indexOf("CallSlotPolicy.owns(")
        assertTrue("the retire must come after the slot check:\n$body", owns in 0 until retire)
        // By callId alone: a marker belonging to this connection was written
        // under this connection's id, so the room buys nothing — and a
        // room-scoped retire from native code would wipe a marker a second,
        // concurrently declined invite for the same room still needs.
        assertTrue(
            "the retire must be keyed by callId alone, not by room:\n$body",
            body.contains("retirePendingMarkersForCall(it.callId, null)"),
        )
    }

    private fun functionBody(src: String, signaturePattern: String): String {
        val match = Regex("$signaturePattern[^{]*\\{").find(src)
            ?: error("Could not find /$signaturePattern/ in source")
        var depth = 1
        var i = match.range.last + 1
        val start = i
        while (i < src.length && depth > 0) {
            when (src[i]) {
                '{' -> depth++
                '}' -> depth--
            }
            i++
        }
        return src.substring(start, i - 1)
    }
}
