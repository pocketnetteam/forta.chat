package com.forta.chat.plugins.webrtc

import android.app.Activity
import android.content.Intent
import android.media.projection.MediaProjectionManager
import android.util.Log
import androidx.activity.result.ActivityResult
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.PermissionState
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.annotation.Permission
import com.getcapacitor.annotation.PermissionCallback
import org.webrtc.*

/**
 * Capacitor plugin bridging JavaScript WebRTC signaling to native WebRTC engine.
 *
 * All methods accept a peerId to route to the correct native PeerConnection.
 * The SDK creates multiple PCs during call setup (glare, renegotiation).
 */
@CapacitorPlugin(
    name = "NativeWebRTC",
    permissions = [
        Permission(
            strings = [android.Manifest.permission.RECORD_AUDIO],
            alias = "microphone"
        )
    ]
)
class WebRTCPlugin : Plugin() {

    companion object {
        private const val TAG = "WebRTCPlugin"

        // Singleton manager — survives across plugin method calls
        @Volatile
        var manager: NativeWebRTCManager? = null
            private set

    }

    override fun load() {
        manager = NativeWebRTCManager(context)
        manager?.initialize()

        // Wire CallActivity native hangup → JS event
        com.forta.chat.plugins.calls.CallActivity.onNativeHangup = {
            notifyListeners("onNativeHangup", JSObject())
        }

        // Wire CallActivity native video toggle → JS event for renegotiation
        com.forta.chat.plugins.calls.CallActivity.onNativeVideoToggle = { enabled ->
            notifyListeners("onNativeVideoToggle", JSObject().apply {
                put("enabled", enabled)
            })
        }

        // Wire audio error callback to forward native audio failures to JS
        NativeWebRTCManager.onAudioError = { type, message ->
            Log.e("WebRTCAudio", "Audio error: type=$type, message=$message")
            notifyListeners("onAudioError", JSObject().apply {
                put("type", type)
                put("message", message)
            })
        }

        Log.d(TAG, "WebRTCPlugin loaded, manager initialized")
    }

    /**
     * D-07: One-time AudioManager state dump at call start.
     * Logs mode, speaker state, mic mute, voice call volume, and output devices.
     * Filterable via: adb logcat WebRTCAudio:* *:S
     */
    private fun logAudioManagerState() {
        val am = context.getSystemService(android.content.Context.AUDIO_SERVICE) as? android.media.AudioManager ?: return
        val sb = StringBuilder("[WebRTCAudio] AudioManager state: ")
        sb.append("mode=").append(am.mode).append(" ")
        sb.append("speakerOn=").append(am.isSpeakerphoneOn).append(" ")
        sb.append("micMute=").append(am.isMicrophoneMute).append(" ")
        sb.append("voiceVol=").append(am.getStreamVolume(android.media.AudioManager.STREAM_VOICE_CALL))
        sb.append("/").append(am.getStreamMaxVolume(android.media.AudioManager.STREAM_VOICE_CALL))
        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.M) {
            val devices = am.getDevices(android.media.AudioManager.GET_DEVICES_OUTPUTS)
            sb.append(" outputDevices=").append(devices.map { it.type })
        }
        Log.d("WebRTCAudio", sb.toString())
    }

    // -----------------------------------------------------------------------
    // Peer Connection Lifecycle
    // -----------------------------------------------------------------------

    @PluginMethod
    fun createPeerConnection(call: PluginCall) {
        val mgr = manager ?: run {
            call.reject("Manager not initialized")
            return
        }

        val peerId = call.getString("peerId") ?: run {
            call.reject("Missing peerId")
            return
        }

        try {
            val iceServersArray = call.getArray("iceServers")
            val iceServers = mutableListOf<PeerConnection.IceServer>()

            if (iceServersArray != null) {
                for (i in 0 until iceServersArray.length()) {
                    val server = iceServersArray.getJSONObject(i)
                    val urls = mutableListOf<String>()

                    // Handle both "urls" (array or string) and "url" (string)
                    if (server.has("urls")) {
                        val urlsVal = server.get("urls")
                        if (urlsVal is org.json.JSONArray) {
                            for (j in 0 until urlsVal.length()) {
                                urls.add(urlsVal.getString(j))
                            }
                        } else {
                            urls.add(urlsVal.toString())
                        }
                    } else if (server.has("url")) {
                        urls.add(server.getString("url"))
                    }

                    val builder = PeerConnection.IceServer.builder(urls)
                    if (server.has("username")) {
                        builder.setUsername(server.getString("username"))
                    }
                    if (server.has("credential")) {
                        builder.setPassword(server.getString("credential"))
                    }
                    iceServers.add(builder.createIceServer())
                }
            }

            mgr.createPeerConnection(peerId, iceServers, object : NativeWebRTCManager.Listener {
                override fun onIceCandidate(peerId: String, candidate: IceCandidate) {
                    val data = JSObject().apply {
                        put("peerId", peerId)
                        put("candidate", candidate.sdp)
                        put("sdpMid", candidate.sdpMid)
                        put("sdpMLineIndex", candidate.sdpMLineIndex)
                    }
                    notifyListeners("onIceCandidate", data)
                }

                override fun onIceConnectionStateChange(peerId: String, state: PeerConnection.IceConnectionState) {
                    val data = JSObject().apply {
                        put("peerId", peerId)
                        put("state", state.name.lowercase())
                    }
                    notifyListeners("onIceConnectionStateChange", data)

                    // Notify CallActivity when connected
                    if (state == PeerConnection.IceConnectionState.CONNECTED ||
                        state == PeerConnection.IceConnectionState.COMPLETED) {
                        com.forta.chat.plugins.calls.CallActivity.onCallConnected?.invoke()
                    }
                }

                override fun onAddTrack(peerId: String, receiver: RtpReceiver, streams: Array<out MediaStream>) {
                    val track = receiver.track()
                    val streamId = streams.firstOrNull()?.id ?: ""
                    val data = JSObject().apply {
                        put("peerId", peerId)
                        put("kind", track?.kind() ?: "unknown")
                        put("trackId", track?.id() ?: "")
                        put("streamId", streamId)
                    }
                    notifyListeners("onTrack", data)

                    // Auto-attach remote video to renderer + notify CallActivity
                    if (track is VideoTrack) {
                        mgr.addRemoteTrackSink(track)
                        com.forta.chat.plugins.calls.CallActivity.onRemoteVideo?.invoke()
                    }
                }

                override fun onRemoveTrack(peerId: String, receiver: RtpReceiver) {
                    val data = JSObject().apply {
                        put("peerId", peerId)
                    }
                    notifyListeners("onRemoveTrack", data)
                }

                override fun onRenegotiationNeeded(peerId: String) {
                    val data = JSObject().apply {
                        put("peerId", peerId)
                    }
                    notifyListeners("onRenegotiationNeeded", data)
                }
            })

            call.resolve()
        } catch (e: Exception) {
            Log.e(TAG, "createPeerConnection failed", e)
            call.reject("Failed to create peer connection: ${e.message}")
        }
    }

    // -----------------------------------------------------------------------
    // SDP Exchange
    // -----------------------------------------------------------------------

    @PluginMethod
    fun createOffer(call: PluginCall) {
        val peerId = call.getString("peerId") ?: run {
            call.reject("Missing peerId")
            return
        }
        manager?.createOffer(peerId) { sdp ->
            if (sdp != null) {
                call.resolve(JSObject().apply {
                    put("sdp", sdp.description)
                    put("type", sdp.type.canonicalForm())
                })
            } else {
                call.reject("createOffer failed")
            }
        } ?: call.reject("Manager not initialized")
    }

    @PluginMethod
    fun createAnswer(call: PluginCall) {
        val peerId = call.getString("peerId") ?: run {
            call.reject("Missing peerId")
            return
        }
        manager?.createAnswer(peerId) { sdp ->
            if (sdp != null) {
                call.resolve(JSObject().apply {
                    put("sdp", sdp.description)
                    put("type", sdp.type.canonicalForm())
                })
            } else {
                call.reject("createAnswer failed")
            }
        } ?: call.reject("Manager not initialized")
    }

    @PluginMethod
    fun setLocalDescription(call: PluginCall) {
        val peerId = call.getString("peerId") ?: run {
            call.reject("Missing peerId")
            return
        }
        val sdpStr = call.getString("sdp") ?: run {
            call.reject("Missing sdp")
            return
        }
        val typeStr = call.getString("type") ?: "offer"
        val type = when (typeStr) {
            "offer" -> SessionDescription.Type.OFFER
            "answer" -> SessionDescription.Type.ANSWER
            "pranswer" -> SessionDescription.Type.PRANSWER
            else -> SessionDescription.Type.OFFER
        }
        val sdp = SessionDescription(type, sdpStr)

        manager?.setLocalDescription(peerId, sdp) { success ->
            if (success) call.resolve() else call.reject("setLocalDescription failed")
        } ?: call.reject("Manager not initialized")
    }

    @PluginMethod
    fun setRemoteDescription(call: PluginCall) {
        val peerId = call.getString("peerId") ?: run {
            call.reject("Missing peerId")
            return
        }
        val sdpStr = call.getString("sdp") ?: run {
            call.reject("Missing sdp")
            return
        }
        val typeStr = call.getString("type") ?: "answer"
        val type = when (typeStr) {
            "offer" -> SessionDescription.Type.OFFER
            "answer" -> SessionDescription.Type.ANSWER
            "pranswer" -> SessionDescription.Type.PRANSWER
            else -> SessionDescription.Type.ANSWER
        }
        val sdp = SessionDescription(type, sdpStr)

        manager?.setRemoteDescription(peerId, sdp) { success ->
            if (success) call.resolve() else call.reject("setRemoteDescription failed")
        } ?: call.reject("Manager not initialized")
    }

    @PluginMethod
    fun addIceCandidate(call: PluginCall) {
        val peerId = call.getString("peerId") ?: run {
            call.reject("Missing peerId")
            return
        }
        val candidateStr = call.getString("candidate") ?: run {
            call.reject("Missing candidate")
            return
        }
        val sdpMid = call.getString("sdpMid") ?: ""
        val sdpMLineIndex = call.getInt("sdpMLineIndex") ?: 0

        val candidate = IceCandidate(sdpMid, sdpMLineIndex, candidateStr)
        val added = manager?.addIceCandidate(peerId, candidate) ?: false

        if (added) call.resolve() else call.reject("addIceCandidate failed")
    }

    // -----------------------------------------------------------------------
    // Media Control
    // -----------------------------------------------------------------------

    @PluginMethod
    fun startLocalMedia(call: PluginCall) {
        val mgr = manager ?: run {
            call.reject("Manager not initialized")
            return
        }
        // Safety net permission guard (D-01: Kotlin side)
        if (getPermissionState("microphone") != PermissionState.GRANTED) {
            requestPermissionForAlias("microphone", call, "micPermissionCallback")
            return
        }
        doStartLocalMedia(call, mgr)
    }

    private fun doStartLocalMedia(call: PluginCall, mgr: NativeWebRTCManager) {
        logAudioManagerState()  // D-07: one-time AudioManager state dump before audio start
        val peerId = call.getString("peerId") ?: ""
        val hasVideo = call.getBoolean("hasVideo", true) ?: true
        mgr.startLocalAudio(peerId)
        Log.d("WebRTCAudio", "doStartLocalMedia: audio started for peerId=$peerId, hasVideo=$hasVideo")

        if (hasVideo) {
            mgr.startLocalVideo(peerId)
        }
        call.resolve()
    }

    @PermissionCallback
    private fun micPermissionCallback(call: PluginCall) {
        if (getPermissionState("microphone") != PermissionState.GRANTED) {
            Log.w(TAG, "[WebRTCAudio] RECORD_AUDIO denied — cannot start audio")
            notifyListeners("onAudioError", JSObject().apply {
                put("type", "permission_denied")
                put("message", "Microphone permission denied")
            })
            call.reject("RECORD_AUDIO permission denied")
            return
        }
        val mgr = manager ?: run { call.reject("Manager not initialized"); return }
        doStartLocalMedia(call, mgr)
    }

    @PluginMethod
    fun setAudioEnabled(call: PluginCall) {
        val enabled = call.getBoolean("enabled", true) ?: true
        manager?.setAudioEnabled(enabled)
        call.resolve()
    }

    @PluginMethod
    fun setVideoEnabled(call: PluginCall) {
        val enabled = call.getBoolean("enabled", true) ?: true
        manager?.setVideoEnabled(enabled)
        call.resolve()
    }

    @PluginMethod
    fun switchCamera(call: PluginCall) {
        manager?.switchCamera()
        call.resolve()
    }

    // -----------------------------------------------------------------------
    // Screen Sharing
    // -----------------------------------------------------------------------

    private var screenShareCall: PluginCall? = null
    private val SCREEN_CAPTURE_REQUEST = 1001

    @PluginMethod
    fun startScreenShare(call: PluginCall) {
        val mgr = manager ?: run {
            call.reject("Manager not initialized")
            return
        }

        if (mgr.isScreenSharing()) {
            call.resolve(JSObject().apply { put("sharing", true) })
            return
        }

        screenShareCall = call
        val projectionManager = context.getSystemService(
            android.content.Context.MEDIA_PROJECTION_SERVICE
        ) as MediaProjectionManager

        val intent = projectionManager.createScreenCaptureIntent()
        startActivityForResult(call, intent, "handleScreenShareResult")
    }

    @com.getcapacitor.annotation.ActivityCallback
    fun handleScreenShareResult(call: PluginCall, result: ActivityResult) {
        if (result.resultCode == Activity.RESULT_OK && result.data != null) {
            manager?.startScreenCapture(result.resultCode, result.data!!)
            call.resolve(JSObject().apply { put("sharing", true) })
        } else {
            call.resolve(JSObject().apply { put("sharing", false) })
        }
        screenShareCall = null
    }

    @PluginMethod
    fun stopScreenShare(call: PluginCall) {
        manager?.stopScreenCapture()
        call.resolve(JSObject().apply { put("sharing", false) })
    }

    // -----------------------------------------------------------------------
    // Native Call UI
    // -----------------------------------------------------------------------

    @PluginMethod
    fun launchCallUI(call: PluginCall) {
        val callerName = call.getString("callerName") ?: "Unknown"
        val callType = call.getString("callType") ?: "video"
        val callId = call.getString("callId") ?: ""
        val direction = call.getString("direction") ?: "outgoing"

        // Start foreground service to keep call alive in background
        com.forta.chat.plugins.calls.CallForegroundService.start(
            context, callerName, callType
        )

        com.forta.chat.plugins.calls.CallActivity.launch(
            context, callerName, callType, callId, direction
        )
        call.resolve()
    }

    @PluginMethod
    fun dismissCallUI(call: PluginCall) {
        com.forta.chat.plugins.calls.CallActivity.onCallEnded?.invoke()
        com.forta.chat.plugins.calls.CallForegroundService.stop(context)
        call.resolve()
    }

    @PluginMethod
    fun updateCallStatus(call: PluginCall) {
        val status = call.getString("status") ?: ""
        val duration = call.getString("duration") ?: ""
        com.forta.chat.plugins.calls.CallForegroundService.updateStatus(
            context, status, duration
        )
        call.resolve()
    }

    @PluginMethod
    fun updateRemoteVideoState(call: PluginCall) {
        val muted = call.getBoolean("muted") ?: false
        com.forta.chat.plugins.calls.CallActivity.onRemoteVideoMuted?.invoke(muted)
        call.resolve()
    }

    // -----------------------------------------------------------------------
    // Cleanup
    // -----------------------------------------------------------------------

    @PluginMethod
    fun closePeerConnection(call: PluginCall) {
        val peerId = call.getString("peerId") ?: run {
            call.reject("Missing peerId")
            return
        }
        manager?.closePeerConnection(peerId)
        call.resolve()
    }

    @PluginMethod
    fun getConnectionState(call: PluginCall) {
        val peerId = call.getString("peerId") ?: ""
        val state = manager?.getConnectionState(peerId) ?: "UNKNOWN"
        call.resolve(JSObject().apply {
            put("state", state)
        })
    }

    override fun handleOnDestroy() {
        manager?.dispose()
        manager = null
        super.handleOnDestroy()
    }
}
