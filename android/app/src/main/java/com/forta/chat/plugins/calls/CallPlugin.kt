package com.forta.chat.plugins.calls

import android.content.Context
import android.content.Intent
import android.media.AudioDeviceInfo
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioRecord
import android.media.MediaRecorder
import android.os.Build
import android.os.Bundle
import android.telecom.TelecomManager
import android.util.Log
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.PermissionState
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.annotation.Permission
import com.getcapacitor.annotation.PermissionCallback

@CapacitorPlugin(
    name = "NativeCall",
    permissions = [
        Permission(
            strings = [android.Manifest.permission.RECORD_AUDIO],
            alias = "microphone"
        ),
        Permission(
            strings = [android.Manifest.permission.CAMERA],
            alias = "camera"
        )
    ]
)
class CallPlugin : Plugin() {

    companion object {
        private const val TAG = "CallPlugin"
        // Dedicated executor for routing teardown so the Capacitor plugin
        // thread is not blocked by AudioRouter.stop() — that path can wait
        // up to 500ms for the SCO_DISCONNECTED broadcast on API < 31, and
        // serializing every plugin call behind that wait risks ANRs on
        // slow OEMs (Xiaomi/Realme/INFINIX).
        private val cleanupExecutor: java.util.concurrent.ExecutorService =
            java.util.concurrent.Executors.newSingleThreadExecutor()
    }

    private var audioRouter: AudioRouter? = null

    /**
     * Exactly the three callbacks this plugin instance installed on
     * [CallConnection]'s companion. Kept so [handleOnDestroy] can clear its own
     * without stealing a newer instance's.
     */
    private var installedCallbacks:
        Triple<(String, String) -> Unit, (String, String) -> Unit, (String, String) -> Unit>? = null

    override fun load() {
        try {
            CallConnectionService.registerPhoneAccount(context)
        } catch (e: Exception) {
            Log.e(TAG, "Failed to register phone account", e)
        }

        // Cold-start sweep. The JS audio watchdog only runs on a resume
        // transition, so a process that died mid-call and comes back fresh
        // never checks the mode it left behind. The policy acts only on our
        // own persisted session marker — never on another app's live call —
        // and never touches MODE_RINGTONE, which Telecom releases itself when
        // the dead process's connections go with it.
        //
        // Once per process: load() runs again for every new bridge — the app
        // opened from a notification after exitApp or a task swipe left the
        // process alive — and the sweep stopped a ringer that was still ringing.
        if (ColdStartSweep.firstInProcess()) {
            runCatching {
                CallTeardown.endCall(context, CallTeardownPolicy.Reason.COLD_START, null)
            }.onFailure { Log.w(TAG, "cold-start teardown sweep threw", it) }
        }

        val onAnswered: (String, String) -> Unit = { callId, roomId ->
            notifyListeners("callAnswered", JSObject().apply {
                put("callId", callId)
                // Include roomId: on this homeserver the push payload has
                // the push event_id in place of the Matrix content.call_id,
                // so JS can't correlate by callId alone.
                //
                // It arrives as a parameter rather than being read out of
                // `CallConnection.pendingAnswer`. That global belongs to
                // whichever call last wrote a marker, and on the path where
                // IncomingCallActivity answers with no Telecom connection the
                // marker for THIS call is written a few statements after the
                // callback fires — so the read could pair the tapped call's id
                // with a previous call's room, and JS would arm its answer wait
                // against that room.
                put("roomId", roomId)
            })
        }
        // Both carry the room for the same reason callAnswered does: a
        // push-created connection is keyed by the push payload's call_id, which
        // this homeserver fills with the event_id, so its callId can never equal
        // the Matrix callId JS holds. Without the room JS cannot tell an event
        // about the call on screen from one about a call that already ended, and
        // acts on whichever call it happens to be holding.
        val onRejected: (String, String) -> Unit = { callId, roomId ->
            notifyListeners("callDeclined", JSObject().apply {
                put("callId", callId)
                put("roomId", roomId)
            })
        }
        val onEnded: (String, String) -> Unit = { callId, roomId ->
            notifyListeners("callEnded", JSObject().apply {
                put("callId", callId)
                put("roomId", roomId)
            })
        }
        CallConnection.onAnswered = onAnswered
        CallConnection.onRejected = onRejected
        CallConnection.onEnded = onEnded
        installedCallbacks = Triple(onAnswered, onRejected, onEnded)

        // Shared AudioRouter instance — same one CallActivity attaches its
        // UI listener to via setUiListener. Prior to Session 01 CallPlugin
        // and CallActivity each constructed their own AudioRouter; the two
        // competed on setCommunicationDevice/MODE_IN_COMMUNICATION and
        // silently undid each other's routing, producing #355/#442 symptoms.
        audioRouter = AudioRouter.getSharedInstance(context)
        audioRouter?.setCoreListener(object : AudioRouter.Listener {
            override fun onAudioDeviceChanged(state: AudioRouter.AudioDeviceState) {
                val data = JSObject().apply {
                    put("active", state.active.name.lowercase())
                    val devicesArray = org.json.JSONArray()
                    for (d in state.available) {
                        devicesArray.put(org.json.JSONObject().apply {
                            put("type", d.name.lowercase())
                            put("name", if (d == AudioRouter.Device.BLUETOOTH) {
                                audioRouter?.getBluetoothDeviceName() ?: "Bluetooth"
                            } else d.label)
                        })
                    }
                    put("devices", devicesArray)
                }
                notifyListeners("audioDevicesChanged", data)
            }
        })
    }

    /**
     * WEE-31: idempotent ringer-surface ensurer.
     *
     * Background: `handleIncomingCall` on Capacitor relies on the FCM push
     * handler (FortaFirebaseMessagingService) to have launched
     * IncomingCallActivity already. But when the app is in the foreground,
     * Matrix /sync delivers `m.call.invite` *before* FCM does, so the push
     * handler never fires and no ringer surface is shown — the user hears
     * nothing and the caller is stuck on "connecting" until their timeout.
     *
     * This plugin method checks whether either the full-screen activity or
     * the Telecom CallConnection is already up. If neither is, it goes
     * through the normal `reportIncomingCall` path (Telecom add → fallback
     * direct activity launch) so the user actually sees the call.
     *
     * Safe to call unconditionally from JS — it's a no-op when a ringer is
     * already present.
     */
    /**
     * Telecom's callbacks are process-global statics; this plugin instance is not.
     * When the activity goes away — the OS reclaiming it mid-call, or
     * `MainActivity.recreate()` recovering from a dead WebView renderer — leaving
     * them pointed here sends a native Accept into a Bridge that is being torn
     * down, instead of letting it take the marker-replay path `onAnswer` already
     * prepared for exactly this case ("JS listener not wired, queued for replay").
     *
     * Cleared by identity: during a recreate the incoming instance may already
     * have installed its own, and clearing those would silence a live plugin.
     */
    override fun handleOnDestroy() {
        // The bridge — and with it the WebView that runs the Matrix call — is
        // going: renderer-death recreate(), a system destroy, exitApp. The JS
        // call cannot survive it (WebRTCPlugin disposes the peer connections),
        // but a live Telecom connection did: every later call hit the busy
        // path while the process lived. Release it as a task removal does,
        // telling the peer natively; a ringing call is left to its ringer.
        if (activity?.isChangingConfigurations != true) {
            val released = runCatching { CallConnectionService.releaseOnTaskRemoved() }.getOrDefault(false)
            if (released) Log.w(TAG, "Bridge destroyed with a live call — released it")
        }
        installedCallbacks?.let { (answered, rejected, ended) ->
            if (CallConnection.onAnswered === answered) CallConnection.onAnswered = null
            if (CallConnection.onRejected === rejected) CallConnection.onRejected = null
            if (CallConnection.onEnded === ended) CallConnection.onEnded = null
        }
        installedCallbacks = null
        super.handleOnDestroy()
    }

    @PluginMethod
    fun ensureIncomingCallVisible(call: PluginCall) {
        val slot = CallConnectionService.currentConnection
        val alreadyVisible = IncomingSurfacePolicy.isAlreadyVisibleFor(
            requestedCallId = call.getString("callId"),
            activityUp = IncomingCallActivity.currentInstance != null,
            slotCallId = slot?.callId,
            slotState = slot?.state,
            ringingCallId = IncomingRinger.ringingCallId,
        )
        if (alreadyVisible) {
            Log.d(TAG, "ensureIncomingCallVisible: ringer already up, skip")
            call.resolve()
            return
        }
        if (slot != null) {
            // Nothing presents this connection — no activity, no armed ringer —
            // so it is an orphan holding the single slot. It has to go before we
            // offer the new call: Telecom refuses addNewIncomingCall outright
            // while this app holds a RINGING self-managed call, failing it before
            // onCreateIncomingConnection (where displacement lives) ever runs.
            Log.w(TAG, "ensureIncomingCallVisible: releasing an unpresented slot ${slot.callId}")
            // A refusal is not a reason to give up on the new call: the slot may
            // have been vacated by its own teardown in the meantime, in which
            // case Telecom will accept the call anyway. Worth logging, because
            // it is also what a connection that went live under us looks like.
            if (!CallConnectionService.releaseUnpresentedConnection()) {
                Log.w(TAG, "ensureIncomingCallVisible: the unpresented slot was not released")
            }
        }
        Log.d(TAG, "ensureIncomingCallVisible: no ringer present, launching")
        // Delegate to the existing reportIncomingCall path so we share the
        // Telecom-add + activity-launch fallback chain.
        reportIncomingCall(call)
    }

    @PluginMethod
    fun reportIncomingCall(call: PluginCall) {
        val callId = call.getString("callId") ?: ""
        val callerName = call.getString("callerName") ?: "Unknown"
        val roomId = call.getString("roomId") ?: ""
        val hasVideo = call.getBoolean("hasVideo", false) ?: false

        Log.d(TAG, "reportIncomingCall: $callerName ($callId)")

        // The push path skips an invite for a call whose hangup/reject/answer it
        // has already seen; this path must too. An invite push queued for a
        // paused page reaches JS after the hangup push tore the ringer down, and
        // registering it again rang a dead call for 30 s (`dual0`, 2026-09-18).
        if (callId.isNotEmpty() && CancelledCallStore(context).isCancelled(callId)) {
            Log.d(TAG, "reportIncomingCall($callId): the call already ended — not ringing")
            call.resolve()
            return
        }

        try {
            val telecomManager = context.getSystemService(TelecomManager::class.java)
            val handle = CallConnectionService.getPhoneAccountHandle(context)

            val extras = Bundle().apply {
                putString("callId", callId)
                putString("callerName", callerName)
                putString("roomId", roomId)
                putBoolean("hasVideo", hasVideo)
                putParcelable(TelecomManager.EXTRA_PHONE_ACCOUNT_HANDLE, handle)
            }

            telecomManager.addNewIncomingCall(handle, extras)
            call.resolve()
        } catch (e: Throwable) {
            // WEE-31 (H1): addNewIncomingCall throws SecurityException on
            // mobile-only devices where the PhoneAccount registration was
            // rejected, and IllegalArgumentException on Telecom-restricted
            // tablets. Both used to bubble out of this @PluginMethod and
            // process-kill the callee. Fall back to a direct activity
            // launch — same UX, no Telecom integration. roomId / hasVideo
            // must be forwarded so accept() can resolve the Matrix room.
            Log.e(TAG, "[callee-crash-guard] Failed to report incoming call via Telecom, falling back", e)
            try {
                val intent = Intent(context, IncomingCallActivity::class.java).apply {
                    flags = Intent.FLAG_ACTIVITY_NEW_TASK
                    putExtra("callId", callId)
                    putExtra("callerName", callerName)
                    putExtra("roomId", roomId)
                    putExtra("hasVideo", hasVideo)
                }
                context.startActivity(intent)
            } catch (e2: Throwable) {
                // Android 12+ background-start restriction may also block
                // the direct startActivity. The FCM service still posted a
                // ringer notification — the user can tap the heads-up to
                // get the same UI through a foreground PendingIntent path.
                Log.e(TAG, "[callee-crash-guard] Direct IncomingCallActivity launch also blocked", e2)
            }
            call.resolve()
        }
    }

    @PluginMethod
    fun reportOutgoingCall(call: PluginCall) {
        val callId = call.getString("callId") ?: ""
        val callerName = call.getString("callerName") ?: ""
        val hasVideo = call.getBoolean("hasVideo", false) ?: false

        Log.d(TAG, "reportOutgoingCall: $callerName ($callId)")
        captureHangupTarget(callId)

        try {
            val telecomManager = context.getSystemService(TelecomManager::class.java)
            val handle = CallConnectionService.getPhoneAccountHandle(context)

            // Telecom hands a ConnectionService only the bundle nested under
            // EXTRA_OUTGOING_CALL_EXTRAS; keys put straight into placeCall's
            // extras never reach onCreateOutgoingConnection. That is why every
            // outgoing Connection used to log "callId=" and could not be
            // matched by id — every keyed teardown treated it as another call.
            val callExtras = Bundle().apply {
                putString("callId", callId)
                putString("callerName", callerName)
                putBoolean("hasVideo", hasVideo)
            }
            val extras = Bundle().apply {
                putParcelable(TelecomManager.EXTRA_PHONE_ACCOUNT_HANDLE, handle)
                putBundle(TelecomManager.EXTRA_OUTGOING_CALL_EXTRAS, callExtras)
            }

            telecomManager.placeCall(
                android.net.Uri.fromParts("sip", callerName, null),
                extras
            )
            call.resolve()
        } catch (e: Exception) {
            Log.e(TAG, "Failed to place outgoing call via TelecomManager, falling back", e)
            // Fallback: create connection directly (won't get system audio routing)
            val connection = CallConnection(context, callId)
            connection.setCallerDisplayName(callerName, TelecomManager.PRESENTATION_ALLOWED)
            connection.setAddress(
                android.net.Uri.fromParts("sip", callerName, null),
                TelecomManager.PRESENTATION_ALLOWED
            )
            connection.setDialing()
            // Same displacement rule as CallConnectionService's outgoing path,
            // including why it is unconditional there: this is a dial, and JS
            // will not dial while a call is live, so anything still in the slot
            // is a leftover.
            CallConnectionService.currentConnection?.let { previous ->
                if (previous !== connection) {
                    runCatching { previous.onDisconnect() }
                        .onFailure { Log.w(TAG, "displaced connection teardown threw", it) }
                }
            }
            CallConnectionService.currentConnection = connection
            call.resolve()
        }
    }

    @PluginMethod
    fun reportCallEnded(call: PluginCall) {
        val callId = call.getString("callId")
        // Before the connection work and whatever the slot holds: when /sync
        // beats FCM to the hangup this is the only path that runs, and the FCM
        // branch that used to be the sole caller of dismissIfShowing never
        // fires. A null connection must not swallow the dismiss either, or the
        // ringer keeps playing for a call that is already over. Keyed on the
        // reported call, so finalizing a stale invite leaves the call that
        // rings now alone.
        IncomingCallActivity.dismissIfShowing(callId)
        // onDisconnect vacates the slot itself, identity-guarded. Clearing it
        // again here is not just redundant: this method runs on Capacitor's
        // plugin thread while Telecom assigns a new connection on the main
        // thread, so an unconditional null can land between the assignment for
        // the *next* call and anything that reads it — leaving that call with
        // no Connection to answer, and its own ring backstop hanging it up 45
        // seconds after the user picked up.
        val slot = CallConnectionService.currentConnection
        if (slot != null && !CallSlotPolicy.owns(slot.callId, callId)) {
            // The slot holds a different call — ending it here is how a
            // refused second invite used to hang up the conversation.
            Log.w(TAG, "reportCallEnded($callId): slot holds ${slot.callId}, leaving it")
        } else {
            slot?.onDisconnect()
        }
        call.resolve()
    }

    /** How long the page gets to install its provider before the capture is retried. */
    private val CAPTURE_RETRY_MS = 2_000L

    /**
     * Reads the context native code needs to hang up [callId] itself if a task
     * swipe destroys the WebView mid-call ([CallHangupSignal]). Taken while
     * dialling and again once connected — the client may have failed over to
     * another homeserver mirror in between.
     */
    private fun captureHangupTarget(callId: String?, retriesLeft: Int = 1) {
        if (callId.isNullOrEmpty()) return
        val bridge = bridge ?: return
        CallHangupSignal.attach(context)
        bridge.executeOnMainThread {
            runCatching {
                bridge.webView.evaluateJavascript(CallHangupSignal.captureScript(callId)) { result ->
                    val target = CallHangupSignal.parse(result)?.takeIf { it.callId == callId }
                    if (target != null) {
                        CallHangupSignal.remember(target)
                        Log.d(TAG, "hangup target ready: $target")
                    } else if (retriesLeft > 0) {
                        // The page can still be starting when a dial lands right
                        // after a cold start (`hswipe1`, first call after install).
                        Log.d(TAG, "no hangup context from JS for $callId yet — retrying")
                        bridge.webView.postDelayed(
                            { captureHangupTarget(callId, retriesLeft - 1) },
                            CAPTURE_RETRY_MS,
                        )
                    } else {
                        Log.w(TAG, "no hangup context from JS for $callId")
                    }
                }
            }.onFailure { Log.w(TAG, "captureHangupTarget($callId) threw", it) }
        }
    }

    @PluginMethod
    fun reportCallConnected(call: PluginCall) {
        // setActive() here bypasses CallConnection.onAnswer(), so the silencing
        // that lives there does not cover this route. JS reaches it whenever the
        // call connects without Telecom having answered it itself. Keyed by the
        // call that connected: a ring already rebound to the next call stays.
        val callId = call.getString("callId")
        IncomingCallActivity.stopRingerIfShowing(callId)
        captureHangupTarget(callId)
        val connection = CallConnectionService.currentConnection?.takeIf { slot ->
            CallSlotPolicy.owns(slot.callId, callId).also { owns ->
                if (!owns) Log.w(TAG, "reportCallConnected($callId): slot holds ${slot.callId}, leaving it")
            }
        }
        // A slot created from a push is keyed by the push's `$event_id`; its
        // own onDisconnect stops the foreground service under that id, and
        // the ledger only knows the Matrix id launchCallUI recorded.
        connection?.let { CallForegroundService.aliasCall(it.callId, callId) }
        connection?.setActive()
        // Answered here through JS, which skips onAnswer: a stale copy of the
        // invite must not show "missed call". The push's call_id is the Matrix
        // id; a slot made from a push is keyed by the event id.
        runCatching {
            val store = CancelledCallStore(context)
            callId?.takeIf { it.isNotEmpty() }?.let { store.markHandled(callId) }
            connection?.callId?.takeIf { it.isNotEmpty() && it != callId }?.let { slotId -> store.markHandled(slotId) }
        }.onFailure { Log.w(TAG, "could not mark $callId handled", it) }
        // The answer has been picked up: disarm the backstop that releases a
        // connection Telecom answered while JS was not there.
        connection?.markAdoptedByJs()
        // The answer is on the wire now — JS only reaches here from the
        // connected state — so the marker has nothing left to carry. It exists
        // only to replay a decision across a process that was not alive to send
        // it; kept until finalizeCall instead, it sat there for the whole call
        // and outlived it entirely whenever teardown never ran (a task swipe),
        // which is how a later call from the same room got answered unattended.
        //
        // Retired here rather than from JS because the key must be the
        // connection's own: a marker written from a push is keyed by the
        // event_id, so a JS-side retire carrying the Matrix callId would be
        // inert on exactly the path that matters most.
        //
        // By callId alone, never by room. Any marker belonging to this
        // connection was written under this connection's id — onAnswer and
        // IncomingCallActivity both use it — so the room buys nothing here, and
        // a room-scoped retire from native code would be a guess: only JS knows
        // whether another call is live in that room. A second invite for the
        // same room still reaches the push-side ringer even while Telecom
        // answers it BUSY, and declining it writes a marker this would
        // otherwise wipe before JS ever read it.
        connection?.let { CallConnection.retirePendingMarkersForCall(it.callId, null) }
        // Same reason as CallConnection.onAnswer: the push notification's
        // Decline button must not outlive the ring.
        connection?.roomId?.takeIf { it.isNotEmpty() }?.let { roomId ->
            runCatching {
                com.forta.chat.FortaFirebaseMessagingService.dismissPushCallNotification(context, roomId)
            }
        }
        call.resolve()
    }

    @PluginMethod
    fun requestAudioPermission(call: PluginCall) {
        if (getPermissionState("microphone") == PermissionState.GRANTED) {
            call.resolve(JSObject().apply { put("granted", true) })
            return
        }
        requestPermissionForAlias("microphone", call, "audioPermissionCallback")
    }

    /**
     * Real-stream probe for the microphone, to be called by JS right after
     * `requestAudioPermission` resolved with `granted=true`. The Capacitor
     * permission check only reports the Android package-level state and
     * will happily say `granted` if permission was granted at any point in
     * this process's lifetime — even if another app (phone dialer, voice
     * recorder) currently holds AudioRecord, or the OEM firmware gave us a
     * ghost permission that AudioRecord will nevertheless reject.
     *
     * We:
     *   1. Enumerate input devices via AudioManager.getDevices — catches the
     *      "no mic attached" case (rare, but happens on Chromebook tablets
     *      and a handful of older Android TV boxes).
     *   2. Try to initialize an AudioRecord with VOICE_COMMUNICATION source at
     *      16 kHz mono PCM. If it reports STATE_INITIALIZED we can safely
     *      proceed; anything else means the actual mic acquisition will fail
     *      and call setup should abort before sending invite/answer.
     *   3. On API 29+ we also enumerate active recording configurations so
     *      the UI can hint which app is holding the mic.
     *
     * Returns `{available, hasInput, canInit, conflicting[]}`. The JS side
     * throws PermissionDeniedError with reason=audio_source_busy or
     * no_input_device based on which flag is false.
     */
    @PluginMethod
    fun probeAudioAvailability(call: PluginCall) {
        try {
            val am = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
            val inputs = am.getDevices(AudioManager.GET_DEVICES_INPUTS)
            val hasInputDevice = inputs.any { info ->
                info.type == AudioDeviceInfo.TYPE_BUILTIN_MIC ||
                info.type == AudioDeviceInfo.TYPE_WIRED_HEADSET ||
                info.type == AudioDeviceInfo.TYPE_WIRED_HEADPHONES ||
                info.type == AudioDeviceInfo.TYPE_BLUETOOTH_SCO ||
                info.type == AudioDeviceInfo.TYPE_USB_HEADSET ||
                info.type == AudioDeviceInfo.TYPE_USB_DEVICE
            }

            val canInit = tryInitAudioRecord()

            // Enumerate active recording configurations so JS can surface
            // "X app is using your microphone" instead of a generic error.
            // Only meaningful on Android 10 (API 29)+.
            val conflicting = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                am.activeRecordingConfigurations
                    .mapNotNull { config ->
                        // Own app's package isn't exposed here (API surface
                        // limitation: `clientPackageName` is hidden). We
                        // still pass audio source as a hint — "VOICE_CALL"
                        // means the phone app, "MIC" means a generic
                        // recorder, etc.
                        audioSourceLabel(config.clientAudioSource)
                    }
                    .filter { it.isNotEmpty() }
                    .distinct()
            } else emptyList()

            val result = JSObject().apply {
                put("available", hasInputDevice && canInit)
                put("hasInput", hasInputDevice)
                put("canInit", canInit)
                val arr = org.json.JSONArray()
                for (c in conflicting) arr.put(c)
                put("conflicting", arr)
            }
            Log.d(
                TAG,
                "[WebRTCAudio] probeAudioAvailability: hasInput=$hasInputDevice canInit=$canInit conflicting=$conflicting"
            )
            call.resolve(result)
        } catch (e: Exception) {
            // Failure to probe should not itself block the call. JS treats
            // an error as "assume available" (same shape as the old bridge),
            // matching requestAudioPermission's graceful fallback style.
            Log.w(TAG, "probeAudioAvailability failed — returning optimistic result", e)
            call.resolve(JSObject().apply {
                put("available", true)
                put("hasInput", true)
                put("canInit", true)
                put("conflicting", org.json.JSONArray())
            })
        }
    }

    private fun tryInitAudioRecord(): Boolean {
        var rec: AudioRecord? = null
        return try {
            val sampleRate = 16_000
            val bufSize = AudioRecord.getMinBufferSize(
                sampleRate,
                AudioFormat.CHANNEL_IN_MONO,
                AudioFormat.ENCODING_PCM_16BIT,
            )
            if (bufSize <= 0) {
                Log.w(TAG, "tryInitAudioRecord: getMinBufferSize returned $bufSize — treating as not-available")
                return false
            }
            rec = AudioRecord(
                MediaRecorder.AudioSource.VOICE_COMMUNICATION,
                sampleRate,
                AudioFormat.CHANNEL_IN_MONO,
                AudioFormat.ENCODING_PCM_16BIT,
                bufSize,
            )
            val ok = rec.state == AudioRecord.STATE_INITIALIZED
            if (!ok) Log.w(TAG, "tryInitAudioRecord: state=${rec.state}, mic is busy or unavailable")
            ok
        } catch (e: Exception) {
            Log.w(TAG, "tryInitAudioRecord threw", e)
            false
        } finally {
            try { rec?.release() } catch (_: Exception) {}
        }
    }

    private fun audioSourceLabel(source: Int): String = when (source) {
        MediaRecorder.AudioSource.VOICE_CALL -> "voice_call"
        MediaRecorder.AudioSource.VOICE_COMMUNICATION -> "voice_communication"
        MediaRecorder.AudioSource.VOICE_RECOGNITION -> "voice_recognition"
        MediaRecorder.AudioSource.MIC -> "mic"
        MediaRecorder.AudioSource.CAMCORDER -> "camcorder"
        MediaRecorder.AudioSource.DEFAULT -> "default"
        else -> "other_$source"
    }

    @PermissionCallback
    private fun audioPermissionCallback(call: PluginCall) {
        val granted = getPermissionState("microphone") == PermissionState.GRANTED
        Log.d(TAG, "[WebRTCAudio] requestAudioPermission callback: granted=$granted")
        call.resolve(JSObject().apply { put("granted", granted) })
    }

    @PluginMethod
    fun requestCameraPermission(call: PluginCall) {
        if (getPermissionState("camera") == PermissionState.GRANTED) {
            call.resolve(JSObject().apply { put("granted", true) })
            return
        }
        requestPermissionForAlias("camera", call, "cameraPermissionCallback")
    }

    @PermissionCallback
    private fun cameraPermissionCallback(call: PluginCall) {
        val granted = getPermissionState("camera") == PermissionState.GRANTED
        Log.d(TAG, "[WebRTCAudio] requestCameraPermission callback: granted=$granted")
        call.resolve(JSObject().apply { put("granted", granted) })
    }

    @PluginMethod
    fun getAudioDevices(call: PluginCall) {
        val router = audioRouter ?: run {
            call.reject("AudioRouter not initialized")
            return
        }
        val state = router.getState()
        val result = JSObject().apply {
            put("active", state.active.name.lowercase())
            val devicesArray = org.json.JSONArray()
            for (d in state.available) {
                devicesArray.put(org.json.JSONObject().apply {
                    put("type", d.name.lowercase())
                    put("name", if (d == AudioRouter.Device.BLUETOOTH) {
                        router.getBluetoothDeviceName() ?: "Bluetooth"
                    } else d.label)
                })
            }
            put("devices", devicesArray)
        }
        call.resolve(result)
    }

    @PluginMethod
    fun setAudioDevice(call: PluginCall) {
        val type = call.getString("type") ?: run {
            call.reject("Missing type")
            return
        }
        val device = when (type.lowercase()) {
            "earpiece" -> AudioRouter.Device.EARPIECE
            "speaker" -> AudioRouter.Device.SPEAKER
            "bluetooth" -> AudioRouter.Device.BLUETOOTH
            "wired_headset" -> AudioRouter.Device.WIRED_HEADSET
            else -> {
                call.reject("Unknown device type: $type")
                return
            }
        }
        // A refusal reaches JS as a reject so the toggle can roll back
        // instead of showing a loudspeaker that is not on.
        if (audioRouter?.setDevice(device) == true) {
            call.resolve()
        } else {
            call.reject("Audio routing inactive — $type not applied", "router_inactive")
        }
    }

    @PluginMethod
    fun startAudioRouting(call: PluginCall) {
        val callType = call.getString("callType") ?: "voice"
        // C02: the router remembers which call owns it; a stop for another call is dropped.
        audioRouter?.start(callType, call.getString("callId"))

        // Session 31 (#644): bind MainActivity's hardware volume keys to
        // STREAM_VOICE_CALL for the duration of the call. CallActivity sets
        // its own volumeControlStream in onCreate(), but the user can navigate
        // back to the Vue/MainActivity surface (e.g. minimised call window)
        // and still expect the volume rocker to control the call. Per-Activity
        // setting, applied on the UI thread.
        bridge?.activity?.let { activity ->
            activity.runOnUiThread {
                activity.volumeControlStream = AudioManager.STREAM_VOICE_CALL
            }
        }
        call.resolve()
    }

    @PluginMethod
    fun stopAudioRouting(call: PluginCall) {
        // Dispatch to a dedicated executor so the Capacitor plugin thread
        // is freed immediately. AudioRouter.stop() blocks up to 500ms
        // waiting for SCO_DISCONNECTED on API < 31; running it on the
        // plugin thread would serialize every other native call (push,
        // status bar, share) and risk ANRs.
        val callId = call.getString("callId")
        cleanupExecutor.execute {
            // C02: false when another call owns the router — leave its volume binding alone too.
            val stopped = try {
                audioRouter?.stop(callId) ?: true
            } catch (e: Exception) {
                Log.e(TAG, "stopAudioRouting threw", e)
                true
            }
            if (!stopped) {
                call.resolve()
                return@execute
            }

            // Session 31 (#644): restore the activity's volume rocker AFTER
            // AudioRouter.stop() has flipped the system back to MODE_NORMAL.
            // Done in this order so a volume-key press during the teardown
            // window still lands on STREAM_VOICE_CALL while the call is
            // technically alive — flipping it earlier would lose the binding
            // mid-call. Posted to the UI thread because volumeControlStream
            // must be touched there.
            bridge?.activity?.let { activity ->
                activity.runOnUiThread {
                    activity.volumeControlStream = AudioManager.USE_DEFAULT_STREAM_TYPE
                }
            }

            call.resolve()
        }
    }

    /**
     * Session 23: brute-force reset of audio state. Bypasses
     * [AudioRouter.isActive] guard so the device's audio mode is reset
     * even when the lifecycle bookkeeping says routing is already
     * inactive but the system is still in MODE_IN_COMMUNICATION.
     *
     * Called by the JS app-resume watchdog when it detects a stuck
     * VoIP audio mode without an active call. Runs on cleanupExecutor
     * for the same ANR-avoidance reason as stopAudioRouting above.
     */
    @PluginMethod
    fun forceStopAudio(call: PluginCall) {
        cleanupExecutor.execute {
            try {
                AudioRouter.getSharedInstance(context).forceStop()
            } catch (e: Exception) {
                Log.e(TAG, "forceStopAudio threw", e)
            }

            // Session 31 (#644): unbind the activity's volume rocker after
            // the brute-force audio reset. Same ordering as stopAudioRouting:
            // restore happens once the system is back to MODE_NORMAL so a
            // racing volume-key press never lands on a half-torn-down state.
            bridge?.activity?.let { activity ->
                activity.runOnUiThread {
                    activity.volumeControlStream = AudioManager.USE_DEFAULT_STREAM_TYPE
                }
            }

            call.resolve()
        }
    }

    /**
     * Session 23: snapshot of current AudioManager state. Consumed by
     * the JS watchdog to decide whether to forceStopAudio on app
     * resume. Returns mode as a string identifier so JS does not have
     * to hardcode the Android numeric constants.
     */
    /**
     * Release a self-managed Telecom connection that has been ringing past its
     * deadline, and report whether one was found.
     *
     * The JS app-resume watchdog already recovers a stranded
     * MODE_IN_COMMUNICATION, but it never covered MODE_RINGTONE — which is
     * where most of the "phone is stuck after a call" reports were submitted
     * from. That mode is not ours to reset directly (a real cellular call
     * ringing sets it too); the honest fix is to release *our* connection and
     * let Telecom drop the mode on its own. [StaleCallPolicy] keeps this from
     * touching a call the user is about to answer.
     *
     * The same sweep releases a connection Telecom answered that JS never
     * picked up ([CallConnectionService.releaseUnadoptedAnswer]); the JS
     * watchdog calls this only while it holds no call of its own.
     */
    @PluginMethod
    fun releaseStaleRingingCall(call: PluginCall) {
        val released = try {
            // Each net finds nothing unless its own deadline has passed.
            val ringing = CallConnectionService.releaseStaleRingingConnection()
            val unadopted = CallConnectionService.releaseUnadoptedAnswer()
            ringing || unadopted
        } catch (e: Throwable) {
            Log.w(TAG, "releaseStaleRingingCall threw", e)
            false
        }
        call.resolve(JSObject().put("released", released))
    }

    @PluginMethod
    fun getAudioStatus(call: PluginCall) {
        val am = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
        val modeStr = when (am.mode) {
            AudioManager.MODE_NORMAL -> "MODE_NORMAL"
            AudioManager.MODE_IN_COMMUNICATION -> "MODE_IN_COMMUNICATION"
            AudioManager.MODE_RINGTONE -> "MODE_RINGTONE"
            AudioManager.MODE_IN_CALL -> "MODE_IN_CALL"
            else -> "UNKNOWN(${am.mode})"
        }
        @Suppress("DEPRECATION")
        val isBtScoOn = am.isBluetoothScoOn
        @Suppress("DEPRECATION")
        val isSpeakerOn = am.isSpeakerphoneOn
        val result = JSObject().apply {
            put("mode", modeStr)
            put("isSpeakerOn", isSpeakerOn)
            put("isBtScoOn", isBtScoOn)
        }
        call.resolve(result)
    }

    /**
     * Ordered audio events for the current call, oldest first, with times
     * relative to the first entry. Bug reports attach this so triage can see
     * how the audio stack reached its final state rather than only what that
     * state is — the difference between a device that never left MODE_RINGTONE
     * and one that fell back into it.
     *
     * Never fails: an empty timeline (call never started, router replaced) is
     * a valid answer and must not break report submission.
     */
    @PluginMethod
    fun getAudioTimeline(call: PluginCall) {
        val entries = try {
            AudioRouter.getSharedInstance(context).timeline.snapshot()
        } catch (e: Exception) {
            Log.w(TAG, "getAudioTimeline failed", e)
            emptyList()
        }
        val firstAt = entries.firstOrNull()?.atMs ?: 0L
        val array = JSArray()
        for (entry in entries) {
            array.put(
                JSObject().apply {
                    put("atMs", entry.atMs - firstAt)
                    put("event", entry.event)
                    put("detail", entry.detail)
                },
            )
        }
        call.resolve(JSObject().apply { put("entries", array) })
    }

    /**
     * Session 25 / S3-S4: return the last N FCM `m.call.invite` records
     * for the JS bug-reporter envelope. Callers should treat the result
     * as best-effort: an empty list simply means no invites have been
     * received in this process lifetime.
     *
     * Used by the JS bug-reporter to surface the recent delivery-latency
     * pattern in user reports — lets us distinguish S1 (accept-crash)
     * from S3 (FCM throttle / Doze) without asking the user to reproduce.
     */
    @PluginMethod
    fun getInviteThrottleSnapshot(call: PluginCall) {
        val records = com.forta.chat.FortaFirebaseMessagingService.inviteTracker.snapshot()
        val arr = org.json.JSONArray()
        for (r in records) {
            arr.put(org.json.JSONObject(r.toWireMap()))
        }
        call.resolve(JSObject().apply { put("records", arr) })
    }

    @PluginMethod
    fun getPendingAnswer(call: PluginCall) {
        // One atomic read-and-clear: the three parts can never be mixed
        // across calls, and a write landing right now is not lost.
        val marker = CallConnection.takePendingAnswer()
        val ret = com.getcapacitor.JSObject()
        ret.put("callId", marker.callId)
        ret.put("roomId", marker.roomId)
        // Lets the JS matcher refuse a room-scoped marker older than an
        // invite lifetime, which would otherwise hit an unrelated later call.
        ret.put("atMs", marker.atMs)
        call.resolve(ret)
    }

    @PluginMethod
    fun getPendingReject(call: PluginCall) {
        // See getPendingAnswer — one atomic read-and-clear.
        val marker = CallConnection.takePendingReject()
        val ret = com.getcapacitor.JSObject()
        ret.put("callId", marker.callId)
        ret.put("roomId", marker.roomId)
        ret.put("atMs", marker.atMs)
        call.resolve(ret)
    }

    /**
     * Called from `finalizeCall` once JS has finished with a call, so its
     * queued answer/reject cannot reach the next invite from that room.
     * See [CallConnection.retirePendingMarkersForCall].
     */
    @PluginMethod
    fun retirePendingMarkers(call: PluginCall) {
        CallConnection.retirePendingMarkersForCall(
            call.getString("callId"),
            call.getString("roomId"),
        )
        call.resolve()
    }
}
