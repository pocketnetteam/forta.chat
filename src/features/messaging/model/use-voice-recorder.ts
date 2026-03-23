import { ref } from "vue";
import AudioRecorder from "audio-recorder-polyfill";
// @ts-expect-error — no types for mpeg-encoder
import mpegEncoder from "audio-recorder-polyfill/mpeg-encoder";

// Configure MP3 encoder (matching bastyon-chat)
AudioRecorder.encoder = mpegEncoder;
AudioRecorder.prototype.mimeType = "audio/mpeg";

export type RecorderState = "idle" | "recording" | "locked" | "preview";

export function useVoiceRecorder() {
  const state = ref<RecorderState>("idle");
  const duration = ref(0);
  const waveformData = ref<number[]>([]);
  const recordedBlob = ref<Blob | null>(null);

  let mediaRecorder: InstanceType<typeof AudioRecorder> | null = null;
  let audioStream: MediaStream | null = null;
  let audioContext: AudioContext | null = null;
  let analyser: AnalyserNode | null = null;
  let durationTimer: ReturnType<typeof setInterval> | null = null;
  let waveformTimer: ReturnType<typeof setInterval> | null = null;
  let audioChunks: Blob[] = [];

  /** Compute RMS from frequency data (same as bastyon-chat generateRms) */
  const computeRms = (frequencies: Uint8Array): number => {
    const sum = frequencies.reduce((a, b) => a + b * b, 0);
    return +(Math.sqrt(sum / frequencies.length) / 255).toPrecision(3);
  };

  const startRecording = async () => {
    try {
      audioStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      audioChunks = [];

      // Set up analyser for waveform
      audioContext = new AudioContext();
      const source = audioContext.createMediaStreamSource(audioStream);
      analyser = audioContext.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);

      // Create recorder (MP3 32kbps)
      mediaRecorder = new AudioRecorder(audioStream, { audioBitsPerSecond: 32000 });

      mediaRecorder.addEventListener("dataavailable", (e: BlobEvent) => {
        if (e.data.size > 0) audioChunks.push(e.data);
      });

      mediaRecorder.start(1000);   // flush data every 1s so encoder Worker keeps up
      state.value = "recording";
      duration.value = 0;
      waveformData.value = [];

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
          ? new Blob(audioChunks, { type: "audio/mpeg" })
          : null;
        cleanup();
        resolve(blob);
      }, 3000);

      mediaRecorder.addEventListener("stop", () => {
        clearTimeout(timeout);
        // Small delay to ensure any final dataavailable has been processed
        setTimeout(() => {
          const blob = audioChunks.length > 0
            ? new Blob(audioChunks, { type: "audio/mpeg" })
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
    const file = new File([blob], `voice_${Date.now()}.mp3`, { type: "audio/mpeg" });
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
    const file = new File([blob], `voice_${Date.now()}.mp3`, { type: "audio/mpeg" });
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
