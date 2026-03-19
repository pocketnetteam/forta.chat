package com.bastyon.chat.plugins.webrtc

import android.app.Activity
import android.content.Intent
import android.media.projection.MediaProjectionManager
import android.util.Log
import androidx.activity.result.ActivityResult
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import org.webrtc.*

/**
 * Capacitor plugin bridging JavaScript WebRTC signaling to native WebRTC engine.
 *
 * The JS side (RTCPeerConnection proxy) calls these methods instead of using
 * the browser's WebRTC implementation. This gives us:
 * - Hardware-accelerated video encoding/decoding
 * - Native camera control (Camera2 API)
 * - Native audio with echo cancellation
 * - Background call support
 */
@CapacitorPlugin(name = "NativeWebRTC")
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
        Log.d(TAG, "WebRTCPlugin loaded, manager initialized")
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

            mgr.createPeerConnection(iceServers, object : NativeWebRTCManager.Listener {
                override fun onIceCandidate(candidate: IceCandidate) {
                    val data = JSObject().apply {
                        put("candidate", candidate.sdp)
                        put("sdpMid", candidate.sdpMid)
                        put("sdpMLineIndex", candidate.sdpMLineIndex)
                    }
                    notifyListeners("onIceCandidate", data)
                }

                override fun onIceConnectionStateChange(state: PeerConnection.IceConnectionState) {
                    val data = JSObject().apply {
                        put("state", state.name.lowercase())
                    }
                    notifyListeners("onIceConnectionStateChange", data)
                }

                override fun onAddTrack(receiver: RtpReceiver, streams: Array<out MediaStream>) {
                    val track = receiver.track()
                    val data = JSObject().apply {
                        put("kind", track?.kind() ?: "unknown")
                        put("trackId", track?.id() ?: "")
                    }
                    notifyListeners("onTrack", data)

                    // Auto-attach remote video to renderer
                    if (track is VideoTrack) {
                        mgr.addRemoteTrackSink(track)
                    }
                }

                override fun onRemoveTrack(receiver: RtpReceiver) {
                    notifyListeners("onRemoveTrack", JSObject())
                }

                override fun onRenegotiationNeeded() {
                    notifyListeners("onRenegotiationNeeded", JSObject())
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
        manager?.createOffer { sdp ->
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
        manager?.createAnswer { sdp ->
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

        manager?.setLocalDescription(sdp) { success ->
            if (success) call.resolve() else call.reject("setLocalDescription failed")
        } ?: call.reject("Manager not initialized")
    }

    @PluginMethod
    fun setRemoteDescription(call: PluginCall) {
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

        manager?.setRemoteDescription(sdp) { success ->
            if (success) call.resolve() else call.reject("setRemoteDescription failed")
        } ?: call.reject("Manager not initialized")
    }

    @PluginMethod
    fun addIceCandidate(call: PluginCall) {
        val candidateStr = call.getString("candidate") ?: run {
            call.reject("Missing candidate")
            return
        }
        val sdpMid = call.getString("sdpMid") ?: ""
        val sdpMLineIndex = call.getInt("sdpMLineIndex") ?: 0

        val candidate = IceCandidate(sdpMid, sdpMLineIndex, candidateStr)
        val added = manager?.addIceCandidate(candidate) ?: false

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
        val hasVideo = call.getBoolean("hasVideo", true) ?: true

        mgr.startLocalAudio()
        if (hasVideo) {
            mgr.startLocalVideo()
        }
        call.resolve()
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
        com.bastyon.chat.plugins.calls.CallForegroundService.start(
            context, callerName, callType
        )

        com.bastyon.chat.plugins.calls.CallActivity.launch(
            context, callerName, callType, callId, direction
        )
        call.resolve()
    }

    @PluginMethod
    fun dismissCallUI(call: PluginCall) {
        com.bastyon.chat.plugins.calls.CallActivity.onCallEnded?.invoke()
        com.bastyon.chat.plugins.calls.CallForegroundService.stop(context)
        call.resolve()
    }

    @PluginMethod
    fun updateCallStatus(call: PluginCall) {
        val status = call.getString("status") ?: ""
        val duration = call.getString("duration") ?: ""
        com.bastyon.chat.plugins.calls.CallForegroundService.updateStatus(
            context, status, duration
        )
        call.resolve()
    }

    // -----------------------------------------------------------------------
    // Cleanup
    // -----------------------------------------------------------------------

    @PluginMethod
    fun closePeerConnection(call: PluginCall) {
        manager?.closePeerConnection()
        call.resolve()
    }

    @PluginMethod
    fun getConnectionState(call: PluginCall) {
        val state = manager?.getConnectionState() ?: "UNKNOWN"
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
