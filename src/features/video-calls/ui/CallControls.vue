<script setup lang="ts">
import { useCallStore, CallStatus } from "@/entities/call";
import { useCallService } from "../model/call-service";
import { useMediaDevices } from "../model/use-media-devices";

const STORAGE_KEY_AUDIO = "bastyon_call_audio_device";
const STORAGE_KEY_VIDEO = "bastyon_call_video_device";
const STORAGE_KEY_OUTPUT = "bastyon_call_output_device";

const callStore = useCallStore();
const callService = useCallService();
const { t } = useI18n();

const props = withDefaults(defineProps<{ compact?: boolean }>(), { compact: false });

const { audioDevices, videoDevices, audioOutputDevices, enumerateDevices } = useMediaDevices();

const showDeviceMenu = ref(false);
const selectedAudioId = ref(localStorage.getItem(STORAGE_KEY_AUDIO) ?? "");
const selectedVideoId = ref(localStorage.getItem(STORAGE_KEY_VIDEO) ?? "");
const selectedOutputId = ref(localStorage.getItem(STORAGE_KEY_OUTPUT) ?? "");
const switching = ref(false);

// Always detect currently active devices from the call's stream tracks
const detectCurrentDevices = () => {
  const localStream = callStore.localStream;
  if (!localStream) return;
  const audioTrack = localStream.getAudioTracks()[0];
  const videoTrack = localStream.getVideoTracks()[0];
  if (audioTrack) {
    const s = audioTrack.getSettings();
    if (s.deviceId) selectedAudioId.value = s.deviceId;
  }
  if (videoTrack) {
    const s = videoTrack.getSettings();
    if (s.deviceId) selectedVideoId.value = s.deviceId;
  }
};

const saveDeviceChoice = (key: string, value: string) => {
  try { localStorage.setItem(key, value); } catch { /* quota */ }
};

const toggleDeviceMenu = async () => {
  if (!showDeviceMenu.value) {
    await enumerateDevices();
    detectCurrentDevices();
    showDeviceMenu.value = true;
  } else {
    showDeviceMenu.value = false;
  }
};

const selectAudio = async (deviceId: string) => {
  if (switching.value) return;
  switching.value = true;
  try {
    selectedAudioId.value = deviceId;
    saveDeviceChoice(STORAGE_KEY_AUDIO, deviceId);
    await callService.setAudioDevice(deviceId);
  } finally {
    switching.value = false;
  }
};

const selectVideo = async (deviceId: string) => {
  if (switching.value) return;
  switching.value = true;
  try {
    selectedVideoId.value = deviceId;
    saveDeviceChoice(STORAGE_KEY_VIDEO, deviceId);
    await callService.setVideoDevice(deviceId);
  } finally {
    switching.value = false;
  }
};

const selectOutput = (deviceId: string) => {
  selectedOutputId.value = deviceId;
  saveDeviceChoice(STORAGE_KEY_OUTPUT, deviceId);
  callStore.audioOutputId = deviceId;
};

// Close device menu when call ends
watch(
  () => callStore.activeCall?.status,
  (status) => {
    if (status === CallStatus.ended || status === CallStatus.failed || status === undefined) {
      showDeviceMenu.value = false;
    }
  },
);
</script>

<template>
  <div class="relative flex flex-col items-center gap-3">
    <!-- Device selector popup -->
    <Transition name="device-menu">
      <div
        v-if="showDeviceMenu"
        class="device-menu absolute bottom-full mb-4 overflow-y-auto rounded-2xl p-3 shadow-2xl"
        :class="compact ? 'w-64 max-h-[50vh]' : 'w-72 max-h-[60vh]'"
      >
        <!-- Microphone -->
        <div v-if="audioDevices.length > 0" class="mb-2">
          <div class="mb-1 px-2 text-[11px] font-semibold uppercase tracking-wider text-white/40">
            {{ t("call.microphone") }}
          </div>
          <button
            v-for="d in audioDevices"
            :key="d.deviceId"
            :disabled="switching"
            class="device-item flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left text-[13px] text-white/80 disabled:opacity-40"
            :class="{ 'device-item--active': selectedAudioId === d.deviceId }"
            @click="selectAudio(d.deviceId)"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="shrink-0 text-white/50">
              <path d="M12 1a3 3 0 00-3 3v8a3 3 0 006 0V4a3 3 0 00-3-3z" />
              <path d="M19 10v2a7 7 0 01-14 0v-2" />
            </svg>
            <span class="truncate flex-1">{{ d.label }}</span>
            <svg v-if="selectedAudioId === d.deviceId" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" class="shrink-0 text-green-400">
              <polyline points="20 6 9 17 4 12" />
            </svg>
          </button>
        </div>

        <!-- Camera -->
        <div v-if="videoDevices.length > 0" class="mb-2">
          <div class="mb-1 px-2 text-[11px] font-semibold uppercase tracking-wider text-white/40">
            {{ t("call.camera") }}
          </div>
          <button
            v-for="d in videoDevices"
            :key="d.deviceId"
            :disabled="switching"
            class="device-item flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left text-[13px] text-white/80 disabled:opacity-40"
            :class="{ 'device-item--active': selectedVideoId === d.deviceId }"
            @click="selectVideo(d.deviceId)"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="shrink-0 text-white/50">
              <polygon points="23 7 16 12 23 17 23 7" />
              <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
            </svg>
            <span class="truncate flex-1">{{ d.label }}</span>
            <svg v-if="selectedVideoId === d.deviceId" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" class="shrink-0 text-green-400">
              <polyline points="20 6 9 17 4 12" />
            </svg>
          </button>
        </div>

        <!-- Speaker -->
        <div v-if="audioOutputDevices.length > 0">
          <div class="mb-1 px-2 text-[11px] font-semibold uppercase tracking-wider text-white/40">
            {{ t("call.speaker") }}
          </div>
          <button
            v-for="d in audioOutputDevices"
            :key="d.deviceId"
            class="device-item flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left text-[13px] text-white/80"
            :class="{ 'device-item--active': selectedOutputId === d.deviceId }"
            @click="selectOutput(d.deviceId)"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="shrink-0 text-white/50">
              <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
              <path d="M19.07 4.93a10 10 0 010 14.14M15.54 8.46a5 5 0 010 7.07" />
            </svg>
            <span class="truncate flex-1">{{ d.label }}</span>
            <svg v-if="selectedOutputId === d.deviceId" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" class="shrink-0 text-green-400">
              <polyline points="20 6 9 17 4 12" />
            </svg>
          </button>
        </div>

        <!-- No devices -->
        <div
          v-if="audioDevices.length === 0 && videoDevices.length === 0 && audioOutputDevices.length === 0"
          class="py-6 text-center text-sm text-white/30"
        >
          No devices found
        </div>
      </div>
    </Transition>

    <!-- ═══ Buttons row ═══ -->
    <div
      class="controls-row flex items-center rounded-full"
      :class="compact ? 'gap-2 px-2 py-2' : 'gap-3 px-3 py-2.5'"
    >
      <!-- Mute mic -->
      <button
        class="ctrl-btn"
        :class="[
          callStore.audioMuted ? 'ctrl-btn--toggled-off' : 'ctrl-btn--default',
          compact && 'ctrl-btn--compact',
        ]"
        :title="callStore.audioMuted ? t('call.unmute') : t('call.mute')"
        @click="callService.toggleMute()"
      >
        <!-- Mic on -->
        <svg v-if="!callStore.audioMuted" :width="compact ? 18 : 20" :height="compact ? 18 : 20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 1a3 3 0 00-3 3v8a3 3 0 006 0V4a3 3 0 00-3-3z" />
          <path d="M19 10v2a7 7 0 01-14 0v-2" />
          <line x1="12" y1="19" x2="12" y2="23" />
          <line x1="8" y1="23" x2="16" y2="23" />
        </svg>
        <!-- Mic off (crossed) -->
        <svg v-else :width="compact ? 18 : 20" :height="compact ? 18 : 20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <line x1="1" y1="1" x2="23" y2="23" />
          <path d="M9 9v3a3 3 0 005.12 2.12M15 9.34V4a3 3 0 00-5.94-.6" />
          <path d="M17 16.95A7 7 0 015 12v-2m14 0v2c0 .67-.1 1.32-.27 1.93" />
          <line x1="12" y1="19" x2="12" y2="23" />
          <line x1="8" y1="23" x2="16" y2="23" />
        </svg>
      </button>

      <!-- Toggle camera -->
      <button
        class="ctrl-btn"
        :class="[
          callStore.videoMuted ? 'ctrl-btn--toggled-off' : 'ctrl-btn--default',
          compact && 'ctrl-btn--compact',
        ]"
        :title="callStore.videoMuted ? t('call.cameraOn') : t('call.cameraOff')"
        @click="callService.toggleCamera()"
      >
        <!-- Camera on -->
        <svg v-if="!callStore.videoMuted" :width="compact ? 18 : 20" :height="compact ? 18 : 20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <polygon points="23 7 16 12 23 17 23 7" />
          <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
        </svg>
        <!-- Camera off (crossed) -->
        <svg v-else :width="compact ? 18 : 20" :height="compact ? 18 : 20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M16 16v1a2 2 0 01-2 2H3a2 2 0 01-2-2V7a2 2 0 012-2h2m5.66 0H14a2 2 0 012 2v3.34l1 1L23 7v10" />
          <line x1="1" y1="1" x2="23" y2="23" />
        </svg>
      </button>

      <!-- Screen share -->
      <button
        class="ctrl-btn"
        :class="[
          callStore.screenSharing ? 'ctrl-btn--screen-active' : 'ctrl-btn--default',
          compact && 'ctrl-btn--compact',
        ]"
        :title="callStore.screenSharing ? t('call.stopScreenShare') : t('call.screenShare')"
        @click="callService.toggleScreenShare()"
      >
        <svg :width="compact ? 18 : 20" :height="compact ? 18 : 20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
          <line x1="8" y1="21" x2="16" y2="21" />
          <line x1="12" y1="17" x2="12" y2="21" />
        </svg>
      </button>

      <!-- Device settings -->
      <button
        class="ctrl-btn"
        :class="[
          showDeviceMenu ? 'ctrl-btn--toggled-off' : 'ctrl-btn--default',
          compact && 'ctrl-btn--compact',
        ]"
        :title="t('call.devices')"
        @click="toggleDeviceMenu()"
      >
        <svg :width="compact ? 16 : 18" :height="compact ? 16 : 18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z" />
        </svg>
      </button>

      <!-- Divider -->
      <div class="mx-0.5 h-7 w-px bg-white/10" />

      <!-- Hangup -->
      <button
        class="ctrl-btn ctrl-btn--hangup"
        :class="compact && 'ctrl-btn--hangup-compact'"
        :title="t('call.hangup')"
        @click="callService.hangup()"
      >
        <svg :width="compact ? 20 : 22" :height="compact ? 20 : 22" viewBox="0 0 24 24" fill="currentColor">
          <path d="M12 9c-1.6 0-3.15.25-4.6.72v3.1c0 .39-.23.74-.56.9-.98.49-1.87 1.12-2.66 1.85-.18.18-.43.29-.71.29-.28 0-.53-.11-.71-.29L.29 13.08a.956.956 0 010-1.36C3.09 9.13 7.28 7.5 12 7.5s8.91 1.63 11.71 4.22c.18.18.29.43.29.71 0 .28-.11.53-.29.71l-2.48 2.48c-.18.18-.43.29-.71.29-.28 0-.53-.11-.71-.29a11.27 11.27 0 00-2.67-1.85.996.996 0 01-.56-.9v-3.1C15.15 9.25 13.6 9 12 9z"/>
        </svg>
      </button>
    </div>
  </div>
</template>

<style scoped>
/* ── Controls row glass ── */
.controls-row {
  background: rgba(0, 0, 0, 0.45);
  backdrop-filter: blur(20px);
  -webkit-backdrop-filter: blur(20px);
  border: 1px solid rgba(255, 255, 255, 0.08);
}

/* ── Control button base ── */
.ctrl-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 44px;
  height: 44px;
  border-radius: 50%;
  transition: transform 0.12s ease,
              box-shadow 0.18s ease;
  outline: none;
  position: relative;
}
.ctrl-btn:active {
  transform: scale(0.9);
}

/* Default state (feature is ON — transparent bg) */
.ctrl-btn--default {
  background: rgba(255, 255, 255, 0.1);
  color: white;
}
.ctrl-btn--default:hover {
  background: rgba(255, 255, 255, 0.18);
}

/* Toggled off state (e.g. mic muted, camera off — white bg, dark icon) */
.ctrl-btn--toggled-off {
  background: rgba(255, 255, 255, 0.9);
  color: #1a1a1a;
}
.ctrl-btn--toggled-off:hover {
  background: rgba(255, 255, 255, 1);
}

/* Screen share active (accent tint) */
.ctrl-btn--screen-active {
  background: rgba(34, 197, 94, 0.85);
  color: white;
  box-shadow: 0 0 12px rgba(34, 197, 94, 0.4);
}
.ctrl-btn--screen-active:hover {
  background: rgba(34, 197, 94, 1);
}

/* Compact mode (mobile) */
.ctrl-btn--compact {
  width: 40px;
  height: 40px;
}

/* Hangup (red pill) */
.ctrl-btn--hangup {
  width: 56px;
  border-radius: 22px;
  background: #e53935;
  color: white;
}
.ctrl-btn--hangup-compact {
  width: 48px;
  border-radius: 20px;
}
.ctrl-btn--hangup:hover {
  background: #ef5350;
}

/* ── Device menu ── */
.device-menu {
  background: rgba(30, 30, 38, 0.95);
  backdrop-filter: blur(24px);
  -webkit-backdrop-filter: blur(24px);
  border: 1px solid rgba(255, 255, 255, 0.08);
}

.device-item {
  position: relative;
}
.device-item::before {
  content: '';
  position: absolute;
  inset: 0;
  background: rgba(255, 255, 255, 0.06);
  opacity: 0;
  transition: opacity 0.15s;
  pointer-events: none;
}
.device-item:hover::before {
  opacity: 1;
}
.device-item--active {
  background: rgba(255, 255, 255, 0.1);
  color: white;
  font-weight: 500;
}

/* ── Device menu transition ── */
.device-menu-enter-active {
  transition: opacity 0.2s ease, transform 0.25s cubic-bezier(0.34, 1.3, 0.64, 1);
}
.device-menu-leave-active {
  transition: opacity 0.15s ease, transform 0.15s ease;
}
.device-menu-enter-from {
  opacity: 0;
  transform: translateY(8px) scale(0.95);
}
.device-menu-leave-to {
  opacity: 0;
  transform: translateY(4px) scale(0.98);
}
</style>
