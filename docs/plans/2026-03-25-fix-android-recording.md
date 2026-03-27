# Fix Android Voice/Video Recording Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix voice messages and video circles not recording real audio/video on Android due to Native WebRTC proxy intercepting getUserMedia.

**Architecture:** Export original `getUserMedia` from proxy module. Recorders use it on native platform instead of the globally-replaced version. Add MP4/H264 fallback for video circles and track validation before recording.

**Tech Stack:** Vue 3 Composition API, TypeScript, Capacitor, WebRTC, MediaRecorder API

---

### Task 1: Export original getUserMedia from proxy module

**Files:**
- Modify: `src/shared/lib/native-webrtc/rtc-peer-connection-proxy.ts:560-561`
- Modify: `src/shared/lib/native-webrtc/index.ts`

**Step 1: Add export function in rtc-peer-connection-proxy.ts**

After line 561 (`const originalGetUserMedia = ...`), add:

```typescript
/**
 * Returns the real browser getUserMedia, bypassing the native WebRTC proxy.
 * Use this in voice/video recorders that need actual media streams,
 * not the dummy streams returned by the proxy (which are for WebRTC calls only).
 */
export function getRealGetUserMedia(): typeof navigator.mediaDevices.getUserMedia | undefined {
  return originalGetUserMedia;
}
```

**Step 2: Re-export from index.ts**

Add `getRealGetUserMedia` to the exports in `src/shared/lib/native-webrtc/index.ts`.

**Step 3: Commit**

```
feat: export original getUserMedia from native WebRTC proxy module
```

---

### Task 2: Fix voice recorder to use real getUserMedia on native

**Files:**
- Modify: `src/features/messaging/model/use-voice-recorder.ts:1-2,32-34`

**Step 1: Add imports**

```typescript
import { isNative } from "@/shared/lib/platform";
import { getRealGetUserMedia } from "@/shared/lib/native-webrtc";
```

**Step 2: Replace getUserMedia call in startRecording()**

Replace line 34:
```typescript
audioStream = await navigator.mediaDevices.getUserMedia({ audio: true });
```

With:
```typescript
const gum = (isNative && getRealGetUserMedia()) || navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
audioStream = await gum({ audio: true });

// Validate we got real audio tracks (not dummy from WebRTC proxy)
const audioTracks = audioStream.getAudioTracks();
if (audioTracks.length === 0) {
  console.error("[VoiceRecorder] No audio tracks in stream");
  cleanup();
  return;
}
console.log("[VoiceRecorder] Started with", audioTracks.length, "audio track(s), enabled:", audioTracks[0].enabled);
```

**Step 3: Commit**

```
fix: voice recorder uses real getUserMedia on Android, bypassing WebRTC proxy
```

---

### Task 3: Fix video circle recorder — real getUserMedia + MP4/H264 fallback

**Files:**
- Modify: `src/features/messaging/model/use-video-circle-recorder.ts`

**Step 1: Add imports**

```typescript
import { isNative } from "@/shared/lib/platform";
import { getRealGetUserMedia } from "@/shared/lib/native-webrtc";
```

**Step 2: Replace getSupportedMimeType() with broader codec list**

```typescript
const MIME_CANDIDATES = [
  "video/mp4;codecs=avc1.42E01E,mp4a.40.2",  // H264+AAC — best Android compat
  "video/webm;codecs=vp9,opus",
  "video/webm;codecs=vp8,opus",
  "video/webm",
];

function getSupportedMimeType(): string {
  if (typeof MediaRecorder === "undefined") return "video/webm";
  for (const mime of MIME_CANDIDATES) {
    if (MediaRecorder.isTypeSupported(mime)) return mime;
  }
  return "video/webm";
}
```

**Step 3: Replace getUserMedia call in startRecording()**

Replace line 38-41:
```typescript
const stream = await navigator.mediaDevices.getUserMedia({...});
```

With:
```typescript
const gum = (isNative && getRealGetUserMedia()) || navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
const stream = await gum({
  video: { facingMode: "user", width: { ideal: 480 }, height: { ideal: 480 } },
  audio: true,
});

// Validate real tracks
const vt = stream.getVideoTracks();
const at = stream.getAudioTracks();
if (vt.length === 0 || at.length === 0) {
  console.error("[VideoCircle] Missing tracks — video:", vt.length, "audio:", at.length);
  stream.getTracks().forEach(t => t.stop());
  cleanup();
  return;
}
console.log("[VideoCircle] Started — video:", vt.length, "audio:", at.length, "mime:", mimeType);
```

**Step 4: Fix file extension based on mime**

Replace line 103:
```typescript
const file = new File([blob], `video_circle_${Date.now()}.webm`, { type: mimeType });
```

With:
```typescript
const ext = mimeType.startsWith("video/mp4") ? "mp4" : "webm";
const file = new File([blob], `video_circle_${Date.now()}.${ext}`, { type: mimeType });
```

Same for line 123 (sendPreview).

**Step 5: Commit**

```
fix: video circle recorder uses real getUserMedia + MP4/H264 fallback on Android
```

---

### Task 4: Verify build + types

**Step 1:** `npm run build`
**Step 2:** `npx vue-tsc --noEmit`
**Step 3:** `npm run lint`
**Step 4:** Fix any issues

---
