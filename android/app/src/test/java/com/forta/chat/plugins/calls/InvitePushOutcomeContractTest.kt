package com.forta.chat.plugins.calls

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * Pins the wiring of the missed-push-calls fixes (2026-10-10) in the FCM
 * service: every way a call invite push ends without a ringer leaves its
 * reason in the invite history, and only the stale one shows a missed-call
 * notice. The decisions themselves are unit-tested in [InvitePushPolicyTest].
 */
class InvitePushOutcomeContractTest {

    private fun source(relative: String): String {
        val candidates = listOf("src/main/java/$relative", "android/app/src/main/java/$relative")
        return candidates.map { File(it) }.firstOrNull { it.exists() }?.readText()
            ?: error("$relative not found. Tried: $candidates from ${File(".").absolutePath}")
    }

    private val service by lazy { source("com/forta/chat/FortaFirebaseMessagingService.kt") }
    private val pushData by lazy { source("com/forta/chat/plugins/push/PushDataPlugin.kt") }

    @Test
    fun everyOutcomeIsRecorded() {
        for (outcome in InvitePushPolicy.Outcome.values()) {
            assertTrue(
                "no recordInvite for ${outcome.name}",
                service.contains("recordInvite(message, InvitePushPolicy.Outcome.${outcome.name}"),
            )
        }
    }

    @Test
    fun theTrackerIsFedOnlyThroughRecordInvite() {
        assertEquals(1, Regex("inviteTracker\\.append\\(").findAll(service).count())
        val helper = service.indexOf("private fun recordInvite(")
        assertTrue(helper >= 0 && service.indexOf("inviteTracker.append(", helper) > helper)
    }

    private val helper by lazy {
        val start = service.indexOf("private fun maybeShowMissedCallNotice(")
        service.substring(start, service.indexOf("\n    }\n", start))
    }

    @Test
    fun theStaleBranchShowsTheNoticeThroughThePolicyAndStillForwards() {
        val stale = service.indexOf("Stale call invite suppressed (S4)")
        val end = service.indexOf("return", stale)
        val branch = service.substring(stale, end)
        assertTrue(branch, branch.contains("maybeShowMissedCallNotice(roomId, eventId, callId, sender, senderName, roomName)"))
        val policy = helper.indexOf("InvitePushPolicy.showsMissedCallNotice(")
        val notice = helper.indexOf("showMissedCallNotification(")
        assertTrue("the notice must be gated by the policy:\n$helper", policy >= 0 && notice > policy)
        assertTrue("JS still gets the push:\n$branch", branch.contains("forwardToJs(data)"))
    }

    @Test
    fun theNoticeHasItsOwnSlotAndAnswerElsewhereRetractsIt() {
        val show = service.indexOf("private fun showMissedCallNotification(")
        val showEnd = service.indexOf("\n    }\n", show)
        val body = service.substring(show, showEnd)
        assertTrue(body, body.contains("nm.notify(MISSED_CALL_TAG,") && !body.contains("nm.notify(NOTIF_TAG,"))
        val select = service.indexOf("answered on another device")
        val retract = service.indexOf("InvitePushPolicy.retractsMissedCallNotice(", select)
        val cancel = service.indexOf("cancelMissedCallNotice(", retract)
        assertTrue("select_answer must retract the notice", select >= 0 && retract > select && cancel > retract)
    }

    @Test
    fun theInviteLogCarriesTheFcmPriority() {
        val log = service.indexOf("Log.i(TAG, \"Call invite: callId=")
        val logEnd = service.indexOf(")\n", log)
        val line = service.substring(log, logEnd)
        assertTrue(line, line.contains("priority=") && line.contains("originalPriority="))
    }

    // Review 2026-10-10: the stale branch must know the call this device holds.
    @Test
    fun theNoticePassesTheLiveCallToThePolicy() {
        assertTrue(helper, helper.contains("liveCallId = CallConnectionService.currentConnection?.callId"))
    }

    // Review 2026-10-10: the push gateway sends a raw Matrix ID as the display
    // name when the sender has none; message titles already reject it.
    @Test
    fun theNoticeTitleGoesThroughTheTitleFallbackChain() {
        val show = helper.indexOf("showMissedCallNotification(")
        assertTrue(helper, show >= 0 && helper.indexOf("chooseNotificationTitle(", show) > show)
    }

    // Review 2026-10-10: the notice sits in the messages channel, so the launcher
    // badge counts it; opening the room must clear it with the message one.
    @Test
    fun openingTheRoomClearsTheMissedCallNotice() {
        val cancel = pushData.indexOf("fun cancelNotification(")
        val body = pushData.substring(cancel, pushData.indexOf("call.resolve()", cancel))
        assertTrue(
            body,
            body.contains("nm.cancel(FortaFirebaseMessagingService.MISSED_CALL_TAG, FortaFirebaseMessagingService.missedCallSlot(roomId))"),
        )
    }

    // Review 2026-10-10: hangup before the invite (Doze backlog) left no notice.
    @Test
    fun aStaleInviteForACancelledCallStillLeavesTheNotice() {
        val cancelled = service.indexOf("Suppressing invite for cancelled callId=")
        val branch = service.substring(cancelled, service.indexOf("return", cancelled))
        val decide = branch.indexOf("InvitePushPolicy.cancelledInviteIsMissed(")
        val show = branch.indexOf("maybeShowMissedCallNotice(")
        assertTrue(branch, decide >= 0 && show > decide && branch.contains(".wasHandled(callId)"))
        assertTrue("JS still gets the push:\n$branch", branch.contains("forwardToJs(data)"))
    }

    @Test
    fun aCallHandledHereOrElsewhereIsRememberedApartFromAnUnseenHangup() {
        val mark = service.indexOf("CancelledCallStore(this).markCancelled(endedCallId)")
        val after = service.substring(mark, service.indexOf("forwardToJs(data)", mark))
        assertTrue(after, after.contains("if (msgType != \"m.call.hangup\" || handledHere)") && after.contains(".markHandled(endedCallId)"))
        // handledHere is read before the teardown clears the ringer and the slot.
        val branch = service.indexOf("Call ended remotely (type=")
        val handled = service.indexOf("val handledHere =", branch)
        assertTrue(handled > branch && handled < service.indexOf("IncomingCallActivity.dismissIfShowing(endedCallId)", branch))
        val expr = service.substring(handled, service.indexOf("IncomingCallActivity.dismissIfShowing(endedCallId)", branch))
        assertTrue(expr, expr.contains("lastRingingCallId") && expr.contains("IncomingRinger.ringingCallId") && expr.contains("currentConnection?.callId"))
    }

    // Review 2026-10-10: the noticed call lived in process memory, one for the
    // whole app: a restart lost the retraction, and a second room overwrote it.
    @Test
    fun theNoticedCallIsKeptPerRoomOnDisk() {
        assertFalse("no process-memory notice state", service.contains("lastMissedNoticeCallId"))
        val select = service.indexOf("answered on another device")
        val retract = service.substring(select, service.indexOf("cancelMissedCallNotice(", select))
        assertTrue(retract, retract.contains("MissedCallNoticeStore(this).noticedCallId(roomId)"))
        assertTrue(helper, helper.contains("store.noticedCallId(roomId)") && helper.contains("store.remember(roomId, callId)"))
    }
}
