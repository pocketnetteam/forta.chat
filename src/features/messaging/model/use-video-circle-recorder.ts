import { ref, type Ref } from "vue";
import { isNative } from "@/shared/lib/platform";
import { getRealGetUserMedia } from "@/shared/lib/native-webrtc";

export type VideoRecorderState = "idle" | "recording" | "locked" | "preview";

const MAX_DURATION = 60;

const MIME_CANDIDATES = [
  "video/mp4;codecs=avc1.42E01E,mp4a.40.2",
  "video/webm;codecs=vp9,opus",
  "video/webm;codecs=vp8,opus",
  "video/webm",
];

function getSupportedMimeType(): string {
  if (typeof MediaRecorder === "undefined") return "";
  for (const mime of MIME_CANDIDATES) {
    if (MediaRecorder.isTypeSupported(mime)) return mime;
  }
  // Empty string lets MediaRecorder choose its default codec
  return "";
}

export function useVideoCircleRecorder() {
  const state = ref<VideoRecorderState>("idle");
  const duration = ref(0);
  const recordedBlob = ref<Blob | null>(null);
  const videoStream: Ref<MediaStream | null> = ref(null);

  let mediaRecorder: MediaRecorder | null = null;
  let durationTimer: ReturnType<typeof setInterval> | null = null;
  let videoChunks: Blob[] = [];
  let mimeType = "";

  const cleanup = () => {
    if (durationTimer) { clearInterval(durationTimer); durationTimer = null; }
    if (videoStream.value) {
      videoStream.value.getTracks().forEach(t => t.stop());
      videoStream.value = null;
    }
    mediaRecorder = null;
  };

  const startRecording = async () => {
    try {
      const t0 = Date.now();
      const gum = (isNative && getRealGetUserMedia()) || navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      const stream = await gum({
        video: { facingMode: "user", width: { ideal: 480 }, height: { ideal: 480 } },
        audio: true,
      });

      // Validate real tracks (not dummy from WebRTC proxy)
      const vt = stream.getVideoTracks();
      const at = stream.getAudioTracks();
      if (vt.length === 0 || at.length === 0 || !vt[0].enabled || !at[0].enabled) {
        console.error("[VideoCircle] Missing or disabled tracks — video:", vt.length, "audio:", at.length,
          "vEnabled:", vt[0]?.enabled, "aEnabled:", at[0]?.enabled);
        stream.getTracks().forEach(t => t.stop());
        cleanup();
        return;
      }
      videoStream.value = stream;
      videoChunks = [];
      mimeType = getSupportedMimeType();
      console.log("[VideoCircle] Started — video:", vt.length, "audio:", at.length, "mime:", mimeType);

      mediaRecorder = mimeType
        ? new MediaRecorder(stream, { mimeType })
        : new MediaRecorder(stream);
      // Read actual mimeType from recorder (may differ from requested when empty)
      if (!mimeType && mediaRecorder.mimeType) {
        mimeType = mediaRecorder.mimeType;
      }

      mediaRecorder.addEventListener("dataavailable", (e: BlobEvent) => {
        if (e.data.size > 0) videoChunks.push(e.data);
      });

      mediaRecorder.start(1000);
      duration.value = 0;

      // If getUserMedia took >500ms, a permission dialog was likely shown,
      // which breaks the touch-hold gesture. Auto-switch to "locked" (hands-free)
      // so the user has visible send/cancel buttons.
      const gumDelayMs = Date.now() - t0;
      state.value = gumDelayMs > 500 ? "locked" : "recording";

      durationTimer = setInterval(() => {
        duration.value++;
        if (duration.value >= MAX_DURATION) {
          stopAndSend();
        }
      }, 1000);
    } catch (e) {
      console.error("Failed to start video recording:", e);
      cleanup();
    }
  };

  const stopRecorder = (): Promise<Blob | null> => {
    return new Promise((resolve) => {
      if (!mediaRecorder || mediaRecorder.state === "inactive") {
        resolve(null);
        return;
      }

      const timeout = setTimeout(() => {
        const blob = videoChunks.length > 0 ? new Blob(videoChunks, { type: mimeType }) : null;
        cleanup();
        resolve(blob);
      }, 3000);

      mediaRecorder.addEventListener("stop", () => {
        clearTimeout(timeout);
        setTimeout(() => {
          const blob = videoChunks.length > 0 ? new Blob(videoChunks, { type: mimeType }) : null;
          cleanup();
          resolve(blob);
        }, 100);
      }, { once: true });

      mediaRecorder.stop();
    });
  };

  const stopAndSend = async (): Promise<{ file: File; duration: number } | null> => {
    const currentDuration = duration.value;
    const blob = await stopRecorder();
    if (!blob || blob.size === 0 || currentDuration < 1) {
      state.value = "idle";
      return null;
    }
    state.value = "idle";
    const ext = mimeType.startsWith("video/mp4") ? "mp4" : "webm";
    const file = new File([blob], `video_circle_${Date.now()}.${ext}`, { type: mimeType });
    return { file, duration: currentDuration };
  };

  const stopAndPreview = async () => {
    const blob = await stopRecorder();
    if (!blob || blob.size === 0) {
      state.value = "idle";
      return;
    }
    recordedBlob.value = blob;
    state.value = "preview";
  };

  const sendPreview = async (): Promise<{ file: File; duration: number } | null> => {
    const blob = recordedBlob.value;
    if (!blob) return null;
    const dur = duration.value;
    recordedBlob.value = null;
    state.value = "idle";
    const ext = mimeType.startsWith("video/mp4") ? "mp4" : "webm";
    const file = new File([blob], `video_circle_${Date.now()}.${ext}`, { type: mimeType });
    return { file, duration: dur };
  };

  const startAndLock = async () => {
    await startRecording();
    if (state.value === "recording") {
      state.value = "locked";
    }
  };

  const lock = () => {
    if (state.value === "recording") state.value = "locked";
  };

  const cancel = () => {
    videoChunks = [];
    if (mediaRecorder && mediaRecorder.state !== "inactive") {
      mediaRecorder.stop();
    }
    cleanup();
    recordedBlob.value = null;
    state.value = "idle";
  };

  return {
    state, duration, recordedBlob, videoStream,
    startRecording, startAndLock, stopAndSend, stopAndPreview, sendPreview,
    lock, cancel,
  };
}
