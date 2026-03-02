# Design: Telegram-style Media, Captions & Voice Messages

## Context

Implement full Telegram-style media upload with captions and voice message recording/playback in new-bastyon-chat. Must be compatible with bastyon-chat message format (m.image, m.video, m.audio event types, MP3 voice format).

## Architecture: Approach B — Composables + Components

Dedicated components and composables for each concern, integrated into existing MessageInput/MessageBubble.

---

## 1. Extended Message Types & Send Pipeline

### FileInfo additions (types.ts)

```ts
interface FileInfo {
  // existing: name, type, size, url, secrets?, w?, h?
  duration?: number;       // seconds, for audio and video
  waveform?: number[];     // RMS data for voice, ~50 values
  thumbnail?: string;      // URL for video poster
  caption?: string;        // media caption text
  captionAbove?: boolean;  // caption above media (Telegram feature)
}
```

### Send functions (use-messages.ts)

- `sendImage(file, { caption?, captionAbove?, w?, h? })` -> m.image event
- `sendVideo(file, { caption?, thumbnail?, duration? })` -> m.video event (fallback m.file)
- `sendAudio(file, { duration?, waveform? })` -> m.audio event
- `sendFile(file, { caption? })` -> m.file event (documents)

Each: optimistic message -> encrypt if needed -> upload -> send Matrix event -> update temp ID.

### Voice format

MP3 via `audio-recorder-polyfill` + `mpeg-encoder` (matching bastyon-chat: audioBitsPerSecond 32000). Body: "Audio". Duration computed via AudioContext.decodeAudioData.

### Upload progress

Add `progressHandler` callback to `matrix-client.ts` `uploadContent()`. Wire to MessageBubble for sending state indicator.

---

## 2. MediaPreview — Preview Screen Before Sending

### Component: MediaPreview.vue (new)

Fullscreen panel (Teleport to body), shown after selecting photos/videos from AttachmentPanel.

**Layout:**
- Top bar: Back (X), "Send as file" toggle
- Center: selected media large (img fit/contain, video with controls)
- Multiple files: horizontal thumbnail strip at bottom, tap to switch active
- Below media: caption text input (max 1024 chars)
- Send button; long-press Send -> "Caption above / Caption below" menu

### Composable: use-media-upload.ts (new)

```ts
export function useMediaUpload() {
  const files: Ref<MediaFile[]>;
  const activeIndex: Ref<number>;
  const caption: Ref<string>;
  const captionAbove: Ref<boolean>;
  const sending: Ref<boolean>;

  const addFiles: (fileList: FileList) => void;
  const removeFile: (index: number) => void;
  const sendAll: () => Promise<void>; // sends each file, caption on last
}
```

### Flow
1. User taps Attach -> picks photo/video
2. Files passed to MediaPreview -> sees preview
3. Types caption -> taps Send
4. Each file sent via sendImage/sendVideo with caption on last file

---

## 3. Voice Recording

### Composable: use-voice-recorder.ts (new)

```ts
export function useVoiceRecorder() {
  const state: Ref<"idle" | "recording" | "locked" | "preview">;
  const duration: Ref<number>;
  const waveformData: Ref<number[]>;  // RMS every 50ms, last ~50 samples
  const recordedBlob: Ref<Blob | null>;

  const startRecording: () => Promise<void>;
  const stopAndSend: () => void;      // immediate send
  const stopAndPreview: () => void;   // for locked mode -> preview
  const cancel: () => void;
  const lock: () => void;             // hands-free mode
}
```

Uses audio-recorder-polyfill + mpeg-encoder. AudioContext + AnalyserNode for RMS waveform (same as bastyon-chat generateRms).

### Component: VoiceRecorder.vue (new)

**States:**

1. **idle** — mic button in MessageInput (existing)
2. **recording (hold)** — finger held: red dot + timer + live waveform + lock icon (swipe up) + "Slide to cancel" (swipe left). Release -> send immediately.
3. **locked (hands-free)** — after swipe up: red dot + timer + live waveform + Stop button + Cancel button. Finger free.
4. **preview** — after Stop in locked: Play button + static waveform + duration + Send/Delete buttons.

**Gestures:**
- touchstart on mic -> startRecording
- touchmove up (>80px) -> lock()
- touchmove left (>130px) -> cancel()
- touchend (if not locked) -> stopAndSend()

---

## 4. Voice Playback — VoiceMessage Player

### Component: VoiceMessage.vue (new, used in MessageBubble)

**Layout (Telegram-style):**
- Play/Pause button (circle, accent color)
- Waveform bar (canvas/SVG, ~50 bars). Played portion = accent, remaining = gray. Running marker.
- Duration right side (shows current position during playback)
- Speed button: 1x -> 1.5x -> 2x (cyclic, like Telegram)
- "Unlistened" indicator: blue dot until first Play

**Waveform source:**
- If `fileInfo.waveform` exists (sent by us) -> use directly
- If missing (from bastyon-chat) -> generate from decoded audio buffer's getChannelData(0)

**Playback:**
- HTML5 Audio API (not native controls)
- playbackRate for speed switching
- timeupdate for progress animation
- Tap on waveform -> seek to position
- Auto-chain: when voice ends, auto-play next unlistened voice message in chat

---

## 5. MessageBubble Updates

| Type | Before | After |
|------|--------|-------|
| image | `<img>` no caption | `<img>` + caption block below/above |
| video | `<video controls>` | `<video>` with poster + caption |
| audio | `<audio controls>` (native) | `<VoiceMessage>` component |
| file | File card | File card + caption if present |

Caption rendering: captionAbove flag determines position relative to media.

---

## 6. Implementation Batches

### Batch 1 — Foundation (types + send pipeline)
1. Extend FileInfo in types.ts
2. Update chat-helpers.ts (parse m.image/m.video/m.audio)
3. Add progressHandler to matrix-client.ts uploadContent
4. Refactor use-messages.ts: sendImage, sendVideo, sendAudio, sendFile
5. Update MessageBubble caption rendering

### Batch 2 — MediaPreview + Captions
6. use-media-upload.ts composable
7. MediaPreview.vue component
8. Integration in MessageInput (files -> MediaPreview -> send)
9. AttachmentPanel: add Camera option

### Batch 3 — Voice Recording
10. npm install audio-recorder-polyfill
11. use-voice-recorder.ts composable
12. VoiceRecorder.vue component
13. Integration in MessageInput (replace current recording)

### Batch 4 — Voice Playback
14. VoiceMessage.vue player (waveform, seek, speed)
15. Integration in MessageBubble (replace `<audio controls>`)
16. Auto-chain playback

### Batch 5 — Polish
17. Upload progress bar in MessageBubble for sending messages
18. MediaViewer: caption display, download button
19. "Send as file" vs "Send as media" toggle in MediaPreview

---

## Files Summary

### New files
| File | Purpose |
|------|---------|
| features/messaging/model/use-voice-recorder.ts | Composable: MediaRecorder MP3, RMS, lock/cancel |
| features/messaging/model/use-media-upload.ts | Composable: files, preview, caption, compress, send |
| features/messaging/ui/VoiceRecorder.vue | Recording UI: hold, lock, cancel, preview, live waveform |
| features/messaging/ui/VoiceMessage.vue | Player: waveform, seek, speed, auto-chain |
| features/messaging/ui/MediaPreview.vue | Preview screen: media, thumbnails, caption, send |

### Modified files
| File | Changes |
|------|---------|
| entities/chat/model/types.ts | FileInfo += duration, waveform, caption, captionAbove, thumbnail |
| entities/chat/lib/chat-helpers.ts | Parse m.image/m.video/m.audio from Matrix events |
| entities/matrix/model/matrix-client.ts | uploadContent with progressHandler; type-specific send methods |
| features/messaging/model/use-messages.ts | New sendImage/sendVideo/sendAudio; refactored sendFile |
| features/messaging/ui/MessageInput.vue | VoiceRecorder replaces built-in recording; MediaPreview flow |
| features/messaging/ui/MessageBubble.vue | VoiceMessage for audio; caption rendering; video poster |
| features/messaging/ui/AttachmentPanel.vue | Add Camera option |

### npm dependencies
- `audio-recorder-polyfill` (includes mpeg-encoder)
