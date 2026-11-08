package com.forta.chat.plugins.calls

import android.media.AudioManager
import com.forta.chat.plugins.calls.CallTeardownPolicy.Action
import com.forta.chat.plugins.calls.CallTeardownPolicy.Reason
import com.forta.chat.plugins.calls.CallTeardownPolicy.State
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The decision table behind [CallTeardown]. Each row is a device state a
 * native end-of-call hook can observe; the policy must release the audio
 * session only when it was abandoned, and never on behalf of a call that is
 * still live or a mode that is not ours.
 */
class CallTeardownPolicyTest {

    private fun state(
        audioMode: Int? = AudioManager.MODE_NORMAL,
        otherCallLive: Boolean = false,
        fgsRunning: Boolean = false,
        routerActive: Boolean = false,
        markerOpen: Boolean = false,
        ringingCallId: String? = null,
        routerOwner: String? = null,
    ) = State(
        audioMode = audioMode,
        otherCallLive = otherCallLive,
        foregroundServiceRunning = fgsRunning,
        routerActive = routerActive,
        sessionMarkerOpen = markerOpen,
        ringingCallId = ringingCallId,
        routerOwnerCallId = routerOwner,
    )

    // -- the router owner (C02, native half) -----------------------------------

    @Test
    fun `a late disconnect of call A leaves the router call B owns without a slot`() {
        val actions = CallTeardownPolicy.decide(
            Reason.DISCONNECT,
            state(routerActive = true, fgsRunning = true, routerOwner = "call-B"),
            "call-A",
        )
        assertEquals(emptyList<Action>(), actions)
    }

    @Test
    fun `the owner's own disconnect still releases the router`() {
        val actions = CallTeardownPolicy.decide(
            Reason.DISCONNECT,
            state(routerActive = true, fgsRunning = true, routerOwner = "call-A"),
            "call-A",
        )
        assertEquals(listOf(Action.FORCE_STOP_ROUTER, Action.STOP_FOREGROUND_SERVICE), actions)
    }

    @Test
    fun `an unnamed teardown or a push event id cannot prove another owner`() {
        val owned = state(routerActive = true, routerOwner = "call-B")
        assertEquals(listOf(Action.FORCE_STOP_ROUTER), CallTeardownPolicy.decide(Reason.DISCONNECT, owned, null))
        assertEquals(listOf(Action.FORCE_STOP_ROUTER), CallTeardownPolicy.decide(Reason.REMOTE_HANGUP, owned, "\$event"))
    }

    @Test
    fun `cold start ignores a stale owner`() {
        val actions = CallTeardownPolicy.decide(Reason.COLD_START, state(routerActive = true, routerOwner = "call-B"), "call-A")
        assertEquals(listOf(Action.FORCE_STOP_ROUTER), actions)
    }

    // -- the ringer ------------------------------------------------------------

    @Test
    fun `a reject of the ringing call stops its ring`() {
        val actions = CallTeardownPolicy.decide(Reason.REJECT, state(ringingCallId = "call-1"), "call-1")
        assertEquals(listOf(Action.STOP_RINGER), actions)
    }

    @Test
    fun `a reject of another call leaves the ring alone`() {
        // The first call, displaced by the second, is disconnected while the
        // second one rings.
        val actions = CallTeardownPolicy.decide(Reason.DISCONNECT, state(ringingCallId = "call-2"), "call-1")
        assertEquals(emptyList<Action>(), actions)
    }

    @Test
    fun `a push hangup for the ringing call stops its ring`() {
        assertEquals(
            listOf(Action.STOP_RINGER),
            CallTeardownPolicy.decide(Reason.REMOTE_HANGUP, state(ringingCallId = "call-1"), "call-1"),
        )
    }

    @Test
    fun `a push hangup for another call leaves the ring alone`() {
        // A late hangup for a call that ended earlier, while the next one rings.
        assertEquals(
            emptyList<Action>(),
            CallTeardownPolicy.decide(Reason.REMOTE_HANGUP, state(ringingCallId = "call-2"), "call-1"),
        )
    }

    @Test
    fun `a push hangup that names no call and the cold start stop whatever rings`() {
        // Without call_id the push id is the hangup's own event id — no key to match.
        assertEquals(
            listOf(Action.STOP_RINGER),
            CallTeardownPolicy.decide(Reason.REMOTE_HANGUP, state(ringingCallId = "call-2"), "\$hangup-event"),
        )
        assertEquals(
            listOf(Action.STOP_RINGER),
            CallTeardownPolicy.decide(Reason.COLD_START, state(ringingCallId = "push-id"), null),
        )
    }

    @Test
    fun `an unknown ended id stops the ring too`() {
        assertEquals(
            listOf(Action.STOP_RINGER),
            CallTeardownPolicy.decide(Reason.REJECT, state(ringingCallId = "call-1"), ""),
        )
    }

    @Test
    fun `the ringer is stopped even while another call keeps the audio session`() {
        // A second incoming call rejected as BUSY: its ring stops, the live
        // call's router and service are untouched.
        val actions = CallTeardownPolicy.decide(
            Reason.REJECT,
            state(otherCallLive = true, routerActive = true, fgsRunning = true, ringingCallId = "call-2"),
            "call-2",
        )
        assertEquals(listOf(Action.STOP_RINGER), actions)
    }

    @Test
    fun `the ring stops before the audio session is released`() {
        val actions = CallTeardownPolicy.decide(
            Reason.DISCONNECT,
            state(routerActive = true, fgsRunning = true, ringingCallId = "call-1"),
            "call-1",
        )
        assertEquals(listOf(Action.STOP_RINGER, Action.FORCE_STOP_ROUTER, Action.STOP_FOREGROUND_SERVICE), actions)
    }

    @Test
    fun `silence means no ringer action`() {
        assertEquals(emptyList<Action>(), CallTeardownPolicy.decide(Reason.REJECT, state(), "call-1"))
    }

    @Test
    fun `the normal JS-driven hangup is a no-op`() {
        // stopAudioRouting already ran: router inactive, marker closed, mode
        // back to normal. The foreground service is still up because JS stops
        // it one step later — the policy must not stop it early.
        val actions = CallTeardownPolicy.decide(Reason.DISCONNECT, state(fgsRunning = true))
        assertEquals(emptyList<Action>(), actions)
    }

    @Test
    fun `a router left active is force-stopped and the service released`() {
        val actions = CallTeardownPolicy.decide(
            Reason.DISCONNECT,
            state(audioMode = AudioManager.MODE_IN_COMMUNICATION, fgsRunning = true, routerActive = true, markerOpen = true),
        )
        assertEquals(listOf(Action.FORCE_STOP_ROUTER, Action.STOP_FOREGROUND_SERVICE), actions)
    }

    @Test
    fun `router teardown comes before the service stop`() {
        val actions = CallTeardownPolicy.decide(
            Reason.REMOTE_HANGUP,
            state(routerActive = true, fgsRunning = true),
        )
        assertTrue(actions.indexOf(Action.FORCE_STOP_ROUTER) < actions.indexOf(Action.STOP_FOREGROUND_SERVICE))
    }

    @Test
    fun `an active router without a service is still force-stopped`() {
        val actions = CallTeardownPolicy.decide(Reason.REJECT, state(routerActive = true))
        assertEquals(listOf(Action.FORCE_STOP_ROUTER), actions)
    }

    @Test
    fun `a stranded VoIP mode with our marker open is adopted`() {
        val actions = CallTeardownPolicy.decide(
            Reason.COLD_START,
            state(audioMode = AudioManager.MODE_IN_COMMUNICATION, markerOpen = true),
        )
        assertEquals(listOf(Action.FORCE_STOP_ROUTER), actions)
    }

    @Test
    fun `a VoIP mode without our marker belongs to someone else`() {
        // Another app's live call sets the same global mode; with no marker
        // there is no evidence it is ours, and resetting it would silence them.
        for (reason in Reason.values()) {
            val actions = CallTeardownPolicy.decide(
                reason,
                state(audioMode = AudioManager.MODE_IN_COMMUNICATION, fgsRunning = false),
            )
            assertEquals("reason=$reason", emptyList<Action>(), actions)
        }
    }

    @Test
    fun `nothing global runs while another call owns the slot`() {
        for (reason in Reason.values()) {
            val actions = CallTeardownPolicy.decide(
                reason,
                state(
                    audioMode = AudioManager.MODE_IN_COMMUNICATION,
                    otherCallLive = true,
                    fgsRunning = true,
                    routerActive = true,
                    markerOpen = true,
                ),
            )
            assertEquals("reason=$reason", emptyList<Action>(), actions)
        }
    }

    @Test
    fun `MODE_RINGTONE is never reset, marker or not`() {
        for (reason in Reason.values()) {
            val actions = CallTeardownPolicy.decide(
                reason,
                state(audioMode = AudioManager.MODE_RINGTONE, markerOpen = true),
            )
            assertEquals("reason=$reason", emptyList<Action>(), actions)
        }
    }

    @Test
    fun `MODE_IN_CALL belongs to the cellular stack`() {
        val actions = CallTeardownPolicy.decide(
            Reason.COLD_START,
            state(audioMode = AudioManager.MODE_IN_CALL, markerOpen = true),
        )
        assertEquals(emptyList<Action>(), actions)
    }

    @Test
    fun `an unreadable mode counts as not stuck unless the router is active`() {
        assertEquals(
            emptyList<Action>(),
            CallTeardownPolicy.decide(Reason.DISCONNECT, state(audioMode = null, markerOpen = true)),
        )
        assertEquals(
            listOf(Action.FORCE_STOP_ROUTER),
            CallTeardownPolicy.decide(Reason.DISCONNECT, state(audioMode = null, routerActive = true)),
        )
    }

    @Test
    fun `an open marker with a normal mode has nothing to reset`() {
        // The marker is written before the mode on start(); a crash between
        // the two, or a mode the OS already reset, leaves nothing to adopt.
        val actions = CallTeardownPolicy.decide(Reason.COLD_START, state(markerOpen = true))
        assertEquals(emptyList<Action>(), actions)
    }
}
