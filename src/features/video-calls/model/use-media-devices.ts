import { ref, onMounted, onUnmounted } from "vue";
import { tRaw } from "@/shared/lib/i18n";

export interface DeviceInfo {
  deviceId: string;
  label: string;
  kind: "audioinput" | "videoinput" | "audiooutput";
}

/** Virtual device IDs that duplicate physical devices */
const VIRTUAL_IDS = new Set(["default", "communications"]);

/**
 * WEE-45: Android WebView and some desktop systems return audio-output
 * labels like "Динамик телефона" / "Phone speaker" (which is actually the
 * earpiece used during voice calls) and "Динамик" / "Speakerphone" (the
 * loud speaker). Users reported the labels as unclear — "Динамик телефона"
 * literally translates to "Phone speaker" but in messenger UX the
 * convention is to distinguish the quiet earpiece from the loud
 * speakerphone explicitly. We classify labels by their known system-locale
 * variants and substitute the user-facing strings from i18n; bespoke
 * device names from external hardware (e.g. "Sony WH-1000XM5") pass
 * through unchanged so users always see the actual product name on
 * Bluetooth/USB peripherals.
 */
const EARPIECE_LABELS = new Set([
  // Russian Android WebView
  "динамик телефона",
  // English variants
  "phone speaker",
  "earpiece",
  "default - phone speaker",
]);

const SPEAKERPHONE_LABELS = new Set([
  // Russian Android WebView
  "динамик",
  // English variants
  "speakerphone",
  "speaker",
  "default - speakerphone",
]);

function normaliseAudioOutputLabel(label: string): string {
  const key = label.trim().toLowerCase();
  if (EARPIECE_LABELS.has(key)) return tRaw("call.deviceLabel.earpiece");
  if (SPEAKERPHONE_LABELS.has(key)) return tRaw("call.deviceLabel.speakerphone");
  return label;
}

export function useMediaDevices() {
  const audioDevices = ref<DeviceInfo[]>([]);
  const videoDevices = ref<DeviceInfo[]>([]);
  const audioOutputDevices = ref<DeviceInfo[]>([]);

  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  const enumerateDevices = async () => {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();

      audioDevices.value = devices
        .filter(d => d.kind === "audioinput" && !VIRTUAL_IDS.has(d.deviceId))
        .map(d => ({ deviceId: d.deviceId, label: d.label || `Mic ${d.deviceId.slice(0, 4)}`, kind: d.kind as "audioinput" }));

      videoDevices.value = devices
        .filter(d => d.kind === "videoinput" && !VIRTUAL_IDS.has(d.deviceId))
        .map(d => ({ deviceId: d.deviceId, label: d.label || `Camera ${d.deviceId.slice(0, 4)}`, kind: d.kind as "videoinput" }));

      audioOutputDevices.value = devices
        .filter(d => d.kind === "audiooutput" && !VIRTUAL_IDS.has(d.deviceId))
        .map(d => ({
          deviceId: d.deviceId,
          label: normaliseAudioOutputLabel(d.label || `Speaker ${d.deviceId.slice(0, 4)}`),
          kind: d.kind as "audiooutput",
        }));
    } catch (e) {
      console.warn("[media-devices] enumerate error:", e);
    }
  };

  const onDeviceChange = () => {
    if (debounceTimer !== null) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      enumerateDevices();
    }, 300);
  };

  onMounted(() => {
    enumerateDevices();
    navigator.mediaDevices?.addEventListener("devicechange", onDeviceChange);
  });

  onUnmounted(() => {
    navigator.mediaDevices?.removeEventListener("devicechange", onDeviceChange);
    if (debounceTimer !== null) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
  });

  return {
    audioDevices,
    audioOutputDevices,
    enumerateDevices,
    videoDevices
  };
}
