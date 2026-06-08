import { ref } from "vue";
import { isNative } from "@/shared/lib/platform";
import { getRealGetUserMedia } from "@/shared/lib/native-webrtc";
import { useBugReport } from "@/features/bug-report";
import { tRaw } from "@/shared/lib/i18n";
import { classifyMicError, sendDiag, SendError } from "./send-errors";
import { reportSendError } from "./send-error-bus";

export type RecorderState = "idle" | "recording" | "locked" | "preview";

/** Map MIME type to file extension */
const mimeToExt = (mime: string): string => {
  if (mime.includes("webm")) return "webm";
  if (mime.includes("mp4")) return "m4a";
  if (mime.includes("ogg")) return "ogg";
  return "webm";
};

export function useVoiceRecorder() {
  const state = ref<RecorderState>("idle");
  const duration = ref(0);
  const waveformData = ref<number[]>([]);
  const recordedBlob = ref<Blob | null>(null);

  let mediaRecorder: MediaRecorder | null = null;
  let audioStream: MediaStream | null = null;
  let audioContext: AudioContext | null = null;
  let analyser: AnalyserNode | null = null;
  let durationTimer: ReturnType<typeof setInterval> | null = null;
  let waveformTimer: ReturnType<typeof setInterval> | null = null;
  let audioChunks: Blob[] = [];
  let recordedMimeType = "";

  /** Compute RMS from frequency data (same as bastyon-chat generateRms) */
  const computeRms = (frequencies: Uint8Array): number => {
    const sum = frequencies.reduce((a, b) => a + b * b, 0);
    return +(Math.sqrt(sum / frequencies.length) / 255).toPrecision(3);
  };

  const startRecording = async () => {
    try {
      sendDiag("voice:start");
      const t0 = Date.now();
      const gum = (isNative && getRealGetUserMedia()) || navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      audioStream = await gum({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });

      // Validate we got real audio tracks (not dummy from WebRTC proxy).
      // An empty track list is observable both when RECORD_AUDIO is silently
      // revoked on Android and when the WebRTC bridge returns a dummy stream
      // mid-call. Either way the user gets nothing — surface it as micDenied
      // so the banner appears instead of a silent state reset.
      const audioTracks = audioStream.getAudioTracks();
      if (audioTracks.length === 0 || !audioTracks[0].enabled) {
        console.error("[VoiceRecorder] No usable audio tracks — count:", audioTracks.length, "enabled:", audioTracks[0]?.enabled);
        audioStream.getTracks().forEach(t => t.stop());
        cleanup();
        reportSendError(new SendError("micDenied", "No usable audio tracks available", { kind: "audio" }));
        return;
      }
      sendDiag("voice:tracks-ok", { count: audioTracks.length });

      audioChunks = [];

      // Set up analyser for waveform
      audioContext = new AudioContext();
      const source = audioContext.createMediaStreamSource(audioStream);
      analyser = audioContext.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);

      // Pick best supported MIME type for native MediaRecorder
      const mimeType =
        typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
          ? "audio/webm;codecs=opus"
          : "audio/mp4";
      recordedMimeType = mimeType;

      mediaRecorder = new MediaRecorder(audioStream, { mimeType });

      mediaRecorder.addEventListener("dataavailable", (e: BlobEvent) => {
        if (e.data.size > 0) audioChunks.push(e.data);
      });

      // Start without timeslice — one continuous stream, no chunk boundary artifacts
      mediaRecorder.start();
      duration.value = 0;
      waveformData.value = [];

      // If getUserMedia took >500ms, a permission dialog was likely shown,
      // which breaks the touch-hold gesture. Auto-switch to "locked" (hands-free).
      const gumDelayMs = Date.now() - t0;
      state.value = gumDelayMs > 500 ? "locked" : "recording";

      // Duration timer
      durationTimer = setInterval(() => {
        duration.value++;
      }, 1000);

      // Waveform sampling (every 50ms, keep last 50 samples)
      const freqData = new Uint8Array(analyser.frequencyBinCount);
      waveformTimer = setInterval(() => {
        if (analyser) {
          analyser.getByteFrequencyData(freqData);
          const rms = computeRms(freqData);
          waveformData.value = [...waveformData.value.slice(-49), rms];
        }
      }, 50);
    } catch (e) {
      console.error("Failed to start recording:", e);
      const classified = classifyMicError(e);
      sendDiag("voice:start-failed", { kind: classified.kind });
      // micDenied is the user-actionable case (Settings → Permissions →
      // Microphone). Show a typed banner instead of the bug-report modal so
      // the user knows what to do. Everything else still routes to the bug
      // report so we get the stack on the unhappy paths we don't yet know
      // about.
      if (classified.kind === "micDenied") {
        reportSendError(classified);
      } else {
        reportSendError(classified);
        useBugReport().open({ context: tRaw("bugReport.ctx.voiceRecord"), error: e });
      }
      cleanup();
    }
  };

  const cleanup = () => {
    if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop();
    if (durationTimer) { clearInterval(durationTimer); durationTimer = null; }
    if (waveformTimer) { clearInterval(waveformTimer); waveformTimer = null; }
    if (audioStream) { audioStream.getTracks().forEach(t => t.stop()); audioStream = null; }
    if (audioContext) { audioContext.close(); audioContext = null; }
    analyser = null;
    mediaRecorder = null;
  };

  /** Stop recording and get blob (used internally) */
  const stopRecorder = (): Promise<Blob | null> => {
    return new Promise((resolve) => {
      if (!mediaRecorder || mediaRecorder.state === "inactive") {
        resolve(null);
        return;
      }

      // Safety timeout — if stop event never fires, resolve after 3s
      const timeout = setTimeout(() => {
        const blob = audioChunks.length > 0
          ? new Blob(audioChunks, { type: recordedMimeType })
          : null;
        cleanup();
        resolve(blob);
      }, 3000);

      mediaRecorder.addEventListener("stop", () => {
        clearTimeout(timeout);
        // Small delay to ensure any final dataavailable has been processed
        setTimeout(() => {
          const blob = audioChunks.length > 0
            ? new Blob(audioChunks, { type: recordedMimeType })
            : null;
          cleanup();
          resolve(blob);
        }, 100);
      }, { once: true });
      mediaRecorder.stop();
    });
  };

  /** Get audio duration (seconds) from blob via AudioContext.
   *  The wall-clock counter incremented during recording is the reliable
   *  fallback: AudioContext.decodeAudioData on some Android WebViews returns a
   *  NaN/Infinity duration for MediaRecorder webm/opus (the WebM header carries
   *  no Duration element). A non-finite duration then JSON-serializes to `null`
   *  on the wire and leaves the recipient's voice bubble showing 0:00 even
   *  though the audio plays for its full length (WEE-83). Always resolve to a
   *  finite, non-negative integer. */
  const getAudioDuration = async (blob: Blob): Promise<number> => {
    const counter = Number.isFinite(duration.value) && duration.value > 0 ? duration.value : 0;
    try {
      const ctx = new AudioContext();
      const buffer = await ctx.decodeAudioData(await blob.arrayBuffer());
      ctx.close();
      const decoded = Math.round(buffer.duration);
      return Number.isFinite(decoded) && decoded > 0 ? decoded : counter;
    } catch {
      return counter;
    }
  };

  /** Stop and immediately return blob + metadata for sending */
  const stopAndSend = async (): Promise<{ file: File; duration: number; waveform: number[] } | null> => {
    const blob = await stopRecorder();
    if (!blob || blob.size === 0) {
      state.value = "idle";
      return null;
    }
    const dur = await getAudioDuration(blob);
    if (dur < 1) {
      state.value = "idle";
      return null;
    }
    const waveform = [...waveformData.value];
    state.value = "idle";
    const ext = mimeToExt(blob.type);
    const file = new File([blob], `voice_${Date.now()}.${ext}`, { type: blob.type });
    return { file, duration: dur, waveform };
  };

  /** Stop recording and enter preview mode */
  const stopAndPreview = async () => {
    const blob = await stopRecorder();
    if (!blob || blob.size === 0) {
      state.value = "idle";
      return;
    }
    recordedBlob.value = blob;
    state.value = "preview";
  };

  /** Send from preview mode */
  const sendPreview = async (): Promise<{ file: File; duration: number; waveform: number[] } | null> => {
    const blob = recordedBlob.value;
    if (!blob) return null;
    const dur = await getAudioDuration(blob);
    const waveform = [...waveformData.value];
    recordedBlob.value = null;
    state.value = "idle";
    const ext = mimeToExt(blob.type);
    const file = new File([blob], `voice_${Date.now()}.${ext}`, { type: blob.type });
    return { file, duration: dur, waveform };
  };

  /** Start recording and immediately go to locked (hands-free) mode — for desktop click */
  const startAndLock = async () => {
    await startRecording();
    if (state.value === "recording") {
      state.value = "locked";
    }
  };

  const lock = () => {
    if (state.value === "recording") {
      state.value = "locked";
    }
  };

  const cancel = () => {
    audioChunks = [];
    if (mediaRecorder && mediaRecorder.state !== "inactive") {
      mediaRecorder.stop();
    }
    cleanup();
    recordedBlob.value = null;
    state.value = "idle";
  };

  return {
    state, duration, waveformData, recordedBlob,
    startRecording, startAndLock, stopAndSend, stopAndPreview, sendPreview,
    lock, cancel,
  };
}
