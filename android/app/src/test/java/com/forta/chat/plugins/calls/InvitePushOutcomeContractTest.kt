package com.forta.chat.plugins.calls

import org.junit.Assert.assertEquals
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

    @Test
    fun theStaleBranchShowsTheNoticeThroughThePolicyAndStillForwards() {
        val stale = service.indexOf("Stale call invite suppressed (S4)")
        val end = service.indexOf("return", stale)
        val branch = service.substring(stale, end)
        val policy = branch.indexOf("InvitePushPolicy.showsMissedCallNotice(")
        val notice = branch.indexOf("showMissedCallNotification(")
        assertTrue("the notice must be gated by the policy:\n$branch", policy >= 0 && notice > policy)
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
}
