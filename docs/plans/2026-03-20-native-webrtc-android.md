# Native Android WebRTC Calling — Design Document

## 1. Overview

Bastyon Chat's calling feature is the app's core functionality and must deliver maximum quality on Android. This design replaces the current WebView-based WebRTC with a **native Android WebRTC engine** while keeping Matrix SDK signaling in WebView.

### Approach: Hybrid C
- **Media layer**: Fully native WebRTC (Google's libwebrtc for Android)
- **Signaling layer**: Matrix SDK in WebView (unchanged)
- **Background support**: Foreground Service keeps WebView alive for signaling
- **Call UI**: Native Android Activity with SurfaceViewRenderer

### Scope
- 1-on-1 voice and video calls
- Screen sharing (native MediaProjection)
- Picture-in-Picture mode
- Background call support (app killed → push → service → call)

---

## 2. Current Architecture

```
┌─────────────────────────────────────────────┐
│                  WebView                     │
│  ┌─────────────────────────────────────────┐ │
│  │  matrix-js-sdk-bastyon                  │ │
│  │  ├── Signaling (m.call.invite/answer)   │ │
│  │  ├── ICE candidates exchange            │ │
│  │  └── TURN server fetch                  │ │
│  ├─────────────────────────────────────────┤ │
│  │  Browser WebRTC (RTCPeerConnection)     │ │
│  │  ├── SDP negotiation                    │ │
│  │  ├── Media capture (getUserMedia)       │ │
│  │  └── Video rendering (<video> tags)     │ │
│  ├─────────────────────────────────────────┤ │
│  │  call-service.ts                        │ │
│  │  ├── Call lifecycle management           │ │
│  │  └── Device selection                   │ │
│  └─────────────────────────────────────────┘ │
├─────────────────────────────────────────────┤
│           Capacitor Bridge                   │
├─────────────────────────────────────────────┤
│  CallPlugin (NativeCall)                     │
│  ├── reportIncomingCall → TelecomManager     │
│  ├── reportOutgoingCall                      │
│  └── reportCallEnded                         │
│  CallConnectionService (SELF_MANAGED)        │
│  IncomingCallActivity (lock screen UI)       │
└─────────────────────────────────────────────┘
```

### Problems with current approach
1. **WebView WebRTC quality** — limited camera control, no hardware acceleration for encoding, poor battery efficiency
2. **No native UI** — after answering, user sees web-based call interface
3. **No background support** — WebView suspended when app backgrounded, call drops
4. **No PiP** — can't overlay call on other apps
5. **Limited audio routing** — no native speaker/earpiece/bluetooth control

---

## 3. Target Architecture

```
┌─────────────────────────────────────────────┐
│                  WebView                     │
│  ┌─────────────────────────────────────────┐ │
│  │  matrix-js-sdk-bastyon                  │ │
│  │  ├── Signaling (m.call.invite/answer)   │ │
│  │  ├── ICE candidates exchange            │ │
│  │  └── TURN server fetch                  │ │
│  ├─────────────────────────────────────────┤ │
│  │  call-service.ts (MODIFIED)             │ │
│  │  ├── Intercepts SDP/ICE from SDK        │ │
│  │  ├── Forwards to native via bridge      │ │
│  │  └── No browser RTCPeerConnection       │ │
│  └─────────────────────────────────────────┘ │
├─────────────────────────────────────────────┤
│         Capacitor Bridge (EXPANDED)          │
│  NativeWebRTC plugin methods:                │
│  ├── createPeerConnection(iceServers)        │
│  ├── setLocalDescription(sdp)                │
│  ├── setRemoteDescription(sdp)               │
│  ├── addIceCandidate(candidate)              │
│  ├── createOffer() / createAnswer()          │
│  ├── setAudioEnabled(bool)                   │
│  ├── setVideoEnabled(bool)                   │
│  ├── switchCamera()                          │
│  ├── startScreenShare() / stopScreenShare()  │
│  ├── setAudioRoute(speaker/earpiece/bt)      │
│  └── Events: onIceCandidate, onTrack,        │
│       onConnectionStateChange                │
├─────────────────────────────────────────────┤
│           Native Android Layer               │
│  ┌─────────────────────────────────────────┐ │
│  │  NativeWebRTCManager                    │ │
│  │  ├── PeerConnectionFactory (HW accel)   │ │
│  │  ├── Camera2Capturer (front/back)       │ │
│  │  ├── JavaAudioDeviceModule              │ │
│  │  ├── MediaProjection (screen share)     │ │
│  │  └── Tor proxy for ICE/TURN traffic     │ │
│  ├─────────────────────────────────────────┤ │
│  │  CallActivity (NATIVE UI)              │ │
│  │  ├── SurfaceViewRenderer (remote video) │ │
│  │  ├── SurfaceViewRenderer (local preview)│ │
│  │  ├── Call controls toolbar              │ │
│  │  ├── PiP support                        │ │
│  │  └── Proximity sensor                   │ │
│  ├─────────────────────────────────────────┤ │
│  │  CallForegroundService                  │ │
│  │  ├── Keeps WebView signaling alive      │ │
│  │  ├── Persistent notification            │ │
│  │  ├── Audio focus management             │ │
│  │  └── Wakelock                           │ │
│  ├─────────────────────────────────────────┤ │
│  │  CallConnectionService (existing)       │ │
│  │  └── System call integration            │ │
│  └─────────────────────────────────────────┘ │
└─────────────────────────────────────────────┘
```

---

## 4. Component Design

### 4.1 NativeWebRTCManager

Core native class managing WebRTC peer connection lifecycle.

```kotlin
class NativeWebRTCManager(private val context: Context) {
    private var factory: PeerConnectionFactory
    private var peerConnection: PeerConnection?
    private var localVideoTrack: VideoTrack?
    private var localAudioTrack: AudioTrack?
    private var videoCapturer: CameraVideoCapturer?
    private var surfaceTextureHelper: SurfaceTextureHelper?
    private var eglBase: EglBase

    // Initialization with hardware acceleration
    fun initialize()

    // Peer connection management
    fun createPeerConnection(iceServers: List<IceServer>, listener: PeerConnectionListener)
    fun createOffer(): SessionDescription
    fun createAnswer(): SessionDescription
    fun setLocalDescription(sdp: SessionDescription)
    fun setRemoteDescription(sdp: SessionDescription)
    fun addIceCandidate(candidate: IceCandidate)

    // Media control
    fun startLocalVideo(surfaceRenderer: SurfaceViewRenderer)
    fun startLocalAudio()
    fun setVideoEnabled(enabled: Boolean)
    fun setAudioEnabled(enabled: Boolean)
    fun switchCamera()
    fun setAudioRoute(route: AudioRoute) // SPEAKER, EARPIECE, BLUETOOTH

    // Screen sharing
    fun startScreenCapture(resultCode: Int, data: Intent)
    fun stopScreenCapture()

    // Cleanup
    fun dispose()
}
```

**Key implementation details:**
- `PeerConnectionFactory` initialized with `DefaultVideoEncoderFactory` and `DefaultVideoDecoderFactory` for hardware H.264/VP8
- `EglBase` shared context for video rendering
- Camera2 API via `Camera2Enumerator` for modern camera access
- Audio via `JavaAudioDeviceModule` with echo cancellation and noise suppression
- Tor proxy: configure ICE transport via `PeerConnection.RTCConfiguration.iceTransportPolicy` and custom `TurnCustomizer`

### 4.2 Signaling Bridge (TypeScript side)

Modified call-service.ts to intercept Matrix SDK's WebRTC operations.

```typescript
// native-webrtc-bridge.ts

interface NativeWebRTCPlugin {
  createPeerConnection(options: { iceServers: RTCIceServer[] }): Promise<void>;
  createOffer(): Promise<{ sdp: string; type: string }>;
  createAnswer(): Promise<{ sdp: string; type: string }>;
  setLocalDescription(options: { sdp: string; type: string }): Promise<void>;
  setRemoteDescription(options: { sdp: string; type: string }): Promise<void>;
  addIceCandidate(options: {
    candidate: string;
    sdpMid: string;
    sdpMLineIndex: number;
  }): Promise<void>;
  setAudioEnabled(options: { enabled: boolean }): Promise<void>;
  setVideoEnabled(options: { enabled: boolean }): Promise<void>;
  switchCamera(): Promise<void>;
  setAudioRoute(options: {
    route: "speaker" | "earpiece" | "bluetooth";
  }): Promise<void>;
  startScreenShare(): Promise<void>;
  stopScreenShare(): Promise<void>;
  hangup(): Promise<void>;

  // Events from native
  addListener(
    event: "onIceCandidate",
    handler: (data: IceCandidateData) => void
  ): PluginListenerHandle;
  addListener(
    event: "onConnectionStateChange",
    handler: (data: { state: string }) => void
  ): PluginListenerHandle;
  addListener(
    event: "onTrack",
    handler: (data: { kind: string }) => void
  ): PluginListenerHandle;
}
```

**Integration strategy with Matrix SDK:**

The matrix-js-sdk-bastyon creates its own RTCPeerConnection internally. We need to intercept this. Two options:

**Option 1: Monkey-patch RTCPeerConnection** (simpler)
- Replace `window.RTCPeerConnection` with a proxy that routes to native
- SDK thinks it's using browser WebRTC but actually using native
- Requires careful handling of all RTCPeerConnection API surface

**Option 2: Fork SDK call module** (cleaner but more maintenance)
- Modify the call module in matrix-js-sdk-bastyon to accept an external PeerConnection provider
- Pass native bridge as provider on mobile

**Recommendation: Option 1** — monkey-patching is less invasive and doesn't require SDK changes. The proxy class intercepts:
- `new RTCPeerConnection(config)` → `NativeWebRTC.createPeerConnection(config)`
- `pc.createOffer()` → `NativeWebRTC.createOffer()`
- `pc.setLocalDescription(sdp)` → `NativeWebRTC.setLocalDescription(sdp)`
- `pc.addIceCandidate(candidate)` → `NativeWebRTC.addIceCandidate(candidate)`
- `pc.onicecandidate` → event from `NativeWebRTC.onIceCandidate`
- `getUserMedia()` → returns dummy stream (native handles real media)

### 4.3 CallActivity (Native UI)

```
┌────────────────────────────────┐
│          Status Bar            │  ← Call duration / "Connecting..."
├────────────────────────────────┤
│                                │
│                                │
│     Remote Video               │  ← SurfaceViewRenderer (full screen)
│     (SurfaceViewRenderer)      │
│                                │
│                                │
│  ┌──────────┐                  │
│  │ Local    │                  │  ← Draggable local preview
│  │ Preview  │                  │
│  └──────────┘                  │
├────────────────────────────────┤
│  Caller Name                   │
│  Call Status                   │
├────────────────────────────────┤
│                                │
│  [Mute] [Video] [Flip] [Speaker] ← Toggle buttons with icons
│                                │
│         [Screen Share]          │
│                                │
│       ( Hang Up )              │  ← Red circular button
│                                │
└────────────────────────────────┘
```

**Features:**
- Full-screen remote video with local preview overlay (corner, draggable)
- Animated control bar (auto-hide after 5s, show on tap)
- Proximity sensor: dims screen and disables touch during voice call when near ear
- PiP: enters PiP on home button press during video call
- Lock screen: shows over lock screen with accept/reject for incoming
- Orientation: supports portrait and landscape
- Smooth transitions: fade in/out for video enable/disable

### 4.4 CallForegroundService

```kotlin
class CallForegroundService : Service() {
    private var webView: WebView?  // Lightweight WebView for signaling
    private var wakeLock: PowerManager.WakeLock?
    private var audioFocusRequest: AudioFocusRequest?

    // Start with persistent notification
    fun startCallService(callInfo: CallInfo)

    // Audio focus management
    fun requestAudioFocus()
    fun abandonAudioFocus()

    // WebView management for background signaling
    fun ensureSignalingWebView()

    // Notification updates
    fun updateNotification(status: String, duration: String)

    // Cleanup
    fun stopCallService()
}
```

**Push-to-call flow when app is killed:**
1. FCM push received with call data
2. Push handler starts CallForegroundService
3. Service shows full-screen notification (incoming call)
4. Service starts lightweight WebView for Matrix signaling
5. User answers → native WebRTC connects using signaling from WebView
6. CallActivity launched with native video/audio

### 4.5 Tor Proxy Integration

WebRTC ICE/TURN traffic should route through Tor where possible:
- TURN server connections: route through HTTP proxy at 127.0.0.1:8181
- ICE candidates: prefer relay candidates (TURN) to avoid IP leaks
- Configuration: `iceTransportPolicy: "relay"` when Tor mode is "always"
- When Tor mode is "auto"/"never": allow direct connections for better quality

---

## 5. Data Flow

### 5.1 Outgoing Call

```
User taps "Call" in chat
    │
    ▼
call-service.ts: startCall(roomId, type)
    │
    ├── NativeWebRTC.createPeerConnection(iceServers)
    │       → Native: PeerConnectionFactory.createPeerConnection()
    │
    ├── Matrix SDK: call.placeVideoCall()
    │       → SDK creates offer internally
    │       → Intercepted by RTCPeerConnection proxy
    │       → NativeWebRTC.createOffer()
    │           → Native: peerConnection.createOffer()
    │           → Returns SDP to proxy
    │       → SDK sends offer via Matrix events
    │
    ├── CallPlugin.reportOutgoingCall()
    │       → ConnectionService notified
    │       → CallActivity launched
    │       → Native UI shown with local preview
    │
    ▼
Remote peer answers
    │
    ├── Matrix SDK receives m.call.answer
    │       → SDK calls pc.setRemoteDescription(answer)
    │       → Intercepted → NativeWebRTC.setRemoteDescription()
    │
    ├── ICE candidates exchanged (both directions)
    │       → SDK ↔ Native bridge ↔ PeerConnection
    │
    ▼
Media flows through native WebRTC
    → Remote video rendered in CallActivity SurfaceViewRenderer
    → Local camera via Camera2Capturer
    → Audio via JavaAudioDeviceModule
```

### 5.2 Incoming Call (App Alive)

```
Matrix SDK receives m.call.invite
    │
    ▼
call-service.ts: handleIncomingCall(call)
    │
    ├── CallPlugin.reportIncomingCall()
    │       → TelecomManager / IncomingCallActivity
    │       → Ringtone + vibration
    │       → Full-screen notification
    │
    ▼
User answers
    │
    ├── NativeWebRTC.createPeerConnection(iceServers)
    ├── call.answer() → SDK generates answer
    │       → Intercepted → NativeWebRTC.createAnswer()
    │       → SDK sends answer via Matrix events
    │
    ├── CallActivity launched with native UI
    │
    ▼
Media flows natively
```

### 5.3 Incoming Call (App Killed)

```
FCM Push received
    │
    ▼
PushReceiver: startForegroundService
    │
    ├── CallForegroundService starts
    │       → Shows full-screen incoming call notification
    │       → Starts lightweight WebView
    │       → Matrix SDK connects and syncs
    │       → Incoming call event received
    │
    ├── IncomingCallActivity shown (lock screen compatible)
    │       → Ringtone + vibration
    │
    ▼
User answers
    │
    ├── NativeWebRTC initialized
    ├── Matrix SDK answers call via WebView signaling
    ├── SDP/ICE bridged to native
    ├── CallActivity launched
    │
    ▼
Media flows natively
```

---

## 6. Dependencies

### Android (build.gradle)
```groovy
// Google's WebRTC library
implementation 'org.webrtc:google-webrtc:1.0.32006'

// Firebase Cloud Messaging (for push)
implementation 'com.google.firebase:firebase-messaging:24.1.0'

// AndroidX (already present)
implementation 'androidx.core:core-ktx:1.15.0'
```

### Permissions (AndroidManifest.xml additions)
```xml
<!-- Already present -->
<uses-permission android:name="android.permission.CAMERA" />
<uses-permission android:name="android.permission.RECORD_AUDIO" />
<uses-permission android:name="android.permission.INTERNET" />
<uses-permission android:name="android.permission.FOREGROUND_SERVICE" />

<!-- New -->
<uses-permission android:name="android.permission.FOREGROUND_SERVICE_PHONE_CALL" />
<uses-permission android:name="android.permission.FOREGROUND_SERVICE_MEDIA_PROJECTION" />
<uses-permission android:name="android.permission.SYSTEM_ALERT_WINDOW" />  <!-- PiP -->
<uses-permission android:name="android.permission.BLUETOOTH_CONNECT" />    <!-- BT headset -->
```

---

## 7. Implementation Phases

### Phase 1: Native WebRTC Engine + Bridge (2-3 weeks)
**Goal:** Audio calls working through native WebRTC

Files to create:
- `android/.../plugins/webrtc/NativeWebRTCManager.kt` — PeerConnection lifecycle
- `android/.../plugins/webrtc/WebRTCPlugin.kt` — Capacitor plugin bridge
- `src/shared/lib/native-webrtc/rtc-peer-connection-proxy.ts` — RTCPeerConnection monkey-patch
- `src/shared/lib/native-webrtc/native-webrtc-bridge.ts` — TypeScript bridge

Files to modify:
- `android/app/build.gradle` — add org.webrtc dependency
- `android/.../MainActivity.kt` — register WebRTCPlugin
- `src/features/video-calls/model/call-service.ts` — activate proxy on native platform

Testing:
- [ ] Audio call connects via native WebRTC
- [ ] SDP/ICE exchanged correctly through bridge
- [ ] Audio quality comparable or better than WebView
- [ ] Call can be answered and hung up

### Phase 2: Native Call UI (1-2 weeks)
**Goal:** Full native call screen with video

Files to create:
- `android/.../plugins/calls/CallActivity.kt` — Native call Activity
- `android/app/src/main/res/layout/activity_call.xml` — Call UI layout
- `android/app/src/main/res/layout/pip_call.xml` — PiP layout
- `android/app/src/main/res/drawable/` — Call control icons

Files to modify:
- `android/.../plugins/calls/CallPlugin.kt` — launch CallActivity
- `android/.../plugins/webrtc/NativeWebRTCManager.kt` — video rendering
- `android/app/src/main/AndroidManifest.xml` — CallActivity declaration

Testing:
- [ ] Video call shows in native Activity
- [ ] Camera switching works (front/back)
- [ ] All controls functional (mute, video, speaker, hangup)
- [ ] Local preview draggable
- [ ] Proximity sensor works for voice calls

### Phase 3: Background & Foreground Service (1-2 weeks)
**Goal:** Calls survive app backgrounding; incoming calls when app killed

Files to create:
- `android/.../plugins/calls/CallForegroundService.kt` — Foreground service
- `android/.../plugins/calls/PushCallReceiver.kt` — FCM handler for calls

Files to modify:
- `android/app/src/main/AndroidManifest.xml` — service + receiver declarations
- `android/.../plugins/calls/CallPlugin.kt` — service lifecycle
- `src/features/video-calls/model/call-service.ts` — background awareness

Testing:
- [ ] Call continues when app backgrounded
- [ ] Incoming call works when app killed (via push)
- [ ] Notification shows with call controls
- [ ] Audio focus managed correctly (other apps pause)
- [ ] Wakelock prevents CPU sleep

### Phase 4: Screen Sharing & PiP (1 week)
**Goal:** Screen sharing from native side + Picture-in-Picture

Files to modify:
- `android/.../plugins/webrtc/NativeWebRTCManager.kt` — MediaProjection capture
- `android/.../plugins/calls/CallActivity.kt` — PiP mode
- `android/.../plugins/webrtc/WebRTCPlugin.kt` — screen share bridge methods

Testing:
- [ ] Screen sharing starts/stops correctly
- [ ] Remote peer sees shared screen
- [ ] PiP activates on home press during video call
- [ ] PiP shows remote video with basic controls
- [ ] Return to full UI from PiP

### Phase 5: Polish & Edge Cases (1 week)
- Network switching (WiFi to cellular) with ICE restart
- Bluetooth headset detection and audio routing
- Adaptive bitrate based on network conditions
- Error recovery and automatic reconnection
- Call quality metrics logging

---

## 8. Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| RTCPeerConnection proxy misses API surface | Calls fail silently | Comprehensive test suite; log all unproxied calls |
| Tor proxy + WebRTC latency | Poor call quality | Allow direct connections when Tor mode is "auto" |
| WebView killed by OS in background | Signaling lost, call drops | Foreground service with wakelock; lightweight WebView |
| Camera2 API variance across devices | Camera fails on some devices | Fallback to Camera1 via Camera1Enumerator |
| org.webrtc library size (~10MB) | APK size increase | Acceptable for core feature; use ABI splits |
| FCM delivery delays | Missed incoming calls | Persistent WebSocket connection as backup |

---

## 9. Success Metrics

- Call setup time < 3 seconds (native vs ~5s in WebView)
- Audio quality: MOS score > 4.0
- Video quality: 720p at 30fps sustained
- Battery usage: 30% improvement over WebView calls
- Background call survival: 100% with foreground service
- Crash rate during calls: < 0.1%
