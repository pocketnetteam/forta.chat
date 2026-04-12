import { ref, triggerRef } from "vue";
import { isNative } from "@/shared/lib/platform";
import { getRealGetUserMedia } from "@/shared/lib/native-webrtc";

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
      const t0 = Date.now();
      const gum = (isNative && getRealGetUserMedia()) || navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      audioStream = await gum({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
      });

      // Validate we got real audio tracks (not dummy from WebRTC proxy)
      const audioTracks = audioStream.getAudioTracks();
      if (audioTracks.length === 0 || !audioTracks[0].enabled) {
        console.error("[VoiceRecorder] No usable audio tracks — count:", audioTracks.length, "enabled:", audioTracks[0]?.enabled);
        audioStream.getTracks().forEach(t => t.stop());
        cleanup();
        return;
      }
      console.log("[VoiceRecorder] Started with", audioTracks.length, "audio track(s)");

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

      // Waveform sampling (every 100ms, keep last 50 samples, mutate in-place)
      const freqData = new Uint8Array(analyser.frequencyBinCount);
      waveformTimer = setInterval(() => {
        if (analyser) {
          analyser.getByteFrequencyData(freqData);
          const rms = computeRms(freqData);
          const arr = waveformData.value;
          if (arr.length >= 50) arr.shift();
          arr.push(rms);
          triggerRef(waveformData);
        }
      }, 100);
    } catch (e) {
      console.error("Failed to start recording:", e);
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

  /** Get audio duration from blob via AudioContext */
  const getAudioDuration = async (blob: Blob): Promise<number> => {
    try {
      const ctx = new AudioContext();
      const buffer = await ctx.decodeAudioData(await blob.arrayBuffer());
      ctx.close();
      return Math.round(buffer.duration);
    } catch {
      return duration.value;
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
