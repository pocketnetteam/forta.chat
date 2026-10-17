package com.forta.chat.plugins.calls

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.telecom.*
import android.util.Log
import androidx.core.app.NotificationCompat
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import com.forta.chat.R

class CallConnectionService : ConnectionService() {

    companion object {
        private const val TAG = "CallConnectionService"
        /**
         * How long [releaseUnpresentedConnection] waits for the main looper.
         * Generous next to the work it guards (a state read and a disconnect)
         * and still far below any user-perceptible delay in offering the call.
         */
        private const val UNPRESENTED_RELEASE_TIMEOUT_MS = 2_000L
        const val INCOMING_CALL_NOTIFICATION_ID = 9999
        // Written from the main thread (Telecom callbacks) and read from
        // Capacitor's plugin thread (reportCallEnded / reportCallConnected) —
        // and since the displacement check now reads `previous.state` through
        // it, a stale reference could tear down the wrong call.
        @Volatile
        var currentConnection: CallConnection? = null

        fun getPhoneAccountHandle(context: Context): PhoneAccountHandle {
            val componentName = ComponentName(context, CallConnectionService::class.java)
            return PhoneAccountHandle(componentName, "BastyonChat")
        }

        fun registerPhoneAccount(context: Context) {
            val handle = getPhoneAccountHandle(context)
            // IMPORTANT: Do NOT change the PhoneAccountHandle id "BastyonChat" — it must remain
            // unchanged to avoid orphaning the already-registered phone account on app upgrade.
            // Only the display label "Forta Chat" may be updated.
            val account = PhoneAccount.builder(handle, "Forta Chat")
                .setCapabilities(PhoneAccount.CAPABILITY_SELF_MANAGED)
                .build()
            val telecomManager = context.getSystemService(Context.TELECOM_SERVICE) as TelecomManager
            telecomManager.registerPhoneAccount(account)
        }

        /**
         * Release a connection that has been RINGING past its deadline.
         *
         * Telecom holds `MODE_RINGTONE` — and with it the device's media
         * volume — for as long as a self-managed connection rings. The
         * per-connection timer is the primary backstop; this sweep is what
         * catches the cases where that timer never got to run (Doze, a wedged
         * main looper, a frozen process). Called when the app returns to the
         * foreground, which is exactly when a user who is staring at a broken
         * volume slider opens it.
         *
         * @return true when a connection was actually released.
         */
        fun releaseStaleRingingConnection(
            nowMs: Long = SystemClock.elapsedRealtime(),
        ): Boolean {
            val connection = currentConnection ?: return false
            val stale = StaleCallPolicy.isStaleRinging(
                isRinging = connection.state == Connection.STATE_RINGING,
                ringingSinceMs = connection.ringingSinceMs,
                nowMs = nowMs,
                timeoutMs = CallConnection.RING_TIMEOUT_MS,
            )
            if (!stale) return false
            Log.w(TAG, "Releasing a connection stuck RINGING past its deadline: ${connection.callId}")
            // onReject (not onDisconnect) so the caller is told we declined
            // and stops ringing on their side too.
            runCatching { connection.onReject() }
                .onFailure { Log.w(TAG, "stale-ring release threw", it) }
            return true
        }

        /**
         * Release a connection Telecom answered that JS never picked up.
         *
         * The second net behind the connection's own adoption backstop, for the
         * same reason [releaseStaleRingingConnection] backs the ring timeout: a
         * main-looper Handler can be held past its deadline by Doze or a frozen
         * process. [StaleCallPolicy.isUnadoptedAnswer] keeps it off a call JS
         * reported connected and off an answer still inside its window.
         *
         * `onDisconnect`, never `onReject`, as in [releaseOnTaskRemoved].
         *
         * @return true when a connection was actually released.
         */
        fun releaseUnadoptedAnswer(
            nowMs: Long = SystemClock.elapsedRealtime(),
        ): Boolean {
            val connection = currentConnection ?: return false
            val unadopted = StaleCallPolicy.isUnadoptedAnswer(
                isActive = connection.state == Connection.STATE_ACTIVE,
                answeredAtMs = connection.answeredAtMs,
                adoptedByJs = connection.adoptedByJs,
                nowMs = nowMs,
                timeoutMs = CallConnection.ANSWER_ADOPTION_TIMEOUT_MS,
            )
            if (!unadopted) return false
            Log.w(TAG, "Releasing an answered connection JS never picked up: ${connection.callId}")
            runCatching { connection.onDisconnect() }
                .onFailure { Log.w(TAG, "unadopted-answer release threw", it) }
            return true
        }

        /**
         * Release a connection nothing presents, so a new incoming call can be
         * added at all.
         *
         * Telecom refuses `addNewIncomingCall` while this app already holds a
         * RINGING self-managed call: it fails the request itself, before the
         * ConnectionService is consulted, so the displacement inside
         * [onCreateIncomingConnection] never gets the chance to run. Measured on
         * a Samsung SM-A528B — the new call is aborted the moment it is offered:
         *
         *     TC@41: WAITING_CALL, [[Call id=TC@40, state=RINGING …]]
         *     TC@41: CREATE_CONNECTION_FAILED
         *     Call: handleCreateConnectionFailure … Code: (CANCELED)
         *
         * Callers must have established that nothing presents this connection —
         * see [IncomingSurfacePolicy]. A connection someone can see or hear is
         * not ours to release here.
         *
         * `onDisconnect`, never `onReject`, for the same reason as
         * [releaseOnTaskRemoved] and with more at stake: onReject writes a
         * pendingReject marker, and the very next invite from this room is the
         * call we are clearing the way for — it would be declined unheard.
         */
        fun releaseUnpresentedConnection(): Boolean {
            // Decide and act in one main-looper message. The caller formed its
            // "nothing presents this connection" belief on Capacitor's plugin
            // thread, and the way that belief turns dangerous is `onAnswer`,
            // which runs *only* on the main looper — Telecom delivers it there
            // (a Bluetooth headset, Android Auto or the system call UI can
            // answer without ever touching our activity) and so does the
            // activity's own Accept button. Deciding on one thread and
            // disconnecting on the other loses a live call, because `onAnswer`
            // does not latch `released` and nothing further down would stop it.
            //
            // Teardown, unlike answering, does reach us off this looper
            // (`releaseStaleRingingConnection` from a plugin method, the FCM
            // handler from Firebase's thread). Those need no serialization: both
            // `onReject` and `onDisconnect` call `setDisconnected` before they
            // vacate the slot, so a slot still readable here always carries the
            // already-updated state and the re-check below refuses it.
            if (Looper.myLooper() == Looper.getMainLooper()) return releaseUnpresentedNow()
            val outcome = AtomicBoolean(false)
            val done = CountDownLatch(1)
            Handler(Looper.getMainLooper()).post {
                outcome.set(releaseUnpresentedNow())
                done.countDown()
            }
            // Bounded, and false on timeout: the caller is about to ask Telecom
            // to ring a new call, which Telecom refuses while this connection
            // holds the slot. Reporting failure is honest; blocking a plugin
            // thread indefinitely on the main looper is not.
            if (!done.await(UNPRESENTED_RELEASE_TIMEOUT_MS, TimeUnit.MILLISECONDS)) {
                Log.w(TAG, "Unpresented release did not reach the main thread in time")
                return false
            }
            return outcome.get()
        }

        /** Body of [releaseUnpresentedConnection]; main thread only. */
        private fun releaseUnpresentedNow(): Boolean {
            // Re-read rather than trusting the caller's snapshot: onReject and
            // onDisconnect vacate the slot, so a null here means the connection
            // is already gone and there is nothing to clear.
            val connection = currentConnection ?: return false
            if (!DisplacedConnectionPolicy.mayReleaseUnpresented(connection.state)) {
                Log.w(
                    TAG,
                    "Unpresented slot ${connection.callId} is no longer ringing " +
                        "(state=${connection.state}) — leaving it alone",
                )
                return false
            }
            Log.w(TAG, "Releasing an unpresented connection: ${connection.callId}")
            runCatching { connection.onDisconnect() }
                .onFailure { Log.w(TAG, "unpresented release threw", it) }
            // Outside the runCatching, as in releaseOnTaskRemoved: onDisconnect
            // short-circuits on its `released` latch and then clears nothing.
            // Reached only after the guards above, so this connection was still
            // ringing and still in the slot a moment ago on this same thread —
            // the teardown above is ours, and the markers being retired are the
            // ones it just orphaned, not a reject marker another path wrote.
            // Keyed by callId alone — this connection's markers are written under
            // its own id, and sweeping the room would take the incoming call's
            // markers with them (see 1c994c32).
            CallConnection.retirePendingMarkersForCall(connection.callId, null)
            return true
        }

        /**
         * End the call because the user swiped our task away.
         *
         * Every other stranded resource already got an owner in 00ddc636 —
         * the audio router, the peer connections, the foreground service. The
         * two that were missed are the two that do not live in a Service at
         * all: the Telecom connection and the pending markers, both reachable
         * only through process-global statics. A task removal destroys the
         * WebView, so Matrix signalling is gone and the call genuinely cannot
         * continue; leaving the connection ACTIVE instead parks Telecom in
         * MODE_IN_COMMUNICATION and makes every later call in this process
         * unringable — `ensureIncomingCallVisible` skips on a non-null slot and
         * `onCreateIncomingConnection` answers BUSY for an ACTIVE one.
         *
         * `onDisconnect`, never `onReject`: onReject writes a pendingReject
         * marker, which the next invite from this room would replay and decline
         * unheard. DisconnectCause.LOCAL is also the honest cause — we are the
         * side that went away.
         *
         * A RINGING connection is left alone. The foreground service only
         * exists for an answered or dialled call (`WebRTCPlugin.launchCallUI`
         * is its only starter), but the slot and the service are two
         * independently mutated statics, so they can briefly disagree: call A
         * ends and vacates the slot, call B rings in, and A's service is torn
         * down only afterwards. Releasing then would cut off a ring with
         * DisconnectCause.LOCAL — no reject marker, nothing told to the caller.
         * `armRingTimeout` already owns an unanswered ring, so leaving it is
         * both safe and bounded. Checking the state makes that guarantee
         * structural instead of resting on the two statics staying in step.
         *
         * @return true when a connection was actually released.
         */
        fun releaseOnTaskRemoved(): Boolean {
            val connection = currentConnection ?: return false
            if (connection.state == Connection.STATE_RINGING) {
                Log.d(TAG, "Task removed while a call was ringing — leaving it to the ring timeout")
                return false
            }
            Log.w(TAG, "Task removed while a connection was live — disconnecting ${connection.callId}")
            // The swipe destroyed the WebView, so the SDK will not tell the peer.
            // Before onDisconnect: its teardown forgets the target.
            val hangup = CallHangupSignal.take(connection.callId)
            if (hangup != null) {
                runCatching { CallHangupSignal.sendAsync(hangup) }
                    .onFailure { Log.w(TAG, "task-removed hangup send threw", it) }
            } else {
                Log.w(TAG, "no hangup target for ${connection.callId} — the peer learns of it from the connection")
            }
            runCatching { connection.onDisconnect() }
                .onFailure { Log.w(TAG, "task-removed release threw", it) }
            // Outside the runCatching on purpose: onDisconnect short-circuits on
            // its `released` latch and then clears nothing, and its
            // clearPendingFor covers only the answer half. The connection is
            // being destroyed either way, so no live call can still own these.
            CallConnection.retirePendingMarkersForCall(connection.callId, connection.roomId)
            return true
        }

        fun dismissIncomingCallNotification(context: Context) {
            val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            nm.cancel(INCOMING_CALL_NOTIFICATION_ID)
        }
    }

    override fun onCreateIncomingConnection(
        connectionManagerPhoneAccount: PhoneAccountHandle?,
        request: ConnectionRequest?
    ): Connection {
        val extras = request?.extras ?: Bundle()
        val callId = extras.getString("callId", "")
        val callerName = extras.getString("callerName", "Unknown")
        val hasVideo = extras.getBoolean("hasVideo", false)
        val roomId = extras.getString("roomId", "")

        Log.d(TAG, "onCreateIncomingConnection: callId=$callId, caller=$callerName, roomId=$roomId")

        // The caller's hangup can be handled between the invite push asking
        // Telecom for this connection and Telecom creating it: nothing was
        // there to dismiss then, and Telecom rang a dead call for 45 s.
        if (callId.isNotEmpty() && CancelledCallStore(this).isCancelled(callId)) {
            Log.i(TAG, "onCreateIncomingConnection: $callId was cancelled before it rang — not ringing")
            return Connection.createFailedConnection(DisconnectCause(DisconnectCause.MISSED, "cancelled"))
        }

        // A conversation in progress keeps the single slot. Evicting it — what
        // this did unconditionally — left it alive but unreachable: every
        // consumer reads the slot with no callId check (reportCallEnded,
        // reportCallConnected, the ringer's own decline), so that call could
        // never be ended again and Telecom would hold the device in a call
        // audio mode until reboot. While one slot is all there is, refusing the
        // second call is the honest answer: the new caller gets BUSY rather
        // than ringing into a void, and the live call stays endable.
        currentConnection?.let { previous ->
            if (!DisplacedConnectionPolicy.mayRelease(previous.state)) {
                Log.w(TAG, "Incoming call while a call is established — reporting busy")
                val busy = Connection.createFailedConnection(
                    DisconnectCause(DisconnectCause.BUSY, "already-in-call")
                )
                runCatching { busy.destroy() }
                return busy
            }
            // One call reaches Telecom twice while the app is alive: the FCM
            // service rings the push natively and JS, handed the same push,
            // reports the call again milliseconds later — before Telecom counts
            // the first as ringing, after which it refuses a second registration
            // on its own. Displacing the connection that already rings would
            // send callEnded for that very call into JS, so keep it and refuse
            // the duplicate. Presenting the ringer again is a no-op while it is
            // up (same callId) and brings it back where a later duplicate slips
            // through.
            if (DisplacedConnectionPolicy.isSameRingingCall(previous.callId, previous.state, callId)) {
                Log.w(TAG, "Duplicate incoming registration for $callId — keeping the connection that already rings")
                if (roomId.isNotEmpty()) {
                    runCatching {
                        com.forta.chat.FortaFirebaseMessagingService
                            .dismissPushCallNotification(applicationContext, roomId)
                    }
                }
                runCatching { showIncomingCallUI(callId, callerName, hasVideo, roomId) }
                    .onFailure { Log.e(TAG, "[callee-crash-guard] showIncomingCallUI failed", it) }
                val duplicate = Connection.createFailedConnection(
                    DisconnectCause(DisconnectCause.CANCELED, "duplicate-incoming")
                )
                runCatching { duplicate.destroy() }
                return duplicate
            }
        }

        // WEE-31: Telecom contract requires us to return a Connection here.
        // Any throw used to bubble up into the system_server bound IPC and
        // crash the callee process. Catch anything that can throw inside
        // the Connection bootstrap and return a failed Connection — the
        // caller's MatrixCall will get a reject and the user will still see
        // the push-side IncomingCallActivity ringer that was posted by FCM.
        return try {
            val connection = CallConnection(applicationContext, callId, roomId)
            connection.setCallerDisplayName(callerName, TelecomManager.PRESENTATION_ALLOWED)
            connection.setAddress(
                Uri.fromParts("sip", callerName, null),
                TelecomManager.PRESENTATION_ALLOWED
            )
            connection.setInitializing()
            connection.setRinging()

            // Releasing whatever sat here before is not optional: a connection
            // displaced from this single slot is unreachable by onReject and
            // onDisconnect forever, and Telecom keeps holding the device in a
            // call audio mode on its behalf until reboot. The established case
            // never reaches here — it returned BUSY above.
            currentConnection?.let { previous ->
                if (previous !== connection) {
                    Log.w(TAG, "Displacing a stale connection — disconnecting it first")
                    runCatching { previous.onDisconnect() }
                        .onFailure { Log.w(TAG, "displaced connection teardown threw", it) }
                }
            }
            currentConnection = connection
            connection.armRingTimeout()

            // Session 41: Telecom is about to post its own FSI ringer notification
            // (CHANNEL_INCOMING_CALLS, id 9999). The FCM service already posted
            // one on the push path (CallNotificationConfig.INCOMING_CALL_CHANNEL_ID,
            // "call_$roomId".hashCode()) — dismiss it now so we don't ring twice
            // from two different channels.
            if (roomId.isNotEmpty()) {
                runCatching {
                    com.forta.chat.FortaFirebaseMessagingService
                        .dismissPushCallNotification(applicationContext, roomId)
                }
            }

            // Show native incoming call UI
            runCatching { showIncomingCallUI(callId, callerName, hasVideo, roomId) }
                .onFailure { Log.e(TAG, "[callee-crash-guard] showIncomingCallUI failed", it) }

            connection
        } catch (t: Throwable) {
            Log.e(TAG, "[callee-crash-guard] onCreateIncomingConnection failed", t)
            // The Telecom framework requires a non-null Connection return,
            // but it will NOT auto-destroy a failed connection. Without
            // .destroy() the call slot stays occupied on some OEM Telecom
            // stacks, blocking subsequent calls (MIUI, EMUI). Release it
            // immediately — the framework still gets a Connection ref it
            // can route the disconnect cause through.
            val failed = Connection.createFailedConnection(
                DisconnectCause(DisconnectCause.ERROR, "incoming-connection-init-failed")
            )
            runCatching { failed.destroy() }
            failed
        }
    }

    override fun onCreateOutgoingConnection(
        connectionManagerPhoneAccount: PhoneAccountHandle?,
        request: ConnectionRequest?
    ): Connection {
        // placeCall's app extras arrive nested under EXTRA_OUTGOING_CALL_EXTRAS
        // (Telecom merges them into the request on most versions, not all);
        // read the nested bundle as well so the id is never lost.
        val extras = request?.extras ?: Bundle()
        val nested = extras.getBundle(TelecomManager.EXTRA_OUTGOING_CALL_EXTRAS) ?: Bundle()
        val callId = extras.getString("callId", "").ifEmpty { nested.getString("callId", "") }
        val callerName = extras.getString("callerName", "").ifEmpty { nested.getString("callerName", "") }

        Log.d(TAG, "onCreateOutgoingConnection: callId=$callId, callee=$callerName")

        val connection = CallConnection(applicationContext, callId)
        connection.setCallerDisplayName(callerName, TelecomManager.PRESENTATION_ALLOWED)
        connection.setAddress(
            request?.address ?: Uri.fromParts("sip", callerName, null),
            TelecomManager.PRESENTATION_ALLOWED
        )
        connection.setDialing()

        // Same displacement rule as the incoming path: a connection pushed out
        // of this single slot is unreachable by onReject and onDisconnect
        // forever, and Telecom keeps holding the device in a call audio mode on
        // its behalf. Placing a call while a previous one is still stuck in the
        // slot used to orphan it — the incoming side was fixed and this one was
        // not.
        //
        // Deliberately NOT gated on DisplacedConnectionPolicy, unlike the
        // incoming path: `startCall` in JS already refuses to dial while
        // `hasLiveCall`, so a connection still reading as established here is a
        // previous call whose teardown has not landed yet — the back-to-back
        // "hang up and immediately redial" race. Sparing it would restore
        // exactly the orphan this guard exists to close.
        currentConnection?.let { previous ->
            if (previous !== connection) {
                Log.w(TAG, "Displacing a connection on dial — disconnecting it first")
                runCatching { previous.onDisconnect() }
                    .onFailure { Log.w(TAG, "displaced connection teardown threw", it) }
            }
        }
        currentConnection = connection
        // Telecom took audio focus for this call before creating it; if the call
        // service already heard that as an interruption and muted the mic, undo it.
        CallForegroundService.onTelecomTookCall()
        return connection
    }

    override fun onCreateIncomingConnectionFailed(
        connectionManagerPhoneAccount: PhoneAccountHandle?,
        request: ConnectionRequest?
    ) {
        Log.e(TAG, "onCreateIncomingConnectionFailed")
    }

    override fun onCreateOutgoingConnectionFailed(
        connectionManagerPhoneAccount: PhoneAccountHandle?,
        request: ConnectionRequest?
    ) {
        Log.e(TAG, "onCreateOutgoingConnectionFailed")
    }

    private fun showIncomingCallUI(callId: String, callerName: String, hasVideo: Boolean, roomId: String) {
        val fullScreenIntent = Intent(applicationContext, IncomingCallActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or
                    Intent.FLAG_ACTIVITY_CLEAR_TOP or
                    Intent.FLAG_ACTIVITY_SINGLE_TOP
            putExtra("callId", callId)
            putExtra("callerName", callerName)
            putExtra("hasVideo", hasVideo)
            putExtra("roomId", roomId)
        }

        val fullScreenPendingIntent = PendingIntent.getActivity(
            applicationContext, 0, fullScreenIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        // Accept action. CLEAR_TOP|SINGLE_TOP deliver the tap to the ringer
        // already on screen through onNewIntent; a bare NEW_TASK started a
        // second IncomingCallActivity whenever the first was not on top of
        // its task, and that orphan kept ringing over the answered call and
        // rejected it 30 s later. roomId travels with it so the accept can
        // still dismiss the push notification and hand JS the room.
        val acceptIntent = Intent(applicationContext, IncomingCallActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or
                    Intent.FLAG_ACTIVITY_CLEAR_TOP or
                    Intent.FLAG_ACTIVITY_SINGLE_TOP
            putExtra("callId", callId)
            putExtra("callerName", callerName)
            putExtra("roomId", roomId)
            putExtra("hasVideo", hasVideo)
            putExtra("action", "accept")
        }
        val acceptPendingIntent = PendingIntent.getActivity(
            applicationContext, 1, acceptIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        // Decline action
        val declineIntent = Intent(applicationContext, IncomingCallActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or
                    Intent.FLAG_ACTIVITY_CLEAR_TOP or
                    Intent.FLAG_ACTIVITY_SINGLE_TOP
            putExtra("callId", callId)
            putExtra("callerName", callerName)
            putExtra("roomId", roomId)
            putExtra("hasVideo", hasVideo)
            putExtra("action", "decline")
        }
        val declinePendingIntent = PendingIntent.getActivity(
            applicationContext, 2, declineIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        // Create notification channel (Android 8+; channels do not exist below)
        val channelId = "incoming_calls"
        val notificationManager = applicationContext.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                channelId, applicationContext.getString(R.string.channel_incoming_calls),
                NotificationManager.IMPORTANCE_HIGH
            ).apply {
                description = applicationContext.getString(R.string.channel_incoming_calls_desc)
                setSound(null, null)
            }
            notificationManager.createNotificationChannel(channel)
        }

        // FSI permission check for Android 14+ (USE_FULL_SCREEN_INTENT)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            if (!notificationManager.canUseFullScreenIntent()) {
                Log.w(TAG, "USE_FULL_SCREEN_INTENT not granted, FSI will be heads-up only")
                // Try the ringer directly, but post the notification as well:
                // from a background or freshly woken process Android 10+ drops
                // this start without throwing, and the early return left the
                // call with no surface at all (the push notification was
                // already cancelled) — Telecom rang into nothing for 45 s.
                try {
                    applicationContext.startActivity(fullScreenIntent)
                } catch (e: Exception) {
                    Log.w(TAG, "Direct activity start failed", e)
                }
            }
        }

        val caller = androidx.core.app.Person.Builder()
            .setName(callerName)
            .setImportant(true)
            .build()

        val builder = NotificationCompat.Builder(applicationContext, channelId)
            .setSmallIcon(android.R.drawable.ic_menu_call)
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setFullScreenIntent(fullScreenPendingIntent, true)
            .setOngoing(true)
            .setAutoCancel(false)

        // Use CallStyle on Android 12+
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            builder.setStyle(
                NotificationCompat.CallStyle.forIncomingCall(
                    caller, declinePendingIntent, acceptPendingIntent
                )
            )
        } else {
            builder.setContentTitle(applicationContext.getString(R.string.push_incoming_call))
            builder.setContentText(callerName)
        }

        // WEE-31: notify() throws SecurityException on Android 13+ if the
        // user revoked POST_NOTIFICATIONS between channel creation and the
        // FCM-triggered ring. Don't crash — the direct startActivity below
        // is still attempted, and the FCM service path also posted its own
        // notification on the push-side channel.
        try {
            notificationManager.notify(INCOMING_CALL_NOTIFICATION_ID, builder.build())
        } catch (e: Throwable) {
            Log.e(TAG, "[callee-crash-guard] notificationManager.notify failed", e)
        }

        // Start activity directly for foreground case
        try {
            applicationContext.startActivity(fullScreenIntent)
        } catch (e: Throwable) {
            Log.w(TAG, "Could not start IncomingCallActivity directly", e)
        }
    }
}
