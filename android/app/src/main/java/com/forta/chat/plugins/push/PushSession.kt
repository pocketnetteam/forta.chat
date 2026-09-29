package com.forta.chat.plugins.push

import android.content.Context

/**
 * Whether a push may reach the user, by the account state JS last reported.
 *
 * Logout used to leave the device's pusher on the homeserver, so a phone that
 * had signed out kept ringing for the old account (Pixel, TEST3, 2026-09-24).
 * JS now removes the pusher and deletes the FCM token on logout, but both need
 * the network; a logout made offline, or a push already in flight, still
 * lands here. JS marks the session logged out first, locally, and the FCM
 * service drops every push while it stays so.
 *
 * No state at all is an install that predates this flag, whose JS has not run
 * since the update: it is signed in as far as anyone knows, so its pushes are
 * delivered as before.
 */
object PushSessionPolicy {
    const val ACTIVE = "active"
    const val LOGGED_OUT = "logged_out"

    fun shouldDeliver(state: String?): Boolean = state != LOGGED_OUT
}

/** The session state behind [PushSessionPolicy], kept where a cold-started FCM service can read it. */
object PushSessionStore {
    private const val PREFS = "forta_push_session"
    private const val KEY_STATE = "state"

    fun read(context: Context): String? =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY_STATE, null)

    /**
     * Synchronous: the logout that writes [PushSessionPolicy.LOGGED_OUT] may be
     * followed at once by the user swiping the app away.
     */
    fun write(context: Context, state: String) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit()
            .putString(KEY_STATE, state)
            .commit()
    }
}

/**
 * The "Incoming calls" switch JS last reported (forta-bugs#1388). Off, the FCM
 * service drops call invites: no ringer, no reject, so Bastyon and the
 * account's other devices keep ringing. No value yet is an install whose JS
 * has not reported: calls ring as before.
 */
object IncomingCallsStore {
    private const val PREFS = "forta_push_session"
    private const val KEY_ENABLED = "incoming_calls_enabled"

    fun isEnabled(context: Context): Boolean =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getBoolean(KEY_ENABLED, true)

    fun write(context: Context, enabled: Boolean) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit()
            .putBoolean(KEY_ENABLED, enabled)
            .commit()
    }
}
