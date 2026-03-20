# Capacitor Mobile App — Android Design Document

**Date:** 2026-03-19
**Scope:** Full native Android app — Tor + Push + Calls + Media
**Platform:** Android only (iOS later)

## Overview

Port the existing Vue 3 web chat into a native Android app using Capacitor. Four major subsystems:

1. **Tor Integration** — fork cordova-plugin-tor-runner as Capacitor plugin
2. **Push Notifications** — FCM data-only + local decrypt + Local Notifications
3. **Native Calls** — ConnectionService + Full-Screen Intent for incoming WebRTC calls
4. **Media/Files** — native streaming upload/download through Tor proxy

## Project Structure

```
new-bastyon-chat/
├── src/                          # Existing Vue code (shared web + mobile)
├── dist/                         # Vite build output → webDir for Capacitor
├── android/                      # Capacitor-generated
│   ├── app/
│   │   ├── src/main/java/com/bastyon/chat/
│   │   │   ├── MainActivity.kt
│   │   │   └── plugins/
│   │   │       ├── tor/          # Fork of cordova-plugin-tor-runner
│   │   │       │   ├── TorPlugin.kt
│   │   │       │   ├── TorManager.java
│   │   │       │   ├── StarterHelper.java
│   │   │       │   ├── ConfigurationManager.kt
│   │   │       │   └── ReverseProxyManager.java
│   │   │       ├── calls/        # ConnectionService for native calls
│   │   │       │   ├── CallPlugin.kt
│   │   │       │   ├── CallConnectionService.kt
│   │   │       │   └── IncomingCallActivity.kt
│   │   │       └── upload/       # Streaming upload/download via Tor
│   │   │           └── TorFilePlugin.kt
│   │   ├── src/main/jniLibs/
│   │   │   ├── armeabi-v7a/      # .so binaries from pocketnet
│   │   │   │   ├── libtor.so
│   │   │   │   ├── libreverseproxy.so
│   │   │   │   ├── libobfs4proxy.so
│   │   │   │   └── libsnowflake.so
│   │   │   └── arm64-v8a/
│   │   └── build.gradle
│   └── capacitor.config.ts
├── src/shared/lib/
│   ├── tor/tor-service.ts
│   ├── push/push-service.ts
│   ├── native-calls/native-call-bridge.ts
│   └── platform/index.ts
└── capacitor.config.ts
```

## 1. Tor Integration

### Source
Fork of `cordova-plugin-tor-runner` from `../pocketnet/cordova/plugins/cordova-plugin-tor-runner/`.

### What we reuse as-is
- All `.so` binaries: libtor, libreverseproxy, libobfs4proxy, libsnowflake, libconjure, libzmq, libc++_shared
- `TorManager.java` — start/stop/restart orchestration
- `StarterHelper.java` — libtor.so execution, bootstrap parsing ("Bootstrapped X%")
- `ReverseProxyManager.java` — libreverseproxy.so (HTTP→SOCKS bridge)
- `ConfigurationManager.kt` — torrc generation, bridge management
- GeoIP files

### What we rewrite
- Cordova `Plugin.java` → Capacitor `TorPlugin.kt` (new entry point with `@PluginMethod`)
- Remove Dagger DI → simple singleton
- Cordova `exec()` → Capacitor `notifyListeners()` for bootstrap events

### Ports (matching Pocketnet)
- SOCKS5: `9051`
- Control: `9251`
- Reverse Proxy (HTTP→SOCKS): `8181`

### Modes
- `neveruse` — direct connection
- `auto` — test accessibility, fallback to Tor
- `always` — Tor only

### Matrix SDK proxying
- Tor enabled: `baseUrl = http://127.0.0.1:8181` (reverse proxy → SOCKS → Tor)
- Tor disabled: `baseUrl = https://matrix.bastyon.com`
- Reverse proxy handles both HTTP and WebSocket

### JS API

```typescript
interface TorPlugin {
  startDaemon(options?: { mode: 'always' | 'auto'; bridgeType?: string }): Promise<{ socksPort: number; proxyPort: number }>;
  stopDaemon(): Promise<void>;
  getStatus(): Promise<{ progress: number; isReady: boolean; mode: string }>;
  configure(options: { mode: string; bridges?: string[] }): Promise<void>;
  addListener(event: 'bootstrapProgress', cb: (data: { progress: number }) => void): Promise<void>;
}
```

## 2. Push Notifications (Privacy-preserving)

### Architecture
```
Matrix Server → Push Gateway (bastyon) → FCM data-only push
                                              │
                                         App receives {event_id, room_id}
                                         → Fetch event via Tor
                                         → Decrypt E2EE locally
                                         → Show Local Notification with text
```

Message text never passes through Google/Apple servers.

### Push types

| Type | Trigger | FCM Priority | Action |
|------|---------|-------------|--------|
| Message | New message | Normal | Fetch → decrypt → Local Notification |
| Call | m.call.invite | High | ConnectionService → Full-Screen Intent |

### Plugins
- `@capacitor/push-notifications` — FCM token registration, data push receive
- `@capacitor/local-notifications` — display notification with decrypted text

### Matrix Pusher config
```typescript
{
  pushkey: fcmToken,
  kind: 'http',
  app_id: 'com.bastyon.chat',
  data: {
    url: 'https://push.bastyon.com/_matrix/push/v1/notify',
    format: 'event_id_only'
  }
}
```

## 3. Native Calls (ConnectionService)

### Flow
```
FCM data push {type: "call", room_id, event_id, caller_name}
    │
    ▼
CallPlugin.kt → reportIncomingCall()
    │
    ▼
ConnectionService + Full-Screen Intent
    │ Shows IncomingCallActivity (native screen)
    │ Ringtone + vibration
    │
    ├─ Accepted → Wake WebView → callService.answerCall(matrixCall)
    │             WebRTC P2P established
    │
    └─ Declined → ConnectionService.onReject() → callService.rejectCall()
```

### Native components (Kotlin)
- `CallPlugin.kt` — Capacitor plugin, bridge between JS and ConnectionService
- `CallConnectionService.kt` — Android ConnectionService, manages native call screen
- `IncomingCallActivity.kt` — Full-Screen Intent UI (caller name, Accept/Decline buttons)

### Integration with existing call-service.ts
- Background/locked: `NativeCallPlugin.reportIncomingCall()` → native UI
- Foreground: existing `IncomingCallModal.vue` (no change)
- `callAnswered` listener → `callService.answerCall()`
- `callDeclined` listener → `callService.rejectCall()`

### JS API
```typescript
interface NativeCallPlugin {
  reportIncomingCall(options: {
    callId: string;
    callerName: string;
    roomId: string;
    hasVideo: boolean;
  }): Promise<void>;
  reportCallEnded(options: { callId: string }): Promise<void>;
  addListener(event: 'callAnswered', cb: (data: { callId: string }) => void): void;
  addListener(event: 'callDeclined', cb: (data: { callId: string }) => void): void;
}
```

## 4. Media & Files (Streaming via Tor)

### Upload flow
```
Vue UI → @capacitor/camera (returns file:// URI, not base64)
       → @capacitor/filesystem (URI)
       → MediaRecorder → temp file URI
    │
    ▼
TorFilePlugin.kt (native)
    ├─ Stream-reads file (FileInputStream, no base64)
    ├─ Encrypts in chunks (AES-CTR for E2EE attachments)
    ├─ Uploads via OkHttp → libreverseproxy:8181 → Tor
    ├─ Sends progress events to JS
    └─ Returns Matrix content_uri (mxc://)
```

### Download flow (mirror)
```
mxc:// URL → TorFilePlugin.download()
    ├─ Downloads via OkHttp → Tor proxy
    ├─ Decrypts (AES-CTR)
    ├─ Saves to cache dir
    └─ Returns file:// URI to JS
```

### JS API
```typescript
interface TorFilePlugin {
  upload(options: {
    filePath: string;
    uploadUrl: string;
    mimeType: string;
    encrypt?: boolean;
  }): Promise<{ contentUri: string }>;

  download(options: {
    url: string;
    decrypt?: { key: string; iv: string };
  }): Promise<{ filePath: string }>;

  addListener(event: 'progress', cb: (data: { percent: number }) => void): void;
}
```

## 5. App Initialization Sequence

```
App Start
  ├─ 1. Capacitor init (WebView loads)
  ├─ 2. Vue mount → show Splash/Loading with Tor progress
  ├─ 3. TorService.init()
  │     ├─ startDaemon() → libtor.so starts
  │     ├─ bootstrapProgress: 0%...100%
  │     ├─ ReverseProxy starts on :8181
  │     └─ ready
  ├─ 4. Matrix SDK init (baseUrl = 127.0.0.1:8181 or direct)
  │     ├─ login / restore session
  │     └─ startClient() → /sync works through Tor
  ├─ 5. PushService.init()
  │     ├─ FCM register → get token
  │     └─ Matrix setPusher() → register on server
  └─ 6. App ready → show chat
```

## 6. Platform Abstraction

```typescript
// src/shared/lib/platform/index.ts
import { Capacitor } from '@capacitor/core';

export const isNative = Capacitor.isNativePlatform();
export const isAndroid = Capacitor.getPlatform() === 'android';
export const isWeb = !isNative;
```

### Platform guards needed in:
- `matrix-client.ts` → baseUrl selection (Tor proxy vs direct)
- `call-service.ts` → incoming call: NativeCallPlugin vs IncomingCallModal
- File upload → TorFilePlugin vs standard fetch
- Push → FCM vs absent (web uses Matrix /sync)

## Summary

| Component | Approach |
|-----------|----------|
| Tor | Fork cordova-plugin-tor-runner → Capacitor plugin, reverse proxy on :8181 |
| Proxying | Matrix SDK baseUrl → localhost:8181 → SOCKS :9051 → Tor |
| Push | FCM data-only → fetch via Tor → decrypt → Local Notification |
| Calls | FCM high-priority → ConnectionService + Full-Screen Intent → WebRTC |
| Files | Native streaming upload/download via OkHttp → Tor proxy |
| Platform | `Capacitor.isNativePlatform()` guards, shared Vue codebase |
