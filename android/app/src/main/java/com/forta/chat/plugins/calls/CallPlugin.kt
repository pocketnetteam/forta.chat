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

    override fun load() {
        try {
            CallConnectionService.registerPhoneAccount(context)
        } catch (e: Exception) {
            Log.e(TAG, "Failed to register phone account", e)
        }

        CallConnection.onAnswered = { callId ->
            notifyListeners("callAnswered", JSObject().apply {
                put("callId", callId)
                // Include roomId: on this homeserver the push payload has
                // the push event_id in place of the Matrix content.call_id,
                // so JS can't correlate by callId alone. By the time this
                // callback fires CallConnection.onAnswer has already set
                // pendingAnswerRoomId, so read it here.
                put("roomId", CallConnection.pendingAnswerRoomId ?: "")
            })
        }
        CallConnection.onRejected = { callId ->
            notifyListeners("callDeclined", JSObject().apply {
                put("callId", callId)
            })
        }
        CallConnection.onEnded = { callId ->
            notifyListeners("callEnded", JSObject().apply {
                put("callId", callId)
            })
        }

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

    @PluginMethod
    fun reportIncomingCall(call: PluginCall) {
        val callId = call.getString("callId") ?: ""
        val callerName = call.getString("callerName") ?: "Unknown"
        val roomId = call.getString("roomId") ?: ""
        val hasVideo = call.getBoolean("hasVideo", false) ?: false

        Log.d(TAG, "reportIncomingCall: $callerName ($callId)")

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
        } catch (e: Exception) {
            Log.e(TAG, "Failed to report incoming call", e)
            val intent = Intent(context, IncomingCallActivity::class.java).apply {
                flags = Intent.FLAG_ACTIVITY_NEW_TASK
                putExtra("callId", callId)
                putExtra("callerName", callerName)
            }
            context.startActivity(intent)
            call.resolve()
        }
    }

    @PluginMethod
    fun reportOutgoingCall(call: PluginCall) {
        val callId = call.getString("callId") ?: ""
        val callerName = call.getString("callerName") ?: ""
        val hasVideo = call.getBoolean("hasVideo", false) ?: false

        Log.d(TAG, "reportOutgoingCall: $callerName ($callId)")

        try {
            val telecomManager = context.getSystemService(TelecomManager::class.java)
            val handle = CallConnectionService.getPhoneAccountHandle(context)

            val extras = Bundle().apply {
                putString("callId", callId)
                putString("callerName", callerName)
                putBoolean("hasVideo", hasVideo)
                putParcelable(TelecomManager.EXTRA_PHONE_ACCOUNT_HANDLE, handle)
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
            CallConnectionService.currentConnection = connection
            call.resolve()
        }
    }

    @PluginMethod
    fun reportCallEnded(call: PluginCall) {
        CallConnectionService.currentConnection?.onDisconnect()
        CallConnectionService.currentConnection = null
        call.resolve()
    }

    @PluginMethod
    fun reportCallConnected(call: PluginCall) {
        CallConnectionService.currentConnection?.setActive()
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
        audioRouter?.setDevice(device)
        call.resolve()
    }

    @PluginMethod
    fun startAudioRouting(call: PluginCall) {
        val callType = call.getString("callType") ?: "voice"
        audioRouter?.start(callType)
        call.resolve()
    }

    @PluginMethod
    fun stopAudioRouting(call: PluginCall) {
        // Dispatch to a dedicated executor so the Capacitor plugin thread
        // is freed immediately. AudioRouter.stop() blocks up to 500ms
        // waiting for SCO_DISCONNECTED on API < 31; running it on the
        // plugin thread would serialize every other native call (push,
        // status bar, share) and risk ANRs.
        cleanupExecutor.execute {
            try {
                audioRouter?.stop()
            } catch (e: Exception) {
                Log.e(TAG, "stopAudioRouting threw", e)
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
            call.resolve()
        }
    }

    /**
     * Session 23: snapshot of current AudioManager state. Consumed by
     * the JS watchdog to decide whether to forceStopAudio on app
     * resume. Returns mode as a string identifier so JS does not have
     * to hardcode the Android numeric constants.
     */
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

    @PluginMethod
    fun getPendingAnswer(call: PluginCall) {
        val pendingCallId = CallConnection.pendingAnswerCallId
        val pendingRoomId = CallConnection.pendingAnswerRoomId
        CallConnection.pendingAnswerCallId = null
        CallConnection.pendingAnswerRoomId = null
        val ret = com.getcapacitor.JSObject()
        ret.put("callId", pendingCallId)
        ret.put("roomId", pendingRoomId)
        call.resolve(ret)
    }

    @PluginMethod
    fun getPendingReject(call: PluginCall) {
        val pendingCallId = CallConnection.pendingRejectCallId
        val pendingRoomId = CallConnection.pendingRejectRoomId
        CallConnection.pendingRejectCallId = null
        CallConnection.pendingRejectRoomId = null
        val ret = com.getcapacitor.JSObject()
        ret.put("callId", pendingCallId)
        ret.put("roomId", pendingRoomId)
        call.resolve(ret)
    }
}
