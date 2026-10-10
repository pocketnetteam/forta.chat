package com.forta.chat.plugins.calls

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Missed push calls (docs/plans/2026-10-10-missed-push-calls.md, T1): a call
 * invite that reached the phone after its lifetime used to be dropped with
 * nothing on screen. It now leaves a "missed call" notice — once per call,
 * and only for an invite that was stale; every other way the ringer stays
 * down keeps its own meaning and shows nothing.
 */
class InvitePushPolicyTest {

    @Test
    fun staleInviteShowsMissedCallNotice() {
        assertTrue(
            InvitePushPolicy.showsMissedCallNotice(
                InvitePushPolicy.Outcome.STALE, roomId = "!r:s", callId = "c1", lastNoticedCallId = null,
            )
        )
    }

    @Test
    fun aRetryOfTheSameStaleCallShowsNothingNew() {
        assertFalse(
            InvitePushPolicy.showsMissedCallNotice(
                InvitePushPolicy.Outcome.STALE, roomId = "!r:s", callId = "c1", lastNoticedCallId = "c1",
            )
        )
    }

    @Test
    fun aStaleInviteWithoutCallIdStillShowsTheNotice() {
        assertTrue(
            InvitePushPolicy.showsMissedCallNotice(
                InvitePushPolicy.Outcome.STALE, roomId = "!r:s", callId = null, lastNoticedCallId = null,
            )
        )
    }

    @Test
    fun noRoomNoNotice() {
        assertFalse(
            InvitePushPolicy.showsMissedCallNotice(
                InvitePushPolicy.Outcome.STALE, roomId = "", callId = "c1", lastNoticedCallId = null,
            )
        )
    }

    @Test
    fun otherOutcomesShowNoMissedCallNotice() {
        val others = InvitePushPolicy.Outcome.values().filter { it != InvitePushPolicy.Outcome.STALE }
        for (outcome in others) {
            assertFalse(
                outcome.name,
                InvitePushPolicy.showsMissedCallNotice(outcome, roomId = "!r:s", callId = "c1", lastNoticedCallId = null),
            )
        }
    }

    // Review 2026-10-10: the stale branch runs before the live-call check, so a
    // late copy of the invite for the call this device is in told the user
    // the call was missed in the middle of it.
    @Test
    fun aLateCopyOfTheCallThisDeviceHoldsShowsNoNotice() {
        assertFalse(
            InvitePushPolicy.showsMissedCallNotice(
                InvitePushPolicy.Outcome.STALE, roomId = "!r:s", callId = "c1", lastNoticedCallId = null, liveCallId = "c1",
            )
        )
    }

    @Test
    fun anotherCallInTelecomDoesNotHideTheNotice() {
        assertTrue(
            InvitePushPolicy.showsMissedCallNotice(
                InvitePushPolicy.Outcome.STALE, roomId = "!r:s", callId = "c2", lastNoticedCallId = null, liveCallId = "c1",
            )
        )
    }

    // Review 2026-10-10: a call another device of the user answered is not
    // missed. Its select_answer can trail the stale invite in the same flush.
    @Test
    fun answeredElsewhereRetractsTheNoticeForThatCallOnly() {
        assertTrue(InvitePushPolicy.retractsMissedCallNotice("m.call.select_answer", endedCallId = "c1", noticedCallId = "c1"))
        assertFalse(InvitePushPolicy.retractsMissedCallNotice("m.call.select_answer", endedCallId = "c2", noticedCallId = "c1"))
        assertFalse(InvitePushPolicy.retractsMissedCallNotice("m.call.select_answer", endedCallId = null, noticedCallId = "c1"))
        assertFalse(InvitePushPolicy.retractsMissedCallNotice("m.call.select_answer", endedCallId = "c1", noticedCallId = null))
        // The caller giving up or the invite timing out keeps it missed.
        assertFalse(InvitePushPolicy.retractsMissedCallNotice("m.call.hangup", endedCallId = "c1", noticedCallId = "c1"))
        assertFalse(InvitePushPolicy.retractsMissedCallNotice("m.call.reject", endedCallId = "c1", noticedCallId = "c1"))
    }

    @Test
    fun outcomesHaveStableWireNames() {
        assertEquals(
            listOf("rang", "stale", "signed-out", "incoming-calls-off", "established", "second-ring"),
            InvitePushPolicy.Outcome.values().map { it.wire },
        )
    }

    @Test
    fun priorityNames() {
        assertEquals("high", InvitePushPolicy.priorityName(1))
        assertEquals("normal", InvitePushPolicy.priorityName(2))
        assertEquals("unknown", InvitePushPolicy.priorityName(0))
        assertEquals("unknown", InvitePushPolicy.priorityName(null))
    }
}
