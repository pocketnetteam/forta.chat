package com.forta.chat.plugins.webrtc

import android.content.Context
import android.content.Intent
import android.media.AudioManager
import android.media.projection.MediaProjection
import android.os.Build
import android.util.Log
import com.forta.chat.plugins.calls.AudioRouter
import com.forta.chat.plugins.calls.VendorAudioPolicy
import org.webrtc.*
import org.webrtc.audio.JavaAudioDeviceModule

/**
 * Signals that libwebrtc refused to create the AudioSource/AudioTrack used for
 * the outgoing microphone feed. Typical causes:
 *   - Another app is holding AudioRecord (phone call, voice recorder, MIUI
 *     privacy shield with "restrict mic" toggle).
 *   - OEM firmware (Xiaomi MIUI, Huawei EMUI, Realme UI) rejected the
 *     VOICE_COMMUNICATION session because MODE_IN_COMMUNICATION wasn't
 *     re-applied fast enough after its async reset.
 *   - AudioDeviceModule failed to init (HW AEC crash) — should not happen
 *     after the broken-AEC vendor fallback, but included for completeness.
 *
 * Thrown from [NativeWebRTCManager.startLocalAudio]; caught by
 * [WebRTCPlugin.startLocalMedia] which turns it into `call.reject`. The JS
 * proxy then rethrows as a DOMException so the Matrix SDK bails out of the
 * call setup instead of sending an invite/answer with an empty track.
 */
class AudioInitException(
    val reason: String,
    message: String,
    cause: Throwable? = null,
) : RuntimeException(message, cause)

/**
 * Manages multiple native WebRTC peer connections with hardware-accelerated
 * video encoding/decoding via Google's libwebrtc.
 *
 * Each peer connection is identified by a peerId string from the JS side.
 * The SDK creates multiple PeerConnections during call setup (glare detection,
 * renegotiation), so we must support concurrent instances.
 */
class NativeWebRTCManager(private val context: Context) {

    companion object {
        private const val TAG = "NativeWebRTCManager"
        private const val VIDEO_WIDTH = 1280
        private const val VIDEO_HEIGHT = 720
        private const val VIDEO_FPS = 30

        /** Callback for audio creation failures — wired by WebRTCPlugin to emit onAudioError events to JS */
        var onAudioError: ((type: String, message: String) -> Unit)? = null

        /**
         * Detect vendors with known broken hardware AEC/NS — using HW AEC on
         * these devices mutes the microphone or locks the audio session, so we
         * fall back to WebRTC software AEC/NS (works everywhere).
         *
         * WEE-56: the authoritative vendor list now lives in
         * [VendorAudioPolicy] so the calls and webrtc packages share one
         * definition (it was duplicated against AudioRouter's OEM handling)
         * and a single JVM test locks it. Behaviour-preserving for every real
         * (non-null manufacturer) Build value; see [VendorAudioPolicy.prefersSoftwareAudioProcessing]
         * for the one intentional, safer null-brand edge-case change. This is the root-cause handling for
         * the HUAWEI "video works, no audio" symptom (#874): EMUI hardware AEC
         * mutes the capture stream. We intentionally do not force a PCMU/G.711
         * codec fallback — that would degrade Opus quality/interop for every
         * Huawei user (an A5 regression); software audio processing fixes the
         * capture mute without touching codec negotiation.
         */
        fun hasBrokenHardwareAudioProcessing(): Boolean =
            VendorAudioPolicy.prefersSoftwareAudioProcessing(Build.MANUFACTURER, Build.BRAND)
    }

    interface Listener {
        fun onIceCandidate(peerId: String, candidate: IceCandidate)
        fun onIceConnectionStateChange(peerId: String, state: PeerConnection.IceConnectionState)
        fun onAddTrack(peerId: String, receiver: RtpReceiver, streams: Array<out MediaStream>)
        fun onRemoveTrack(peerId: String, receiver: RtpReceiver)
        fun onRenegotiationNeeded(peerId: String)
        fun onSignalingStateChange(peerId: String, state: PeerConnection.SignalingState)
    }

    private var factory: PeerConnectionFactory? = null
    // Guards the lazy creation in getEglBase: CallActivity asks for the context
    // on the main thread while initialize() asks on the plugin thread.
    private val eglLock = Any()
    @Volatile private var eglBase: EglBase? = null

    // Multiple peer connections keyed by peerId
    /**
     * Every mutation used to arrive on Capacitor's single plugin thread, so a
     * plain map was safe by construction. [CallForegroundService] now releases
     * media from its own worker when the app is swiped away mid-call — a second
     * thread — and a swipe-out during teardown of one call can overlap the
     * setup of the next. A concurrent map keeps put/remove/clear from corrupting
     * the structure itself; which call wins the slot is decided upstream by the
     * single-call model, not here.
     */
    private val peerConnections = java.util.concurrent.ConcurrentHashMap<String, PeerConnection>()

    /**
     * Serialises creating and disposing the local capture objects.
     *
     * A concurrent map protects the map; the tracks and sources below are
     * plain fields, and [stopLocalMedia] disposing them from the media-release
     * worker while [startLocalAudio] is building them on the plugin thread
     * would hand the next call a disposed track — or dispose one twice.
     */
    private val mediaLock = Any()

    // Local media (shared across PCs — one camera/mic for the device)
    // @Volatile, not @GuardedBy(mediaLock): CallActivity's mute/video/camera
    // buttons and CallForegroundService's audio-focus listener all reach the
    // accessors below from the MAIN thread, while `mediaLock` is held across
    // startCapture/stopCapture (documented to block for up to a second). Taking
    // the lock on those paths would trade a use-after-dispose for an ANR, so
    // they snapshot a volatile reference and tolerate a dispose racing them.
    @Volatile private var localAudioTrack: AudioTrack? = null
    @Volatile private var localVideoTrack: VideoTrack? = null
    @Volatile private var videoCapturer: CameraVideoCapturer? = null
    @Volatile private var surfaceTextureHelper: SurfaceTextureHelper? = null
    @Volatile private var localAudioSource: AudioSource? = null
    @Volatile private var localVideoSource: VideoSource? = null

    // Screen capture
    private var screenCapturer: ScreenCapturerAndroid? = null
    private var screenVideoSource: VideoSource? = null
    private var screenVideoTrack: VideoTrack? = null
    private var screenSurfaceHelper: SurfaceTextureHelper? = null
    private var isScreenSharing = false

    // Renderers. localRenderer is written by CallActivity on the main thread
    // (attachLocalRenderer) and read by the plugin thread when it creates the
    // video track; volatile so each side sees the other's write.
    @Volatile private var localRenderer: SurfaceViewRenderer? = null

    // The remote video tracks and the call screen's renderer. Tracks come in on
    // the signaling thread and the renderer from CallActivity on the main
    // thread; RemoteVideoSinks serialises both. A sink call that throws must
    // not stop the rest, or onDestroy would skip releasing the view.
    private val remoteVideo = RemoteVideoSinks<VideoTrack, SurfaceViewRenderer>(
        addSink = { track, renderer ->
            runCatching { track.addSink(renderer) }
                .onFailure { Log.w(TAG, "Could not put the renderer on a remote track", it) }
        },
        removeSink = { track, renderer ->
            runCatching { track.removeSink(renderer) }
                .onFailure { Log.w(TAG, "Could not take the renderer off a remote track", it) }
        },
    )

    // Which way the open camera faces, null while none is open. Drives the
    // self-view mirror; written by the capture paths and by the camera
    // thread's switch callback, read wherever a preview is bound.
    @Volatile private var cameraFrontFacing: Boolean? = null

    private var listener: Listener? = null
    private var isInitialized = false

    // -----------------------------------------------------------------------
    // Initialization
    // -----------------------------------------------------------------------

    fun initialize() {
        if (isInitialized) return

        // WEE-31 (H3): the libwebrtc native libraries are linked at first
        // use of EglBase / PeerConnectionFactory. On ancient ARMv7 builds
        // (Android 7 devices that mis-report their ABI) and on a handful
        // of HarmonyOS / vendor WebViews that override the linker, the JNI
        // load throws UnsatisfiedLinkError — which used to bubble out of
        // here and process-kill the callee "наглухо" the moment the
        // incoming-call accept handler tried to wire up audio. Wrap the
        // whole bootstrap in a Throwable catch so the failure surfaces as
        // a typed UI error through CallActivity instead of a silent crash.
        try {
            val egl = checkNotNull(getEglBase()) { "EglBase unavailable" }

            val initOptions = PeerConnectionFactory.InitializationOptions.builder(context)
                .setEnableInternalTracer(false)
                .createInitializationOptions()
            PeerConnectionFactory.initialize(initOptions)

            val encoderFactory = DefaultVideoEncoderFactory(
                egl.eglBaseContext,
                true,  // enableIntelVp8Encoder
                true   // enableH264HighProfile
            )
            val decoderFactory = DefaultVideoDecoderFactory(egl.eglBaseContext)

            // Hardware AEC/NS is broken on Xiaomi/MIUI, Realme, Oppo, Infinix, Tecno,
            // Huawei, ZTE — enabling it mutes the mic. Fall back to software AEC/NS
            // (shipped with libwebrtc) on these vendors; keep HW path on Samsung/Pixel/OnePlus.
            val useHardwareAudioProcessing = !hasBrokenHardwareAudioProcessing()
            Log.d(
                TAG,
                "Audio processing: vendor=${Build.MANUFACTURER} brand=${Build.BRAND} " +
                    "hardwareAEC=$useHardwareAudioProcessing"
            )
            val audioDeviceModule = JavaAudioDeviceModule.builder(context)
                .setUseHardwareAcousticEchoCanceler(useHardwareAudioProcessing)
                .setUseHardwareNoiseSuppressor(useHardwareAudioProcessing)
                .createAudioDeviceModule()

            factory = PeerConnectionFactory.builder()
                .setVideoEncoderFactory(encoderFactory)
                .setVideoDecoderFactory(decoderFactory)
                .setAudioDeviceModule(audioDeviceModule)
                .createPeerConnectionFactory()

            isInitialized = true
            Log.d(TAG, "Initialized with HW acceleration")
        } catch (t: Throwable) {
            // Leave isInitialized=false so a future caller can either
            // retry or short-circuit with a typed error. The GL context
            // stays: the call screen may already render with it, and a
            // retry has to share that same context or its decoded frames
            // cannot be drawn there. dispose() releases it.
            Log.e(TAG, "[callee-crash-guard] NativeWebRTC initialize failed", t)
            factory = null
            isInitialized = false
        }
    }

    /**
     * The GL context the renderers and the codec factories share, created on
     * first use rather than by [initialize]. On a cold process CallActivity
     * opens before the plugin thread builds the factory; it found no context,
     * skipped its renderer setup for the whole call, and the self-view stayed
     * black while the remote renderer was never attached. A context holds no
     * audio or camera device, so the factory itself stays lazy (WEE-47). Null
     * only when EGL cannot be brought up (WEE-31): the call screen then runs
     * without video instead of crashing.
     */
    fun getEglBase(): EglBase? = synchronized(eglLock) {
        eglBase ?: runCatching { EglBase.create() }
            .onFailure { Log.e(TAG, "[callee-crash-guard] EglBase create failed", it) }
            .getOrNull()
            ?.also { eglBase = it }
    }

    // -----------------------------------------------------------------------
    // Peer Connection
    // -----------------------------------------------------------------------

    fun createPeerConnection(peerId: String, iceServers: List<PeerConnection.IceServer>, iceTransportPolicy: String, listener: Listener) {
        this.listener = listener

        // Close existing PC with same ID if any
        peerConnections[peerId]?.let {
            try { it.close() } catch (_: Exception) {}
            peerConnections.remove(peerId)
            remoteVideo.forgetPeer(peerId)
        }

        val rtcConfig = PeerConnection.RTCConfiguration(iceServers).apply {
            sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN
            continualGatheringPolicy = PeerConnection.ContinualGatheringPolicy.GATHER_CONTINUALLY
            iceCandidatePoolSize = 10
            iceTransportsType = if (iceTransportPolicy == "relay") {
                PeerConnection.IceTransportsType.RELAY
            } else {
                PeerConnection.IceTransportsType.ALL
            }
        }

        val pc = factory?.createPeerConnection(rtcConfig, object : PeerConnection.Observer {
            override fun onIceCandidate(candidate: IceCandidate) {
                Log.d(TAG, "[$peerId] onIceCandidate: ${candidate.sdpMid}")
                listener.onIceCandidate(peerId, candidate)
            }

            override fun onIceCandidatesRemoved(candidates: Array<out IceCandidate>) {}

            override fun onIceConnectionChange(state: PeerConnection.IceConnectionState) {
                Log.d(TAG, "[$peerId] ICE connection state: $state")
                listener.onIceConnectionStateChange(peerId, state)
            }

            override fun onIceConnectionReceivingChange(receiving: Boolean) {}
            override fun onIceGatheringChange(state: PeerConnection.IceGatheringState) {}

            override fun onAddStream(stream: MediaStream) {}
            override fun onRemoveStream(stream: MediaStream) {}

            override fun onAddTrack(receiver: RtpReceiver, streams: Array<out MediaStream>) {
                val track = receiver.track()
                Log.d(TAG, "[$peerId] onAddTrack: ${track?.kind()}")
                // Kept before the plugin hears of it, so the call screen's renderer
                // is on the track by the time the view is shown.
                if (track is VideoTrack) remoteVideo.keepTrack(peerId, track.id(), track)
                listener.onAddTrack(peerId, receiver, streams)
            }

            override fun onTrack(transceiver: RtpTransceiver) {
                Log.d(TAG, "[$peerId] onTrack: ${transceiver.receiver.track()?.kind()}")
            }

            override fun onRemoveTrack(receiver: RtpReceiver) {
                // A fresh wrapper of the removed track, so it is forgotten by id.
                (receiver.track() as? VideoTrack)?.let { remoteVideo.forgetTrack(peerId, it.id()) }
                listener.onRemoveTrack(peerId, receiver)
            }

            override fun onDataChannel(dc: DataChannel) {}
            override fun onSignalingChange(state: PeerConnection.SignalingState) {
                // The JS proxy (rtc-peer-connection-proxy.ts) used to derive
                // signalingState from local presence/absence of descriptions,
                // which never reset on renegotiation and permanently reported
                // "stable" after the first offer/answer exchange — silently
                // breaking the SDK's perfect-negotiation collision detection
                // (matrix-js-sdk-bastyon's onNegotiateReceived reads exactly
                // this field to decide whether an incoming offer collides).
                // libwebrtc's own state machine is the correct source of
                // truth; forward it so the JS side no longer re-derives it.
                Log.d(TAG, "[$peerId] onSignalingChange: $state")
                listener.onSignalingStateChange(peerId, state)
            }
            override fun onConnectionChange(state: PeerConnection.PeerConnectionState) {
                Log.d(TAG, "[$peerId] Connection state: $state")
            }
            override fun onRenegotiationNeeded() {
                // Do NOT forward to JS — the proxy fires synthetic
                // negotiationneeded from addTrack when needed.  Native
                // renegotiation events caused by our own track management
                // (startLocalAudio/Video) would trigger premature offers.
                Log.d(TAG, "[$peerId] onRenegotiationNeeded (suppressed)")
            }
            override fun onSelectedCandidatePairChanged(event: CandidatePairChangeEvent?) {}
        })

        if (pc != null) {
            peerConnections[peerId] = pc

            // Auto-attach existing local tracks (getUserMedia runs before createPC).
            // Under mediaLock: this runs on the plugin thread while the media
            // release executor can be disposing those very tracks, and addTrack
            // on a disposed native object throws. The recording switch is raised
            // under the same lock: closeAllPeerConnections lowers it from that
            // executor, and a raise landing between its snapshot and its stop
            // would leave this connection silent. Short critical section — the
            // raise hops to the worker thread and, with nothing sending yet, only
            // sets a flag.
            synchronized(mediaLock) {
                enableAudioRecording(pc, peerId)
                localAudioTrack?.let { attachLocalTrackLocked(it, "audio", peerId, "createPeerConnection") }
                localVideoTrack?.let { attachLocalTrackLocked(it, "video", peerId, "createPeerConnection") }
            }

            Log.d(TAG, "[$peerId] PeerConnection created (total: ${peerConnections.size})")
        } else {
            Log.e(TAG, "[$peerId] Failed to create PeerConnection")
        }
    }

    // -----------------------------------------------------------------------
    // SDP
    // -----------------------------------------------------------------------

    fun createOffer(peerId: String, callback: (SessionDescription?) -> Unit) {
        val pc = peerConnections[peerId]
        if (pc == null) {
            Log.e(TAG, "[$peerId] createOffer: no PeerConnection")
            callback(null)
            return
        }
        // Let Unified Plan determine m-lines from attached tracks.
        // No OfferToReceiveVideo — avoids sending video m-line for voice calls.
        val constraints = MediaConstraints()
        pc.createOffer(object : SdpObserver {
            override fun onCreateSuccess(sdp: SessionDescription) {
                Log.d(TAG, "[$peerId] createOffer success")
                callback(sdp)
            }
            override fun onCreateFailure(error: String) {
                Log.e(TAG, "[$peerId] createOffer failed: $error")
                callback(null)
            }
            override fun onSetSuccess() {}
            override fun onSetFailure(error: String) {}
        }, constraints)
    }

    fun createAnswer(peerId: String, callback: (SessionDescription?) -> Unit) {
        val pc = peerConnections[peerId]
        if (pc == null) {
            Log.e(TAG, "[$peerId] createAnswer: no PeerConnection")
            callback(null)
            return
        }
        val constraints = MediaConstraints()
        pc.createAnswer(object : SdpObserver {
            override fun onCreateSuccess(sdp: SessionDescription) {
                Log.d(TAG, "[$peerId] createAnswer success")
                callback(sdp)
            }
            override fun onCreateFailure(error: String) {
                Log.e(TAG, "[$peerId] createAnswer failed: $error")
                callback(null)
            }
            override fun onSetSuccess() {}
            override fun onSetFailure(error: String) {}
        }, constraints)
    }

    fun setLocalDescription(peerId: String, sdp: SessionDescription, callback: (Boolean) -> Unit) {
        val pc = peerConnections[peerId]
        if (pc == null) {
            Log.e(TAG, "[$peerId] setLocalDescription: no PeerConnection")
            callback(false)
            return
        }
        pc.setLocalDescription(object : SdpObserver {
            override fun onSetSuccess() {
                Log.d(TAG, "[$peerId] setLocalDescription success")
                callback(true)
            }
            override fun onSetFailure(error: String) {
                Log.e(TAG, "[$peerId] setLocalDescription failed: $error")
                callback(false)
            }
            override fun onCreateSuccess(sdp: SessionDescription?) {}
            override fun onCreateFailure(error: String?) {}
        }, sdp)
    }

    fun setRemoteDescription(peerId: String, sdp: SessionDescription, callback: (Boolean) -> Unit) {
        val pc = peerConnections[peerId]
        if (pc == null) {
            Log.e(TAG, "[$peerId] setRemoteDescription: no PeerConnection")
            callback(false)
            return
        }
        pc.setRemoteDescription(object : SdpObserver {
            override fun onSetSuccess() {
                Log.d(TAG, "[$peerId] setRemoteDescription success")
                callback(true)
            }
            override fun onSetFailure(error: String) {
                Log.e(TAG, "[$peerId] setRemoteDescription failed: $error")
                callback(false)
            }
            override fun onCreateSuccess(sdp: SessionDescription?) {}
            override fun onCreateFailure(error: String?) {}
        }, sdp)
    }

    fun addIceCandidate(peerId: String, candidate: IceCandidate): Boolean {
        val pc = peerConnections[peerId]
        if (pc == null) {
            Log.e(TAG, "[$peerId] addIceCandidate: no PeerConnection")
            return false
        }
        return pc.addIceCandidate(candidate)
    }

    // -----------------------------------------------------------------------
    // ICE restart / stats (Session 02 — fix for 1-2 sec call drops)
    // -----------------------------------------------------------------------

    /**
     * Perform an ICE restart on the given PeerConnection. Called when the
     * JS side detects a network flip or ICE disconnected/failed and needs
     * a fresh ICE agent without tearing the whole call down.
     *
     * Note: `PeerConnection.restartIce()` here is the libwebrtc Java
     * binding (org.webrtc.PeerConnection), not Android's framework WebRTC.
     * It is available on every Android API level our `minSdk 24` supports
     * because libwebrtc ships its own implementation. An earlier version
     * of this method had an API 28 guard with a `createOffer(IceRestart)`
     * fallback, but that fallback never called `setLocalDescription` and
     * our `onRenegotiationNeeded` observer is suppressed to avoid
     * premature offers from track management — so the fallback would have
     * silently done nothing. The unconditional call is correct.
     *
     * Returns true on success, false when peer is unknown or the native
     * call threw.
     */
    fun restartIce(peerId: String): Boolean {
        val pc = peerConnections[peerId]
        if (pc == null) {
            Log.e(TAG, "[$peerId] restartIce: no PeerConnection")
            return false
        }
        return try {
            pc.restartIce()
            Log.d(TAG, "[$peerId] restartIce: invoked PeerConnection.restartIce()")
            true
        } catch (e: Exception) {
            Log.e(TAG, "[$peerId] restartIce threw", e)
            false
        }
    }

    /**
     * Return the latest WebRTC stats for the given PeerConnection as a
     * JSObject (flat map of stat-id → { id, type, timestamp, ...members }).
     *
     * We serialize the fields our JS consumers actually read: type, kind,
     * bytesSent/Received, packetsSent/Received, jitter, rtt,
     * framesEncoded/Decoded, etc. Unknown value types become their
     * toString(). The callback is invoked with null if peer is unknown.
     */
    fun getStats(peerId: String, callback: (com.getcapacitor.JSObject?) -> Unit) {
        val pc = peerConnections[peerId]
        if (pc == null) {
            Log.e(TAG, "[$peerId] getStats: no PeerConnection")
            callback(null)
            return
        }
        try {
            pc.getStats { rtcStatsReport ->
                val report = com.getcapacitor.JSObject()
                try {
                    for ((id, stat) in rtcStatsReport.statsMap) {
                        val entry = com.getcapacitor.JSObject().apply {
                            put("id", id)
                            put("type", stat.type ?: "")
                            put("timestamp", stat.timestampUs)
                        }
                        for ((memberName, memberValue) in stat.members) {
                            if (memberValue == null) continue
                            when (memberValue) {
                                is Number -> entry.put(memberName, memberValue)
                                is Boolean -> entry.put(memberName, memberValue)
                                is String -> entry.put(memberName, memberValue)
                                else -> entry.put(memberName, memberValue.toString())
                            }
                        }
                        report.put(id, entry)
                    }
                } catch (e: Exception) {
                    Log.w(TAG, "[$peerId] getStats: partial serialization failure", e)
                }
                callback(report)
            }
        } catch (e: Exception) {
            Log.e(TAG, "[$peerId] getStats threw", e)
            callback(null)
        }
    }

    // -----------------------------------------------------------------------
    // Local Media
    // -----------------------------------------------------------------------

    fun startLocalAudio(peerId: String) = synchronized(mediaLock) {
        startLocalAudioLocked(peerId)
    }

    private fun startLocalAudioLocked(peerId: String) {
        Log.d("WebRTCAudio", "startLocalAudio: begin, peerId=$peerId")

        // === OEM audio fix (Xiaomi MIUI / Realme UI / INFINIX XOS) ===
        // Must configure AudioManager BEFORE creating AudioTrack.
        // Chinese OEM firmwares aggressively mute the mic if VoIP mode
        // isn't established before the first audio capture starts.
        try {
            val audioManager = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager

            // 1. Force VoIP mode — must happen before AudioTrack creation.
            // Through the router so the write has an owner: a timeline entry,
            // the persisted session marker and a watchdog that resets it when
            // the call never reaches AudioRouter.start().
            AudioRouter.getSharedInstance(context).ensureCommunicationMode("startLocalAudio")

            // 2. Ensure mic is not muted at system level (some ROMs persist mute)
            if (audioManager.isMicrophoneMute) {
                audioManager.isMicrophoneMute = false
                Log.w("WebRTCAudio", "startLocalAudio: system mic was muted — force-unmuted")
            }

            // 3. Disable speakerphone initially (AudioRouter sets correct device later)
            @Suppress("DEPRECATION")
            audioManager.isSpeakerphoneOn = false

            Log.d("WebRTCAudio", "startLocalAudio: AudioManager configured " +
                "(mode=${audioManager.mode}, micMute=${audioManager.isMicrophoneMute})")
        } catch (e: Exception) {
            Log.w("WebRTCAudio", "startLocalAudio: failed to set audio mode", e)
        }

        localAudioTrack?.let { track ->
            Log.d("WebRTCAudio", "startLocalAudio: track already exists, reusing for peerId=$peerId")
            attachLocalTrackLocked(track, "audio", peerId, "startLocalAudio(reuse)")
            return
        }

        Log.d("WebRTCAudio", "startLocalAudio: creating AudioSource with constraints")
        val audioConstraints = MediaConstraints().apply {
            mandatory.add(MediaConstraints.KeyValuePair("googEchoCancellation", "true"))
            mandatory.add(MediaConstraints.KeyValuePair("googNoiseSuppression", "true"))
            mandatory.add(MediaConstraints.KeyValuePair("googAutoGainControl", "true"))
        }

        localAudioSource = factory?.createAudioSource(audioConstraints)
        if (localAudioSource == null) {
            // Fire the diagnostic event first so JS listeners (bug reports,
            // telemetry) can observe the failure cause before we unwind.
            Log.e("WebRTCAudio", "startLocalAudio: AudioSource creation FAILED — factory=$factory")
            onAudioError?.invoke("audio_source_failed", "AudioSource creation failed")
            // Bail out of the call setup. Prior behaviour was to `return` here,
            // which let the SDK continue with an empty-track PC and produced
            // the mass "no audio after connected" reports (#169, #432, #391,
            // #392, #398, #404, #406, #408). Surfacing the exception causes
            // WebRTCPlugin to reject the PluginCall, which propagates to the
            // JS proxy's nativeGetUserMedia and aborts call.placeCall/answer.
            throw AudioInitException(
                reason = "audio_source_failed",
                message = "AudioSource creation failed (factory returned null)",
            )
        }
        Log.d("WebRTCAudio", "startLocalAudio: AudioSource created OK")

        localAudioTrack = factory?.createAudioTrack("audio0", localAudioSource)
        if (localAudioTrack == null) {
            Log.e("WebRTCAudio", "startLocalAudio: AudioTrack creation FAILED")
            onAudioError?.invoke("audio_source_failed", "AudioTrack creation failed")
            // Clean up the half-built AudioSource before unwinding so it does
            // not leak into a future startLocalAudio retry (the early-return
            // guard above reads `localAudioTrack != null`, not AudioSource).
            try { localAudioSource?.dispose() } catch (_: Exception) {}
            localAudioSource = null
            throw AudioInitException(
                reason = "audio_source_failed",
                message = "AudioTrack creation failed",
            )
        }
        localAudioTrack?.setEnabled(true)
        Log.d("WebRTCAudio", "startLocalAudio: AudioTrack created and enabled")

        localAudioTrack?.let { attachLocalTrackLocked(it, "audio", peerId, "startLocalAudio") }
        Log.d("WebRTCAudio", "startLocalAudio: complete, pcs=${peerConnections.size}")
    }

    /**
     * Under [mediaLock] like [startLocalAudio]. Two threads used to reach this
     * for one outgoing video call: the plugin thread from `startLocalMedia`,
     * and the main thread from `CallActivity.initVideoRenderers` —
     * `launchCallUI` is sent before `placeVideoCall`, and the Activity comes
     * up while the SDK is still acquiring media. Unlocked, both passed the
     * `localVideoTrack == null` check and each opened the camera: the second
     * capturer never got frames, the first leaked with the camera held, and
     * the peer connection carried whichever track was assigned last — a local
     * preview that works and a black picture on the far side.
     *
     * The Activity now binds its preview through [attachLocalRenderer] and
     * leaves the camera to the plugin thread. The main thread still lands
     * here from the camera-permission result and the in-call video toggle,
     * both mid-setup or mid-call, never while the media-release worker is
     * tearing a call down — so the lock is contended only by the plugin
     * thread's own startLocalMedia, and the wait is one camera open.
     */
    fun startLocalVideo(peerId: String, renderer: SurfaceViewRenderer? = null) = synchronized(mediaLock) {
        startLocalVideoLocked(peerId, renderer)
    }

    private fun startLocalVideoLocked(peerId: String, renderer: SurfaceViewRenderer?) {
        localVideoTrack?.let { track ->
            // Already started — attach renderer if provided (e.g. CallActivity opened after track creation)
            if (renderer != null && renderer != localRenderer) {
                localRenderer?.let { track.removeSink(it) }
                localRenderer = renderer
                applySelfViewMirror(renderer)
                track.addSink(renderer)
            }
            attachLocalTrackLocked(track, "video", peerId, "startLocalVideo(reuse)")
            return
        }

        val enumerator = Camera2Enumerator(context)
        val cameraName = enumerator.deviceNames.firstOrNull { enumerator.isFrontFacing(it) }
            ?: enumerator.deviceNames.firstOrNull()
            ?: run {
                Log.e(TAG, "No camera found")
                return
            }

        videoCapturer = enumerator.createCapturer(cameraName, null)
        cameraFrontFacing = enumerator.isFrontFacing(cameraName)
        surfaceTextureHelper = SurfaceTextureHelper.create("CaptureThread", eglBase!!.eglBaseContext)
        localVideoSource = factory?.createVideoSource(videoCapturer!!.isScreencast)
        videoCapturer?.initialize(surfaceTextureHelper, context, localVideoSource?.capturerObserver)
        videoCapturer?.startCapture(VIDEO_WIDTH, VIDEO_HEIGHT, VIDEO_FPS)

        val track = factory?.createVideoTrack("video0", localVideoSource)
        localVideoTrack = track
        track?.setEnabled(true)

        // The preview bound by CallActivity before the track existed is picked
        // up here. Order matters for the race with attachLocalRenderer: the
        // track is published above, the renderer read below (see there).
        (renderer ?: localRenderer)?.let { sink ->
            localRenderer = sink
            applySelfViewMirror(sink)
            track?.addSink(sink)
        }

        track?.let { attachLocalTrackLocked(it, "video", peerId, "startLocalVideo") }
        Log.d(TAG, "Local video started with camera: $cameraName (peerId=$peerId, pcs=${peerConnections.size})")
    }

    /**
     * The one place a local track is added to a peer connection. Snapshots
     * what every connection's senders already carry and lets
     * [TrackAttachPolicy] pick the targets, so a surviving track reaches the
     * connections that lack it and is never added twice to one that has it
     * (libwebrtc throws on the second addTrack). A connection whose senders
     * cannot be read is mid-teardown and is left alone. addTrack failures
     * propagate as before — a call that cannot carry its track must fail
     * where the caller can see it, not go silent.
     */
    private fun attachLocalTrackLocked(track: MediaStreamTrack, kind: String, peerId: String, from: String) {
        val sendersByPc = LinkedHashMap<String, Set<String>>()
        for ((id, pc) in peerConnections) {
            val held = runCatching { pc.senders.mapNotNull { it.track()?.id() }.toSet() }
                .onFailure { Log.w(TAG, "[$id] $from: senders unreadable, skipping this connection", it) }
                .getOrNull() ?: continue
            sendersByPc[id] = held
        }
        if (peerId.isNotEmpty() && peerId !in sendersByPc) {
            Log.w(TAG, "$from: no PeerConnection for peerId=$peerId — $kind track not added")
            return
        }
        val targets = TrackAttachPolicy.targets(peerId, track.id(), sendersByPc)
        if (targets.isEmpty()) {
            if (sendersByPc.isEmpty()) {
                Log.d(TAG, "$from: no PeerConnection yet, $kind track will be attached at createPeerConnection")
            } else {
                Log.d(TAG, "$from: $kind track already on every connection (peerId=$peerId, pcs=${sendersByPc.size})")
            }
            return
        }
        for (id in targets) {
            val pc = peerConnections[id] ?: continue
            pc.addTrack(track, listOf("stream0"))
            Log.d(TAG, "[$id] $from: attached $kind track")
        }
    }

    /**
     * CallActivity's entry point for the self-view: binds the renderer without
     * touching the camera or [mediaLock]. Creating the capturer is
     * `startLocalMedia`'s job on the plugin thread for every video call;
     * doing it here as well was the second camera open behind the black
     * far-side picture (O11). Lock-free on purpose — the main thread must not
     * wait behind the media-release worker's teardown. The race with the
     * fresh path in [startLocalVideoLocked] is closed by order: this writes
     * the renderer, then reads the track; the fresh path publishes the track,
     * then reads the renderer. Both fields are volatile, so at least one side
     * attaches, and `VideoTrack.addSink` is idempotent when both do.
     */
    fun attachLocalRenderer(renderer: SurfaceViewRenderer) {
        val previous = localRenderer
        localRenderer = renderer
        applySelfViewMirror(renderer)
        val track = localVideoTrack ?: return
        runCatching {
            if (previous != null && previous !== renderer) track.removeSink(previous)
            track.addSink(renderer)
        }.onFailure { Log.w(TAG, "attachLocalRenderer on a disposed track", it) }
    }

    /**
     * Draws the self-view the way its camera sees: mirrored for the front
     * camera, as-is for the back one ([SelfViewMirror]). Only the preview is
     * mirrored, never the frames sent to the other side. `setMirror` stores a
     * flag under the renderer's own lock, so the main, plugin and camera
     * threads may all call this; each writes its own field before reading the
     * other's, so the last renderer and the last facing always meet.
     */
    private fun applySelfViewMirror(renderer: SurfaceViewRenderer? = localRenderer) {
        renderer?.setMirror(SelfViewMirror.isMirrored(cameraFrontFacing))
    }

    fun setVideoEnabled(enabled: Boolean) {
        runCatching { localVideoTrack?.setEnabled(enabled) }
            .onFailure { Log.w(TAG, "setVideoEnabled on a disposed track", it) }
        if (enabled && videoCapturer == null) {
            startLocalVideo("", localRenderer)
        }
    }

    fun setAudioEnabled(enabled: Boolean) {
        // Reached from the audio-focus listener on the main thread while a call
        // is being torn down on another; a disposed track must not take the UI
        // thread with it.
        runCatching { localAudioTrack?.setEnabled(enabled) }
            .onFailure { Log.w(TAG, "setAudioEnabled on a disposed track", it) }
    }

    /** Whether the local mic track is live; null without a track. */
    fun isAudioEnabled(): Boolean? = runCatching { localAudioTrack?.enabled() }.getOrNull()

    fun switchCamera() {
        runCatching {
            videoCapturer?.switchCamera(object : CameraVideoCapturer.CameraSwitchHandler {
                override fun onCameraSwitchDone(isFrontFacing: Boolean) {
                    Log.d(TAG, "Camera switched, front: $isFrontFacing")
                    cameraFrontFacing = isFrontFacing
                    applySelfViewMirror()
                }
                override fun onCameraSwitchError(error: String) {
                    Log.e(TAG, "Camera switch error: $error")
                }
            })
        }.onFailure { Log.w(TAG, "switchCamera on a disposed capturer", it) }
    }

    // -----------------------------------------------------------------------
    // Screen Sharing (MediaProjection)
    // -----------------------------------------------------------------------

    fun startScreenCapture(resultCode: Int, data: Intent) {
        if (isScreenSharing) return

        // Pause camera
        videoCapturer?.stopCapture()
        localVideoTrack?.setEnabled(false)

        screenSurfaceHelper = SurfaceTextureHelper.create("ScreenCaptureThread", eglBase!!.eglBaseContext)
        screenVideoSource = factory?.createVideoSource(true) // isScreencast = true
        screenCapturer = ScreenCapturerAndroid(data, object : MediaProjection.Callback() {
            override fun onStop() {
                Log.d(TAG, "MediaProjection stopped")
                stopScreenCapture()
            }
        })
        screenCapturer?.initialize(screenSurfaceHelper, context, screenVideoSource?.capturerObserver)
        screenCapturer?.startCapture(VIDEO_WIDTH, VIDEO_HEIGHT, VIDEO_FPS)

        screenVideoTrack = factory?.createVideoTrack("screen0", screenVideoSource)
        screenVideoTrack?.setEnabled(true)

        // Replace camera track with screen track on all active peer connections
        for ((_, pc) in peerConnections) {
            val videoSender = pc.senders?.firstOrNull { it.track()?.kind() == "video" }
            if (videoSender != null) {
                videoSender.setTrack(screenVideoTrack, false)
            } else {
                pc.addTrack(screenVideoTrack, listOf("screen_stream"))
            }
        }

        isScreenSharing = true
        Log.d(TAG, "Screen capture started")
    }

    fun stopScreenCapture() {
        if (!isScreenSharing) return

        try {
            screenCapturer?.stopCapture()
        } catch (e: Exception) {
            Log.e(TAG, "Error stopping screen capture", e)
        }
        screenCapturer?.dispose()
        screenCapturer = null
        screenSurfaceHelper?.dispose()
        screenSurfaceHelper = null
        screenVideoTrack?.dispose()
        screenVideoTrack = null
        screenVideoSource?.dispose()
        screenVideoSource = null

        // Restore camera track on all active peer connections
        for ((_, pc) in peerConnections) {
            val videoSender = pc.senders?.firstOrNull { it.track()?.kind() == "video" || it.track() == null }
            if (videoSender != null && localVideoTrack != null) {
                videoSender.setTrack(localVideoTrack, false)
            }
        }
        localVideoTrack?.setEnabled(true)
        videoCapturer?.startCapture(VIDEO_WIDTH, VIDEO_HEIGHT, VIDEO_FPS)

        isScreenSharing = false
        Log.d(TAG, "Screen capture stopped, camera restored")
    }

    fun isScreenSharing(): Boolean = isScreenSharing

    // -----------------------------------------------------------------------
    // Remote Media
    // -----------------------------------------------------------------------

    /** Shows the remote video on [renderer], including tracks that arrived before it. */
    fun attachRemoteRenderer(renderer: SurfaceViewRenderer) {
        remoteVideo.attach(renderer)
    }

    /** Takes a closing call screen's renderer off the remote tracks before it is released. */
    fun detachRemoteRenderer(renderer: SurfaceViewRenderer) {
        remoteVideo.detach(renderer)
    }

    fun hasRemoteVideoTracks(): Boolean {
        return remoteVideo.tracks().any { it.enabled() }
    }

    // -----------------------------------------------------------------------
    // Stats & Info
    // -----------------------------------------------------------------------

    fun getConnectionState(peerId: String): String {
        return peerConnections[peerId]?.connectionState()?.name ?: "UNKNOWN"
    }

    // -----------------------------------------------------------------------
    // Cleanup
    // -----------------------------------------------------------------------

    /**
     * libwebrtc keeps one recording switch per factory, shared by every
     * connection. [stopAudioRecording] lowers it for all of them, so each new
     * connection raises it again before a local track can start sending.
     */
    private fun enableAudioRecording(pc: PeerConnection, peerId: String) {
        try {
            pc.setAudioRecording(true)
        } catch (e: Exception) {
            Log.e(TAG, "[$peerId] Could not enable audio recording", e)
        }
    }

    /**
     * Stops the device's audio recorder before the last connection closes.
     * close() stops it only for a connection that reached STABLE: an outgoing
     * call closed in HAVE_LOCAL_OFFER, which nobody answered, left
     * WebRtcAudioRecordExternal recording until the process died, and the mic
     * indicator stayed lit with no call.
     */
    private fun stopAudioRecording(pc: PeerConnection, peerId: String) {
        try {
            pc.setAudioRecording(false)
            Log.d(TAG, "[$peerId] Audio recording stopped before close")
        } catch (e: Exception) {
            Log.e(TAG, "[$peerId] Could not stop audio recording", e)
        }
    }

    fun closePeerConnection(peerId: String) {
        val pc = peerConnections.remove(peerId)
        remoteVideo.forgetPeer(peerId)
        if (pc != null) {
            if (peerConnections.isEmpty()) stopAudioRecording(pc, peerId)
            try {
                pc.close()
            } catch (e: Exception) {
                Log.e(TAG, "[$peerId] Error closing peer connection", e)
            }
            Log.d(TAG, "[$peerId] PeerConnection closed (remaining: ${peerConnections.size})")
        }

        // Only stop local media if no more active PCs
        if (peerConnections.isEmpty()) {
            stopLocalMedia()
            listener = null
        }
    }

    private fun stopLocalMedia() = synchronized(mediaLock) {
        stopLocalMediaLocked()
    }

    private fun stopLocalMediaLocked() {
        localVideoTrack?.let { track ->
            localRenderer?.let { track.removeSink(it) }
        }
        videoCapturer?.stopCapture()
        videoCapturer?.dispose()
        videoCapturer = null
        cameraFrontFacing = null
        surfaceTextureHelper?.dispose()
        surfaceTextureHelper = null

        localVideoTrack?.dispose()
        localVideoTrack = null
        localVideoSource?.dispose()
        localVideoSource = null

        localAudioTrack?.dispose()
        localAudioTrack = null
        localAudioSource?.dispose()
        localAudioSource = null
    }

    fun closeAllPeerConnections() = synchronized(mediaLock) {
        closeAllPeerConnectionsLocked()
    }

    private fun closeAllPeerConnectionsLocked() {
        val connections = peerConnections.toMap()
        connections.entries.firstOrNull()?.let { (peerId, pc) -> stopAudioRecording(pc, peerId) }
        for ((peerId, pc) in connections) {
            try { pc.close() } catch (_: Exception) {}
            Log.d(TAG, "[$peerId] Closed")
        }
        peerConnections.clear()
        remoteVideo.forgetAll()
        stopLocalMediaLocked()
        listener = null
        Log.d(TAG, "All PeerConnections closed")
    }

    fun dispose() {
        closeAllPeerConnections()

        factory?.dispose()
        factory = null
        synchronized(eglLock) {
            eglBase?.release()
            eglBase = null
        }
        isInitialized = false
        Log.d(TAG, "Disposed")
    }
}
