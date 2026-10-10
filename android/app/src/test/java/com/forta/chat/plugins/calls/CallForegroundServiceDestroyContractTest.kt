package com.forta.chat.plugins.calls

import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * WEE-49: regression for post-call audio mode leak / cellular block (#839, #771).
 *
 * The original `onDestroy()` only released the wake-lock and abandoned audio
 * focus. When Android killed the service without going through `ACTION_STOP`
 * (OEM Doze / battery-saver / swipe-app-out / low-memory SIGKILL), the
 * AudioRouter stayed in `MODE_IN_COMMUNICATION` forever and the device's
 * cellular network was effectively blocked until reboot.
 *
 * Robolectric-free source-level assertion in the same spirit as
 * [AudioRouterModeReapplyTest] — exercising the real lifecycle would require
 * spinning up a Service host and a fake AudioManager, which is far more
 * brittle than the cleanup contract this regression cares about.
 */
class CallForegroundServiceDestroyContractTest {

    private val source: String by lazy { readSource("calls/CallForegroundService.kt") }
    private val webRtcPlugin: String by lazy { readSource("webrtc/WebRTCPlugin.kt") }
    private val teardown: String by lazy { readSource("calls/CallTeardown.kt") }
    private val callPlugin: String by lazy { readSource("calls/CallPlugin.kt") }

    private fun readSource(relative: String): String {
        val candidates = listOf(
            "src/main/java/com/forta/chat/plugins/$relative",
            "android/app/src/main/java/com/forta/chat/plugins/$relative",
        )
        val resolved = candidates.map { File(it) }.firstOrNull { it.exists() }
            ?: error("$relative not found. Tried: $candidates from ${File(".").absolutePath}")
        return resolved.readText()
    }

    @Test
    fun onDestroy_forceStopsAudioRouter_toRestoreAudioMode() {
        // forceStop() bypasses AudioRouter's `isActive` guard and brute-
        // force restores MODE_NORMAL — the only safe call from a destroy
        // path because the JS-side stopAudioRouting may never have fired.
        val onDestroyBlock = extractFunctionBody("onDestroy")
        assertTrue(
            "onDestroy() must call AudioRouter.forceStop() to recover from " +
                "OEM-killed service paths (WEE-49 / forta-bugs#839):\n$onDestroyBlock",
            onDestroyBlock.contains("AudioRouter.getSharedInstance(") &&
                onDestroyBlock.contains(".forceStop()"),
        )
    }

    @Test
    fun onDestroy_explicitlyStopsForeground_soNotificationDoesNotLinger() {
        val onDestroyBlock = extractFunctionBody("onDestroy")
        assertTrue(
            "onDestroy() must call stopForeground(STOP_FOREGROUND_REMOVE) so " +
                "the call notification disappears when the OS kills the service " +
                "without ACTION_STOP:\n$onDestroyBlock",
            onDestroyBlock.contains("stopForeground(STOP_FOREGROUND_REMOVE)"),
        )
    }

    @Test
    fun onDestroy_wrapsBruteResetInRunCatching_soOneFailureDoesNotSwallowTheNext() {
        val onDestroyBlock = extractFunctionBody("onDestroy")
        // Both brute-force calls must be wrapped — if forceStop throws and
        // stopForeground is not wrapped, the notification would leak forever.
        val runCatchingHits = Regex("runCatching\\s*\\{")
            .findAll(onDestroyBlock).count()
        assertTrue(
            "onDestroy() must wrap at least two brute-force steps in runCatching " +
                "(found $runCatchingHits):\n$onDestroyBlock",
            runCatchingHits >= 2,
        )
    }

    @Test
    fun onDestroy_clearsHasStartedFlag_soStaleUpdatesAreRejectedAfterRebirth() {
        val onDestroyBlock = extractFunctionBody("onDestroy")
        assertTrue(
            "onDestroy() must reset hasStarted=false so a future ACTION_UPDATE " +
                "arriving before the next ACTION_START is ignored " +
                "(WEE-45 protection survives a destroy/recreate cycle):\n$onDestroyBlock",
            onDestroyBlock.contains("hasStarted = false"),
        )
    }

    // -------------------------------------------------------------------------
    // WEE-54 / forta-bugs#839 (reopen) — swipe-out cellular block.
    //
    // onDestroy() hardening (WEE-49) only fired when the OS actually destroyed
    // the service. On swipe-app-out the OS delivers onTaskRemoved but can defer
    // onDestroy, leaving AudioRouter in MODE_IN_COMMUNICATION and cellular
    // blocked. onTaskRemoved must run the same brute-force audio cleanup.
    // -------------------------------------------------------------------------

    @Test
    fun onTaskRemoved_forceStopsAudioRouter_toUnblockCellularOnSwipeOut() {
        val block = extractFunctionBody("onTaskRemoved")
        assertTrue(
            "onTaskRemoved() must call AudioRouter.forceStop() so a swipe-out " +
                "during a call cannot leave MODE_IN_COMMUNICATION set and block " +
                "cellular (WEE-54 / forta-bugs#839 reopen):\n$block",
            block.contains("AudioRouter.getSharedInstance(") &&
                block.contains(".forceStop()"),
        )
    }

    @Test
    fun onTaskRemoved_stopsForegroundAndStopsSelf_soNoZombieServiceHoldsAudioMode() {
        val block = extractFunctionBody("onTaskRemoved")
        assertTrue(
            "onTaskRemoved() must stopForeground(STOP_FOREGROUND_REMOVE):\n$block",
            block.contains("stopForeground(STOP_FOREGROUND_REMOVE)"),
        )
        assertTrue(
            "onTaskRemoved() must stopSelf() so the OS finalises the service " +
                "instead of leaving a zombie record holding the audio mode:\n$block",
            block.contains("stopSelf()"),
        )
    }

    @Test
    fun onTaskRemoved_clearsInstance_soStaleIsRunningCannotResurrectVoipMode() {
        val block = extractFunctionBody("onTaskRemoved")
        // isRunning == (instance != null) is what the AudioRouter orphan
        // watchdog / CallActivity.onResume consult before restoring
        // MODE_IN_COMMUNICATION. onTaskRemoved tears audio down but the OS can
        // defer onDestroy — if instance stays non-null in that window a waking
        // surface re-applies comm mode and re-strands audio (#708 / #462).
        assertTrue(
            "onTaskRemoved() must set instance = null so isRunning matches the " +
                "audio teardown that already ran (WEE-54):\n$block",
            block.contains("instance = null"),
        )
    }

    @Test
    fun onTaskRemoved_wrapsBruteResetInRunCatching_soOneFailureDoesNotSwallowTheNext() {
        val block = extractFunctionBody("onTaskRemoved")
        val runCatchingHits = Regex("runCatching\\s*\\{")
            .findAll(block).count()
        assertTrue(
            "onTaskRemoved() must wrap at least two brute-force steps in " +
                "runCatching (found $runCatchingHits):\n$block",
            runCatchingHits >= 2,
        )
    }


    // -------------------------------------------------------------------------
    // forta-bugs#997 — "the microphone keeps being used by forta".
    //
    // Both teardown paths reset the audio *mode* but neither closed the WebRTC
    // capture path, so AudioRecord stayed held by the process after a swipe-out.
    // startLocalAudio early-returns while localAudioTrack != null, so the
    // orphaned track — bound to a dead PeerConnection — also poisoned the next
    // call. closeAllPeerConnections() → stopLocalMedia() disposes both.
    // -------------------------------------------------------------------------

    @Test
    fun onDestroy_releasesTheCapturePath_soTheMicrophoneIsFreed() {
        val block = extractFunctionBody("onDestroy")
        assertTrue(
            "onDestroy() must release the WebRTC capture path so the mic " +
                "indicator clears (forta-bugs#997):\n$block",
            block.contains("releaseMediaAsync("),
        )
    }

    @Test
    fun onTaskRemoved_releasesTheCapturePath_soSwipeOutFreesTheMicrophone() {
        val block = extractFunctionBody("onTaskRemoved")
        assertTrue(
            "onTaskRemoved() must release the WebRTC capture path — swipe-out " +
                "is the reported repro for the stuck mic (forta-bugs#997):\n$block",
            block.contains("releaseMediaAsync("),
        )
    }

    @Test
    fun captureTeardownIsDispatchedOffTheLifecycleThread() {
        // closeAllPeerConnections blocks on videoCapturer.stopCapture(), which
        // waits for the capture thread to stop — up to about a second on an old
        // camera HAL. Service lifecycle callbacks run on the main thread, so
        // calling it inline would trade a stuck mic for an ANR. Everywhere else
        // in the app this method is reached from Capacitor's plugin thread.
        val helper = extractPrivateFunctionBody("releaseMediaAsync")
        assertTrue(
            "releaseMediaAsync must hand the work to an executor, not run it " +
                "inline:\n$helper",
            helper.contains("mediaReleaseExecutor.execute"),
        )
        assertTrue(
            "releaseMediaAsync must be the thing that closes the peer " +
                "connections:\n$helper",
            helper.contains("closeAllPeerConnections(createdBefore)"),
        )
    }

    @Test
    fun audioModeResetStaysSynchronous_becauseItOutlivesTheProcess() {
        // The counterpart to the test above, and the reason the two are not
        // treated alike: the microphone is process-local, so the OS reclaims it
        // if the process dies before the worker runs. The audio mode is global
        // and survives process death — deferring it would reopen the stranded
        // MODE_IN_COMMUNICATION bug (WEE-49 / WEE-54).
        for (name in listOf("onDestroy", "onTaskRemoved")) {
            val block = extractFunctionBody(name)
            val forceStop = block.indexOf(".forceStop()")
            assertTrue("$name(): forceStop() not found:\n$block", forceStop >= 0)
            assertTrue(
                "$name() must call forceStop() directly, not from the media " +
                    "release worker:\n$block",
                !block.contains("mediaReleaseExecutor"),
            )
        }
    }

    // -------------------------------------------------------------------------
    // Superseded-instance guard.
    //
    // stopSelf() -> onDestroy() is asynchronous and OEM ROMs defer it further,
    // so the OS can tear down a *previous* service instance after the next call
    // has already started a fresh one. The teardown is process-wide (audio mode
    // + PeerConnections are global), so an unguarded run from a dead instance
    // would silence the live call — and `instance = null` would blank the
    // liveness pointer that belongs to its successor.
    // -------------------------------------------------------------------------

    @Test
    fun teardown_skipsGlobalCleanupWhenANewerInstanceHasTakenOver() {
        for (name in listOf("onDestroy", "onTaskRemoved")) {
            val block = extractFunctionBody(name)
            val guard = block.indexOf("isStale()")
            assertTrue(
                "$name() must bail out via isStale() before running the " +
                    "process-wide teardown, or a deferred destroy will tear down " +
                    "the next call:\n$block",
                guard >= 0,
            )
            assertTrue(
                "$name()'s isStale() check must come before forceStop():\n$block",
                guard < block.indexOf(".forceStop()"),
            )
            assertTrue(
                "$name()'s stale branch must return early:\n$block",
                block.contains("return"),
            )
        }
    }

    @Test
    fun staleCheck_coversASuccessorAndAStartAlreadyIssuedForTheNextCall() {
        // A successor's onCreate never runs before this instance's onDestroy,
        // so identity alone can only ever see the previous owner. The counter
        // is bumped in start() before the intent is sent; a teardown deferred
        // past that call must read the next call as the owner.
        val body = extractPrivateFunctionBody("isStale")
        assertTrue("isStale() must keep the identity check:\n$body", body.contains("isSuperseded()"))
        assertTrue(
            "isStale() must compare this instance's generation with the counter:\n$body",
            body.contains("CallServiceStopPolicy.isStale(generation, startGeneration.get())"),
        )
        val start = extractActionBlock("ACTION_START")
        assertTrue(
            "ACTION_START must record the generation this instance runs:\n$start",
            start.contains("generation = intent.getLongExtra(EXTRA_GENERATION, -1L)"),
        )
    }

    @Test
    fun mediaReleaseWorker_checksTheOwnerAgainAtRunTime() {
        // The PeerConnections are global. A task queued behind a slow
        // stopCapture may run after the next call created its own; the check
        // at scheduling time does not cover that.
        val helper = extractPrivateFunctionBody("releaseMediaAsync")
        val check = helper.indexOf("CallServiceStopPolicy.isStale(owner, startGeneration.get())")
        val execute = helper.indexOf("mediaReleaseExecutor.execute")
        val close = helper.indexOf("closeAllPeerConnections(createdBefore)")
        assertTrue("the worker must re-check the owner:\n$helper", check >= 0)
        assertTrue("the re-check must run inside the worker, not before scheduling:\n$helper", check > execute)
        assertTrue("the re-check must come before closeAllPeerConnections():\n$helper", check < close)
        assertTrue("a stale worker must return without closing:\n$helper", helper.contains("return@execute"))
    }

    // -------------------------------------------------------------------------
    // Keyed stop. The redial race runs the other way round from what the
    // generation extra first assumed: JS finalizes the ended call step by step
    // while the user already dials again, so the old call's stop is *issued*
    // after the new call's start. Issued against the current counter it matched
    // and took the new call down. A stop names its call and is issued against
    // the generation that call's start recorded (CallStartLedger).
    // -------------------------------------------------------------------------

    @Test
    fun start_recordsTheGenerationOfItsCall() {
        val body = extractCompanionFunctionBody("start")
        assertTrue(
            "start() must record the generation under the call id:\n$body",
            body.contains("startLedger.record(callId, generation)"),
        )
    }

    @Test
    fun stop_isIssuedAgainstTheGenerationItsCallStarted_notTheCurrentOne() {
        val body = extractCompanionFunctionBody("stop")
        assertTrue(
            "stop() must look its call's generation up in the ledger:\n$body",
            body.contains("startLedger.generationFor(callId, startGeneration.get())"),
        )
        assertTrue(
            "stop() must not put the bare current generation into the intent:\n$body",
            !body.contains("putExtra(EXTRA_GENERATION, startGeneration.get())"),
        )
    }

    @Test
    fun theJsCloseOfAllPeerConnections_isSkippedForACallANewerStartReplaced() {
        // Step 4 of the JS finalize; the only process-wide step that reached
        // native without naming its call.
        val body = Regex("fun\\s+closeAllPeerConnections\\s*\\(call: PluginCall\\)[^{]*\\{")
            .find(webRtcPlugin)?.let { m ->
                var depth = 1
                var i = m.range.last + 1
                val start = i
                while (i < webRtcPlugin.length && depth > 0) {
                    when (webRtcPlugin[i]) { '{' -> depth++; '}' -> depth-- }
                    i++
                }
                webRtcPlugin.substring(start, i - 1)
            } ?: error("WebRTCPlugin.closeAllPeerConnections not found")
        val check = body.indexOf("CallForegroundService.isStartStale(callId)")
        val close = body.indexOf("manager?.closeAllPeerConnections(")
        assertTrue("closeAllPeerConnections must ask whether its call is stale:\n$body", check >= 0)
        assertTrue("the check must come before the close:\n$body", check < close)
        assertTrue("a stale close must return without closing:\n$body", body.contains("return"))
    }

    @Test
    fun aStaleDismiss_leavesTheNewCallsScreenUp() {
        // redial5, 2026-09-18: a finalize delayed past the next call's
        // launchCallUI had its stop ignored and its PeerConnection close skipped,
        // but still closed that call's CallActivity.
        val start = webRtcPlugin.indexOf("fun dismissCallUI(")
        val body = webRtcPlugin.substring(start, webRtcPlugin.indexOf("@PluginMethod", start))
        val guarded = Regex(
            "if\\s*\\([^)]*CallForegroundService\\.isStartStale\\(callId\\)\\)\\s*\\{[^}]*\\}\\s*else\\s*\\{\\s*" +
                "[\\w.]*CallActivity\\.onCallEnded\\?\\.invoke\\(\\)",
        )
        assertTrue("the screen close must sit behind the staleness check:\n$body", guarded.containsMatchIn(body))
        assertTrue(
            "the keyed stop must still run for a stale dismiss, so the ledger sees it:\n$body",
            body.indexOf("CallForegroundService.stop(context, callId)") > body.indexOf("isStartStale(callId)"),
        )
    }

    @Test
    fun everyStopNamesItsCall() {
        assertTrue(
            "launchCallUI must start the service under the call id:\n$webRtcPlugin",
            Regex("CallForegroundService\\.start\\(\\s*context, callerName, callType, callId\\s*\\)").containsMatchIn(webRtcPlugin),
        )
        assertTrue(
            "dismissCallUI must stop the service for the call JS is finalizing:\n$webRtcPlugin",
            webRtcPlugin.contains("CallForegroundService.stop(context, callId)"),
        )
        assertTrue(
            "CallTeardown must stop the service for the call that ended:\n$teardown",
            teardown.contains("CallForegroundService.stop(app, callId)"),
        )
        // The Telecom slot of a push-delivered call carries `$event_id`, and
        // its onDisconnect stops the service under that id; JS started the
        // service under the Matrix id. Adoption is where the two ids meet.
        assertTrue(
            "reportCallConnected must alias the slot's id to the Matrix id:\n$callPlugin",
            callPlugin.contains("CallForegroundService.aliasCall(it.callId, callId)"),
        )
    }

    @Test
    fun supersededCheck_comparesIdentity_notMereNullness() {
        // `instance != null` alone would make every teardown a no-op once a
        // successor exists *and* would skip cleanup for the last instance too;
        // identity (`!==`) is what distinguishes "I was replaced" from "I am
        // still the live service".
        val body = extractPrivateFunctionBody("isSuperseded")
        assertTrue(
            "isSuperseded() must compare instance identity with !== :\n$body",
            body.contains("!=="),
        )
    }

    // -------------------------------------------------------------------------
    // Telecom slot. 00ddc636 gave every stranded call resource an owner except
    // the two that do not live in this service: the Telecom connection and the
    // pending answer/reject markers, both reachable only through process-global
    // statics. A swipe-out left the connection ACTIVE, which parks the device in
    // MODE_IN_COMMUNICATION and makes every later call in the process unringable
    // (ensureIncomingCallVisible skips a non-null slot; onCreateIncomingConnection
    // answers BUSY for an ACTIVE one) — and left the answer marker behind, which
    // the next app start replayed into an unattended auto-answer.
    // -------------------------------------------------------------------------

    @Test
    fun onTaskRemoved_releasesTheTelecomSlot_soTheNextCallCanRing() {
        val block = extractFunctionBody("onTaskRemoved")
        assertTrue(
            "onTaskRemoved() must release the Telecom connection, or every later " +
                "call in this process is answered BUSY and never rings:\n$block",
            block.contains("CallConnectionService.releaseOnTaskRemoved("),
        )
    }

    @Test
    fun onTaskRemoved_releasesTheSlotLast_soTheNestedTeardownFindsNothingToDo() {
        // releaseOnTaskRemoved -> onDisconnect -> CallTeardown.endCall(DISCONNECT).
        // With the router already down and `instance` already null that nested
        // decide() returns no actions; run it earlier and it emits
        // STOP_FOREGROUND_SERVICE, i.e. a startService() into a service that is
        // mid-destruction — which Android 12+ answers with a throw or a fresh
        // service instance.
        val block = extractFunctionBody("onTaskRemoved")
        val release = block.indexOf("releaseOnTaskRemoved(")
        assertTrue("releaseOnTaskRemoved() not found:\n$block", release >= 0)
        assertTrue(
            "the slot release must come after forceStop():\n$block",
            block.indexOf(".forceStop()") in 0 until release,
        )
        assertTrue(
            "the slot release must come after `instance = null`:\n$block",
            block.indexOf("instance = null") in 0 until release,
        )
    }

    @Test
    fun supersededInstance_leavesTheTelecomSlotAlone() {
        // If a newer instance owns liveness there is a newer call, and
        // onCreate{Incoming,Outgoing}Connection already displaced the old
        // connection — so there is nothing stranded to release, and releasing
        // would disconnect the live call.
        val block = extractFunctionBody("onTaskRemoved")
        val guardReturn = block.indexOf("return")
        assertTrue("the superseded branch must return early:\n$block", guardReturn >= 0)
        assertTrue(
            "the slot release must sit after the superseded early return:\n$block",
            guardReturn < block.indexOf("releaseOnTaskRemoved("),
        )
    }

    @Test
    fun onDestroy_leavesTheTelecomSlot_soANormalTeardownKeepsItsOwnDisconnect() {
        // Deliberate asymmetry with onTaskRemoved. onDestroy also runs on the
        // ordinary end of a call, where finalizeCall/reportCallEnded already own
        // the disconnect; releasing here would race them for the DisconnectCause.
        // Task removal is the only path where the JS owner is provably gone.
        val block = extractFunctionBody("onDestroy")
        assertTrue(
            "onDestroy() must not release the Telecom slot:\n$block",
            !block.contains("releaseOnTaskRemoved("),
        )
    }

    /**
     * Extract the body of a top-level `override fun <name>(...)` block from the
     * Kotlin source. Brace-counts so nested blocks (if/try/runCatching) do not
     * end the match early.
     */
    private fun extractFunctionBody(name: String): String {
        val signature = Regex("override\\s+fun\\s+$name\\s*\\([^)]*\\)\\s*\\{")
        val match = signature.find(source)
            ?: error("Could not find override fun $name in source")
        var depth = 1
        var i = match.range.last + 1
        val start = i
        while (i < source.length && depth > 0) {
            when (source[i]) {
                '{' -> depth++
                '}' -> depth--
            }
            i++
        }
        return source.substring(start, i - 1)
    }

    /** A companion `fun name(...)` — neither `override` nor `private`. */
    private fun extractCompanionFunctionBody(name: String): String {
        val signature = Regex("(?<![a-zA-Z])fun\\s+$name\\s*\\([^)]*\\)[^{]*\\{")
        val match = signature.find(source)
            ?: error("Could not find fun $name in source")
        return bodyFrom(match.range.last + 1)
    }

    /** The `ACTION_X -> { ... }` branch of onStartCommand. */
    private fun extractActionBlock(action: String): String {
        // Unlike the lifecycle hooks, onStartCommand declares a return type.
        val signature = Regex("override\\s+fun\\s+onStartCommand\\s*\\([^)]*\\)[^{]*\\{")
        val match = signature.find(source) ?: error("Could not find override fun onStartCommand in source")
        val onStart = bodyFrom(match.range.last + 1)
        val at = onStart.indexOf("$action -> {")
        assertTrue("onStartCommand has no $action branch:\n$onStart", at >= 0)
        val open = onStart.indexOf('{', at)
        var depth = 1
        var i = open + 1
        while (i < onStart.length && depth > 0) {
            when (onStart[i]) {
                '{' -> depth++
                '}' -> depth--
            }
            i++
        }
        return onStart.substring(open + 1, i - 1)
    }

    private fun bodyFrom(start: Int): String {
        var depth = 1
        var i = start
        while (i < source.length && depth > 0) {
            when (source[i]) {
                '{' -> depth++
                '}' -> depth--
            }
            i++
        }
        return source.substring(start, i - 1)
    }

    /** Same as [extractFunctionBody] but for a non-`override` private fun. */
    private fun extractPrivateFunctionBody(name: String): String {
        val signature = Regex("private\\s+fun\\s+$name\\s*\\([^)]*\\)[^{]*\\{")
        val match = signature.find(source)
            ?: error("Could not find private fun $name in source")
        var depth = 1
        var i = match.range.last + 1
        val start = i
        while (i < source.length && depth > 0) {
            when (source[i]) {
                '{' -> depth++
                '}' -> depth--
            }
            i++
        }
        return source.substring(start, i - 1)
    }
}
