import { ref, onMounted, onUnmounted } from "vue";

export interface DeviceInfo {
  deviceId: string;
  label: string;
  kind: "audioinput" | "videoinput" | "audiooutput";
}

/** Virtual device IDs that duplicate physical devices */
const VIRTUAL_IDS = new Set(["default", "communications"]);

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
        .map(d => ({ deviceId: d.deviceId, label: d.label || `Speaker ${d.deviceId.slice(0, 4)}`, kind: d.kind as "audiooutput" }));
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
