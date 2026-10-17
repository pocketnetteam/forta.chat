package com.forta.chat.plugins.calls

import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * O10/O13: the incoming-call surface tells the user when Android took the
 * full-screen intent away, and its volume rocker drives the ringer stream.
 * Source-level assertions in the spirit of [IncomingCallAcceptGuardTest].
 */
class IncomingCallSurfaceContractTest {

    private fun read(relative: String): String {
        val candidates = listOf("src/main/$relative", "android/app/src/main/$relative")
        return candidates.map { File(it) }.firstOrNull { it.exists() }?.readText()
            ?: error("$relative not found. Tried: $candidates from ${File(".").absolutePath}")
    }

    private val activity by lazy { read("java/com/forta/chat/plugins/calls/IncomingCallActivity.kt") }
    private val pushPlugin by lazy { read("java/com/forta/chat/plugins/push/PushDataPlugin.kt") }
    private val manifest by lazy { read("AndroidManifest.xml") }
    private val callPlugin by lazy { read("java/com/forta/chat/plugins/calls/CallPlugin.kt") }

    @Test
    fun incomingCallScreen_routesTheVolumeRocker_toTheRingerStream() {
        val onCreate = functionBody(activity, "override\\s+fun\\s+onCreate\\s*\\(")
        assertTrue(
            "onCreate must set volumeControlStream = AudioManager.STREAM_RING:\n$onCreate",
            onCreate.contains("volumeControlStream = AudioManager.STREAM_RING"),
        )
    }

    @Test
    fun fullScreenIntentStatus_asksTheSystem_onAndroid14AndLater() {
        val body = functionBody(pushPlugin, "fun\\s+getFullScreenIntentStatus\\s*\\(")
        assertTrue(body.contains("canUseFullScreenIntent()"))
        assertTrue("the query must be gated on API 34:\n$body", body.contains("Build.VERSION_CODES.UPSIDE_DOWN_CAKE"))
        assertTrue("the answer must carry both fields:\n$body", body.contains("put(\"allowed\"") && body.contains("put(\"manageable\""))
    }

    @Test
    fun fullScreenIntentSettings_deepLinkToTheSystemScreen_forThisPackage() {
        val body = functionBody(pushPlugin, "fun\\s+openFullScreenIntentSettings\\s*\\(")
        assertTrue(body.contains("Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT"))
        assertTrue("the intent must name this package:\n$body", body.contains("package:\${context.packageName}"))
        assertTrue("older Android must be refused, not crashed:\n$body", body.contains("call.reject("))
    }

    @Test
    fun manifest_declaresTheFullScreenIntentPermission() {
        assertTrue(manifest.contains("android.permission.USE_FULL_SCREEN_INTENT"))
    }

    @Test
    fun ensureIncomingCallVisible_decidesPerCall_notPerOccupiedSlot() {
        val body = functionBody(callPlugin, "fun\\s+ensureIncomingCallVisible\\s*\\(")
        assertTrue(
            "the skip must go through IncomingSurfacePolicy — reading the slot " +
                "directly is what let one stranded connection silence every later " +
                "call on the /sync route:\n$body",
            body.contains("IncomingSurfacePolicy.isAlreadyVisibleFor("),
        )
        assertTrue(
            "the requested callId must reach the policy, or it cannot tell the " +
                "idempotent re-ask from a different call:\n$body",
            body.contains("requestedCallId = call.getString(\"callId\")"),
        )
        assertTrue(
            "the armed ringer is the discriminator between a real ringer and an " +
                "orphan, so it must be passed in:\n$body",
            body.contains("ringingCallId = IncomingRinger.ringingCallId"),
        )
    }

    @Test
    fun ensureIncomingCallVisible_releasesAnUnpresentedSlotBeforeOfferingTheCall() {
        // Relying on onCreateIncomingConnection to displace the orphan does not
        // work: Telecom refuses addNewIncomingCall while this app holds a RINGING
        // self-managed call and fails it before the ConnectionService is asked at
        // all. Measured on a Samsung SM-A528B — "WAITING_CALL, [[Call id=TC@40,
        // state=RINGING]]" then "CREATE_CONNECTION_FAILED", and the phone stayed
        // silent.
        val body = functionBody(callPlugin, "fun\\s+ensureIncomingCallVisible\\s*\\(")
        val releaseAt = body.indexOf("CallConnectionService.releaseUnpresentedConnection()")
        val reportAt = body.indexOf("reportIncomingCall(call)")
        assertTrue(
            "the orphan must be released before the call is offered " +
                "(release=$releaseAt, report=$reportAt):\n$body",
            releaseAt >= 0 && reportAt >= 0 && releaseAt < reportAt,
        )
        assertTrue(
            "the release must go through the connection's single owner, not a " +
                "teardown invented here:\n$body",
            !body.contains("onReject()") && !body.contains("CallTeardown."),
        )
    }

    @Test
    fun releasingAnUnpresentedConnection_disconnectsAndNeverRejects() {
        // onReject writes a pendingReject marker, and the very next invite from
        // this room is the call being cleared for — it would be declined unheard.
        val body = functionBody(
            (read("java/com/forta/chat/plugins/calls/CallConnectionService.kt") + "\n" + read("java/com/forta/chat/plugins/calls/CallConnection.kt")),
            "fun\\s+releaseUnpresentedNow\\s*\\(",
        )
        assertTrue("must disconnect:\n$body", body.contains("connection.onDisconnect()"))
        assertTrue("must never reject:\n$body", !body.contains("onReject()"))
        val disconnectAt = body.indexOf("connection.onDisconnect()")
        val retireAt = body.indexOf("retirePendingMarkersForCall(")
        assertTrue(
            "the marker retire must follow the disconnect and sit outside its " +
                "runCatching — onDisconnect short-circuits on its released latch " +
                "and then clears nothing:\n$body",
            retireAt > disconnectAt && !insideRunCatching(body, retireAt),
        )
        assertTrue(
            "retire by callId only: sweeping the room would take the incoming " +
                "call's own markers with it:\n$body",
            Regex("retirePendingMarkersForCall\\(connection\\.callId,\\s*null\\)")
                .containsMatchIn(body),
        )
    }

    @Test
    fun releasingAnUnpresentedConnection_refusesAnythingButARing() {
        // Telecom answers a self-managed call on its own from a Bluetooth
        // headset, Android Auto or the system call UI, none of which touch our
        // activity — and onAnswer does not latch `released`. So a connection
        // that went RINGING -> ACTIVE between the caller's decision and this
        // release would be disconnected mid-conversation. The state rule itself
        // is tested in DisplacedConnectionPolicyTest; this pins the wiring.
        val body = functionBody(
            (read("java/com/forta/chat/plugins/calls/CallConnectionService.kt") + "\n" + read("java/com/forta/chat/plugins/calls/CallConnection.kt")),
            "fun\\s+releaseUnpresentedNow\\s*\\(",
        )
        val guardAt = body.indexOf("mayReleaseUnpresented(connection.state)")
        val disconnectAt = body.indexOf("connection.onDisconnect()")
        assertTrue(
            "the state must be re-checked, on this thread, before disconnecting " +
                "(guard=$guardAt, disconnect=$disconnectAt):\n$body",
            guardAt in 0 until disconnectAt,
        )
        assertTrue(
            "the slot must be re-read here rather than passed in from the " +
                "thread that formed the belief:\n$body",
            body.contains("val connection = currentConnection ?: return false"),
        )
    }

    @Test
    fun releasingAnUnpresentedConnection_runsOnTheMainLooper() {
        // Both ways the caller's belief can go stale — Telecom's onAnswer and
        // the connection's own 45 s onReject backstop — are delivered on the
        // main looper. Deciding on Capacitor's plugin thread and acting on the
        // decision afterwards is the race; running the whole thing as one main
        // -looper message is what serializes it against them.
        val body = functionBody(
            (read("java/com/forta/chat/plugins/calls/CallConnectionService.kt") + "\n" + read("java/com/forta/chat/plugins/calls/CallConnection.kt")),
            "fun\\s+releaseUnpresentedConnection\\s*\\(",
        )
        assertTrue(
            "the release must be posted to the main looper:\n$body",
            body.contains("Handler(Looper.getMainLooper()).post"),
        )
        assertTrue(
            "a caller already on the main looper must not deadlock on itself:\n$body",
            body.contains("Looper.myLooper() == Looper.getMainLooper()"),
        )
        assertTrue(
            "the wait must be bounded — a plugin thread parked on the main " +
                "looper for ever is worse than a call that does not ring:\n$body",
            body.contains("done.await(UNPRESENTED_RELEASE_TIMEOUT_MS"),
        )
    }

    /**
     * True when [at] falls inside a `runCatching { … }` block of [body].
     *
     * Counts braces from the `runCatching` keyword instead of looking for the
     * next `}`, which stops constraining anything the moment the lambda grows a
     * nested block.
     */
    private fun insideRunCatching(body: String, at: Int): Boolean {
        var i = body.indexOf("runCatching")
        while (i >= 0) {
            val open = body.indexOf("{", i)
            if (open < 0 || open > at) return false
            var depth = 0
            var j = open
            while (j < body.length) {
                if (body[j] == '{') depth++
                if (body[j] == '}') {
                    depth--
                    if (depth == 0) break
                }
                j++
            }
            if (at in open..j) return true
            i = body.indexOf("runCatching", j)
        }
        return false
    }

    @Test
    fun aDestroyedCallPlugin_stopsAnsweringTelecomCallbacks() {
        // CallConnection.onAnswered/onRejected/onEnded are companion-object
        // statics. A plugin instance that outlives its Bridge keeps receiving
        // native Accept/Decline and pushes them into a torn-down WebView, instead
        // of letting onAnswer's "queued for replay" marker path take over. Newly
        // reachable now that a dead renderer can trigger MainActivity.recreate().
        val body = functionBody(callPlugin, "override\\s+fun\\s+handleOnDestroy\\s*\\(")
        for (name in listOf("onAnswered", "onRejected", "onEnded")) {
            assertTrue(
                "handleOnDestroy must clear CallConnection.$name:\n$body",
                body.contains("CallConnection.$name = null"),
            )
        }
        assertTrue(
            "each clear must be guarded by identity — during a recreate the new " +
                "instance may already have installed its own, and clearing those " +
                "would silence a live plugin:\n$body",
            Regex("===").findAll(body).count() >= 3,
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
