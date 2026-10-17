package com.forta.chat.plugins.calls

import android.content.Context
import android.content.SharedPreferences

/**
 * The call each room's "missed call" notice was shown for
 * (docs/plans/2026-10-10-missed-push-calls.md, T1).
 *
 * The notice is shown once per call, and withdrawn when another device of the
 * user answered that call. Both need the call id of the notice after the FCM
 * service process is gone, and per room: process memory lost it on restart,
 * and a second room's notice overwrote the first's.
 */
class MissedCallNoticeStore(context: Context) {

    private val prefs: SharedPreferences =
        context.applicationContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    /** Call id of [roomId]'s notice, null when none or the invite had no call id. */
    fun noticedCallId(roomId: String): String? = prefs.getString(roomId, null)?.takeIf { it.isNotEmpty() }

    /** Record the notice shown for [callId] in [roomId]; a null id forgets the room's previous one. */
    fun remember(roomId: String, callId: String?) {
        // commit(): the FCM service process may die right after the push.
        if (callId.isNullOrEmpty()) prefs.edit().remove(roomId).commit()
        else prefs.edit().putString(roomId, callId).commit()
    }

    fun forget(roomId: String) {
        prefs.edit().remove(roomId).commit()
    }

    private companion object {
        const val PREFS_NAME = "forta_missed_call_notices"
    }
}
