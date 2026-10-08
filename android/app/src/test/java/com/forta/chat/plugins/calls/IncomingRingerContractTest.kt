package com.forta.chat.plugins.calls

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * Pins the ringer ownership: ringtone, vibration and the 30 s deadline live
 * in [IncomingRinger], keyed by callId, and every answer route reaches it.
 * Source-level, like [IncomingCallAcceptGuardTest] — the real activity,
 * Telecom and the notification shade cannot run under JUnit.
 */
class IncomingRingerContractTest {

    private fun source(relative: String): String {
        val candidates = listOf("src/main/java/$relative", "android/app/src/main/java/$relative")
        return candidates.map { File(it) }.firstOrNull { it.exists() }?.readText()
            ?: error("$relative not found. Tried: $candidates from ${File(".").absolutePath}")
    }

    private val activity by lazy { source("com/forta/chat/plugins/calls/IncomingCallActivity.kt") }
    private val connectionService by lazy { (source("com/forta/chat/plugins/calls/CallConnectionService.kt") + "\n" + source("com/forta/chat/plugins/calls/CallConnection.kt")) }
    private val callPlugin by lazy { source("com/forta/chat/plugins/calls/CallPlugin.kt") }
    private val teardown by lazy { source("com/forta/chat/plugins/calls/CallTeardown.kt") }
    private val mainActivity by lazy { source("com/forta/chat/MainActivity.kt") }
    private val firebase by lazy { source("com/forta/chat/FortaFirebaseMessagingService.kt") }
    private val ringer by lazy { source("com/forta/chat/plugins/calls/IncomingRinger.kt") }

    // -- one owner ------------------------------------------------------------

    @Test
    fun theActivityNoLongerOwnsRingtoneVibrationOrTheDeadline() {
        assertFalse("ringtone must be created in IncomingRinger only", activity.contains("RingtoneManager"))
        assertFalse("vibration must be started in IncomingRinger only", activity.contains("VibrationEffect"))
        assertFalse("the 30 s deadline must not be an activity Runnable", activity.contains("autoRejectRunnable"))
        assertTrue(activity.contains("IncomingRinger.arm(this, shownCallId)"))
    }

    @Test
    fun aSecondCallerRearmsTheRingerForItsOwnId() {
        val body = functionBody(activity, "override\\s+fun\\s+onNewIntent\\s*\\(")
        assertTrue("onNewIntent must re-arm for the displacing call:\n$body", body.contains("IncomingRinger.arm(this, newCallId)"))
    }

    // -- the shade tap ----------------------------------------------------------

    @Test
    fun onNewIntentMergesInsteadOfReplacingTheIntent() {
        val body = functionBody(activity, "override\\s+fun\\s+onNewIntent\\s*\\(")
        val merge = body.indexOf("IncomingIntentMerge.merge(")
        val set = body.indexOf("setIntent(intent)")
        assertTrue("onNewIntent must merge the held extras into the new intent:\n$body", merge >= 0)
        assertTrue("the merge must happen before setIntent:\n$body", merge < set)
        assertFalse("no bare setIntent before the merge", body.substring(0, merge).contains("setIntent("))
    }

    @Test
    fun telecomShadeActionsReachTheResidentRingerAndCarryTheRoom() {
        val body = functionBody(connectionService, "private\\s+fun\\s+showIncomingCallUI\\s*\\(")
        for (action in listOf("accept", "decline")) {
            val block = body.substring(0, body.indexOf("putExtra(\"action\", \"$action\")"))
                .substringAfterLast("Intent(applicationContext, IncomingCallActivity::class.java)")
            assertTrue("$action intent must carry CLEAR_TOP:\n$block", block.contains("FLAG_ACTIVITY_CLEAR_TOP"))
            assertTrue("$action intent must carry SINGLE_TOP:\n$block", block.contains("FLAG_ACTIVITY_SINGLE_TOP"))
            assertTrue("$action intent must carry roomId:\n$block", block.contains("putExtra(\"roomId\", roomId)"))
        }
        assertTrue("showIncomingCallUI must receive the roomId", body.isNotEmpty() &&
            connectionService.contains("showIncomingCallUI(callId, callerName, hasVideo, roomId)"))
    }

    @Test
    fun pushShadeActionsStillReachTheResidentRinger() {
        // Regression guard for the FCM side, which already had the flags.
        val accept = firebase.substringBefore("putExtra(\"action\", \"accept\")").substringAfterLast("val acceptIntent")
        assertTrue(accept.contains("FLAG_ACTIVITY_SINGLE_TOP") && accept.contains("FLAG_ACTIVITY_CLEAR_TOP"))
    }

    // -- every answer route stops the ring ---------------------------------------

    @Test
    fun telecomAnswerStopsTheRingByCallIdAndDismissesThePushNotification() {
        val body = functionBody(connectionService, "override\\s+fun\\s+onAnswer\\s*\\(")
        assertTrue("onAnswer must stop the ringer for its call:\n$body", body.contains("IncomingRinger.stop(callId)"))
        assertTrue("onAnswer must dismiss the push notification:\n$body", body.contains("dismissPushCallNotification(context, roomId)"))
    }

    @Test
    fun jsReportedConnectStopsTheConnectedCallsRingAndDismissesThePushNotification() {
        val body = functionBody(callPlugin, "fun\\s+reportCallConnected\\s*\\(")
        // Keyed since the 2026-10-08 review: a ring already rebound to the next
        // call stays; a push event id still matches anything (RemoteHangupPolicy).
        assertTrue("reportCallConnected must stop the ring of the call that connected:\n$body", body.contains("IncomingCallActivity.stopRingerIfShowing(callId)"))
        assertTrue("reportCallConnected must dismiss the push notification:\n$body", body.contains("dismissPushCallNotification("))
    }

    @Test
    fun theTeardownStopsTheRingerThroughThePolicy() {
        assertTrue(teardown.contains("CallTeardownPolicy.Action.STOP_RINGER ->"))
        assertTrue(teardown.contains("IncomingRinger.stop(state.ringingCallId)"))
        assertTrue(teardown.contains("ringingCallId = IncomingRinger.ringingCallId"))
        assertTrue("the policy must be told which call ended", teardown.contains("CallTeardownPolicy.decide(reason, state, callId)"))
    }

    // -- a decline can no longer hang up an answered call ---------------------------

    @Test
    fun declineIsGatedOnTheRingStillBeingUp() {
        val body = functionBody(activity, "private\\s+fun\\s+decline\\s*\\(")
        val stop = body.indexOf("val wasRinging = IncomingRinger.stop(callId)")
        val gate = body.indexOf("if (!wasRinging && established)")
        val markers = body.indexOf("CallConnection.seedPendingReject(")
        assertTrue("decline must ask the ringer whether the call still rings:\n$body", stop >= 0)
        assertTrue("the gate must sit before the reject markers:\n$body", gate in (stop + 1) until markers)
        assertTrue("an established call must be spared:\n$body",
            body.substring(0, gate).contains("DisplacedConnectionPolicy.mayRelease"))
    }

    @Test
    fun backingOutOfTheRingerStopsItsOwnRing() {
        // A back press or a swipe from Recents destroys the activity; the ring
        // must not survive it, but only the ring of the call this screen showed.
        val body = functionBody(activity, "override\\s+fun\\s+onDestroy\\s*\\(")
        assertTrue("onDestroy must stop the ring keyed to shownCallId:\n$body", body.contains("IncomingRinger.stop(shownCallId)"))
        assertTrue("and only when this instance is the live one:\n$body",
            body.indexOf("currentInstance === this") in 0 until body.indexOf("IncomingRinger.stop(shownCallId)"))
    }

    @Test
    fun aStaleDeclineCannotRejectTheCallThatRingsNow() {
        val body = functionBody(activity, "private\\s+fun\\s+rejectRingingConnection\\s*\\(")
        assertTrue("rejectRingingConnection must compare the slot's callId:\n$body", body.contains("CallSlotPolicy.owns(connection.callId, callId)"))
        val gate = functionBody(activity, "private\\s+fun\\s+decline\\s*\\(").substringBefore("if (!wasRinging && established)")
        assertTrue("the established gate must be keyed to the declined call:\n$gate", gate.contains("it.callId == callId"))
    }

    @Test
    fun acceptStopsTheRingForItsCallBeforeAnythingElse() {
        val body = functionBody(activity, "private\\s+fun\\s+accept\\s*\\(")
        val stop = body.indexOf("IncomingRinger.stop(callId)")
        assertTrue(stop >= 0 && stop < body.indexOf("startActivity(appBootIntent)"))
    }

    // -- the lock screen ------------------------------------------------------------

    @Test
    fun mainActivityLiftsTheKeyguardOnANewIntentToo() {
        // singleTask: a warm process gets onNewIntent, not onCreate, and used
        // to leave the WebView stopped behind the keyguard after a lock-screen
        // accept.
        val body = functionBody(mainActivity, "override\\s+fun\\s+onNewIntent\\s*\\(")
        assertTrue("onNewIntent must lift the keyguard for a call accept:\n$body", body.contains("liftKeyguardForCallAccept(intent)"))
        assertTrue(body.contains("super.onNewIntent(intent)"))
        assertTrue(functionBody(mainActivity, "override\\s+fun\\s+onCreate\\s*\\(").contains("liftKeyguardForCallAccept(intent)"))
        val lift = functionBody(mainActivity, "private\\s+fun\\s+liftKeyguardForCallAccept\\s*\\(")
        assertTrue(lift.contains("push_call_accept") && lift.contains("setShowWhenLocked(true)") && lift.contains("requestDismissKeyguard"))
    }

    // -- Telecom's silence -----------------------------------------------------------

    @Test
    fun telecomSilenceQuietsTheRingWithoutEndingOrAnsweringTheCall() {
        // While a self-managed call rings, the system takes a volume-key press
        // for silenceRinger and forwards it as onSilence; the key never reaches
        // IncomingCallActivity, so its volumeControlStream cannot act.
        val body = functionBody(connectionService, "override\\s+fun\\s+onSilence\\s*\\(")
        assertTrue("onSilence must silence the ringer:\n$body", body.contains("IncomingRinger.silence()"))
        for (forbidden in listOf("IncomingRinger.stop", "stopAll", "cancelRingTimeout", "onReject", "setDisconnected", "setActive")) {
            assertFalse("onSilence must keep the call and both deadlines ($forbidden):\n$body", body.contains(forbidden))
        }
    }

    @Test
    fun silenceStopsTheSoundButNotTheDeadline() {
        val body = functionBody(ringer, "fun\\s+silence\\s*\\(")
        assertTrue("silence must stop the ringtone and vibration:\n$body", body.contains("stopHardware()"))
        assertFalse("silence must not retire the 30 s deadline:\n$body", body.contains("ledger.stop"))
        val arm = functionBody(ringer, "fun\\s+arm\\s*\\(")
        assertTrue("a re-armed silenced call must stay quiet:\n$arm", arm.contains("ledger.isSilenced(callId)"))
    }

    // -- helpers --------------------------------------------------------------------

    private fun functionBody(src: String, signaturePattern: String): String {
        val match = Regex("$signaturePattern[^{]*\\{").find(src) ?: error("Could not find /$signaturePattern/ in source")
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
