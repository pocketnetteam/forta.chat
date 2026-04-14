<script setup lang="ts">
import { useCallStore, CallStatus } from "@/entities/call";
import { UserAvatar } from "@/entities/user";
import { formatDuration } from "@/shared/lib/format";
import { useCallService } from "../model/call-service";
import CallControls from "./CallControls.vue";
import VideoTile from "./VideoTile.vue";
import { useAndroidBackHandler } from "@/shared/lib/composables/use-android-back-handler";

const callStore = useCallStore();
const callService = useCallService();
const { t } = useI18n();

// ── Responsive breakpoint ──

const isMobile = ref(window.innerWidth < 640);
function onResize() { isMobile.value = window.innerWidth < 640; }
onMounted(() => window.addEventListener('resize', onResize));
onUnmounted(() => window.removeEventListener('resize', onResize));

// Hidden audio element ref — always in DOM so remote audio plays
const remoteAudioRef = ref<HTMLVideoElement | null>(null);

const show = computed(() => {
  if (callStore.minimized) return false;
  const s = callStore.activeCall?.status;
  return (
    s === CallStatus.ringing ||
    s === CallStatus.connecting ||
    s === CallStatus.connected
  );
});

const minimize = () => {
  callStore.minimized = true;
};

// Android back: minimize call window instead of closing
useAndroidBackHandler("call-window", 100, () => {
  if (!show.value) return false;
  minimize();
  return true;
});

const isVideoCall = computed(
  () => callStore.activeCall?.type === "video",
);
const localCameraOn = computed(
  () => isVideoCall.value && !callStore.videoMuted,
);
const isConnected = computed(
  () => callStore.activeCall?.status === CallStatus.connected,
);

const statusText = computed(() => {
  switch (callStore.activeCall?.status) {
    case CallStatus.ringing:
      return t("call.calling");
    case CallStatus.connecting:
      return t("call.connecting");
    case CallStatus.connected:
      return formatDuration(callStore.callTimer);
    default:
      return "";
  }
});

// ── Layout mode ──

const layoutMode = computed(() => {
  if (callStore.screenSharing || callStore.remoteScreenSharing) return "spotlight";
  if (isVideoCall.value) return "simple-video";
  return "voice";
});

// ── Audio binding ──

function bindStream(el: HTMLVideoElement | null, stream: MediaStream | null) {
  if (!el || el.srcObject === stream) return;
  el.srcObject = stream;
}

function applyAudioOutput(el: HTMLVideoElement | null, deviceId: string) {
  if (!el || !deviceId) return;
  if (typeof (el as any).setSinkId === "function") {
    (el as any).setSinkId(deviceId).catch((e: unknown) => {
      console.warn("[CallWindow] setSinkId error:", e);
    });
  }
}

// Bind remote usermedia stream (has audio) to hidden audio element
watch(
  () => callStore.remoteStream,
  (stream) => bindStream(remoteAudioRef.value, stream),
  { flush: "post" },
);

watch(
  () => callStore.audioOutputId,
  (id) => applyAudioOutput(remoteAudioRef.value, id),
  { flush: "post" },
);

// ── beforeunload / unload during active call ──

function onBeforeUnload(e: BeforeUnloadEvent) {
  if (callStore.isInCall) {
    e.preventDefault();
    return '';
  }
}

function onUnload() {
  if (callStore.isInCall) {
    callService.hangup();
  }
}

onMounted(() => {
  bindStream(remoteAudioRef.value, callStore.remoteStream);
  if (callStore.audioOutputId) {
    applyAudioOutput(remoteAudioRef.value, callStore.audioOutputId);
  }
  window.addEventListener('beforeunload', onBeforeUnload);
  window.addEventListener('unload', onUnload);
});

onUnmounted(() => {
  window.removeEventListener('beforeunload', onBeforeUnload);
  window.removeEventListener('unload', onUnload);
});

// ── Pin logic ──

const autoPinnedTile = computed(() => {
  if (callStore.remoteScreenSharing) return "remote-screen";
  if (callStore.screenSharing) return "local-screen";
  return "remote-camera";
});

const effectivePinned = computed(
  () => callStore.pinnedTile ?? autoPinnedTile.value,
);

// Reset manual pin when screen share state changes
watch(
  () => [callStore.screenSharing, callStore.remoteScreenSharing],
  () => {
    callStore.setPinnedTile(null);
  },
);

function onPinTile(tileId: string) {
  callStore.setPinnedTile(callStore.pinnedTile === tileId ? null : tileId);
}

// ── Tile data helpers ──

interface TileData {
  id: string;
  stream: MediaStream | null;
  label: string;
  address: string;
  videoOff: boolean;
  audioOff: boolean;
  muted: boolean;
  objectFit: "cover" | "contain";
  mirror: boolean;
}

const peerName = computed(() => callStore.activeCall?.peerName ?? "");
const peerAddress = computed(() => callStore.activeCall?.peerAddress ?? "");
const myAddress = computed(() => "");

function makeTile(
  id: string,
  stream: MediaStream | null,
  label: string,
  address: string,
  videoOff: boolean,
  audioOff: boolean,
  isScreen: boolean,
  mirror: boolean,
): TileData {
  return {
    id,
    stream,
    label,
    address,
    videoOff,
    audioOff,
    muted: true,
    objectFit: isScreen ? "contain" : "cover",
    mirror,
  };
}

const allTiles = computed<TileData[]>(() => {
  const tiles: TileData[] = [];

  tiles.push(
    makeTile(
      "local-camera",
      callStore.localStream,
      t("call.you"),
      myAddress.value,
      callStore.videoMuted,
      callStore.audioMuted,
      false,
      true,
    ),
  );

  tiles.push(
    makeTile(
      "remote-camera",
      callStore.remoteStream,
      peerName.value,
      peerAddress.value,
      callStore.remoteVideoMuted,
      false,
      false,
      false,
    ),
  );

  if (callStore.screenSharing && callStore.localScreenStream) {
    tiles.push(
      makeTile(
        "local-screen",
        callStore.localScreenStream,
        `${t("call.you")} (${t("call.screen")})`,
        myAddress.value,
        false,
        false,
        true,
        false,
      ),
    );
  }

  if (callStore.remoteScreenSharing && callStore.remoteScreenStream) {
    tiles.push(
      makeTile(
        "remote-screen",
        callStore.remoteScreenStream,
        `${peerName.value} (${t("call.screen")})`,
        peerAddress.value,
        false,
        false,
        true,
        false,
      ),
    );
  }

  return tiles;
});

const spotlightTile = computed(() =>
  allTiles.value.find((t) => t.id === effectivePinned.value) ?? allTiles.value[0],
);

const filmstripTiles = computed(() =>
  allTiles.value.filter((t) => t.id !== effectivePinned.value),
);

const remoteVideoOff = computed(
  () => isVideoCall.value && callStore.remoteStream && callStore.remoteVideoMuted,
);

// ── Draggable PiP (snap to 4 corners) ──

type PipCorner = "top-left" | "top-right" | "bottom-left" | "bottom-right";
const pipCorner = ref<PipCorner>("bottom-right");
const isDragging = ref(false);
const dragOffset = ref({ x: 0, y: 0 });
const pipPos = ref({ x: 0, y: 0 }); // only used while dragging
const pipRef = ref<HTMLElement | null>(null);
const callContainerRef = ref<HTMLElement | null>(null);

const PIP_W = computed(() => isMobile.value ? 110 : 160);
const PIP_H = computed(() => isMobile.value ? 82 : 120);
const PIP_MARGIN = computed(() => isMobile.value ? 12 : 16);
const PIP_BOTTOM_OFFSET = computed(() => isMobile.value ? 80 : 96);

const pipCornerStyle = computed(() => {
  const base = {
    width: `${PIP_W.value}px`,
    height: `${PIP_H.value}px`,
  };
  if (isDragging.value) {
    return {
      ...base,
      top: `${pipPos.value.y}px`,
      left: `${pipPos.value.x}px`,
      transition: "none",
    };
  }
  const m = PIP_MARGIN.value;
  const bottom = PIP_BOTTOM_OFFSET.value;
  switch (pipCorner.value) {
    case "top-left":
      return { ...base, top: `${64 + m}px`, left: `${m}px` };
    case "top-right":
      return { ...base, top: `${64 + m}px`, right: `${m}px` };
    case "bottom-left":
      return { ...base, bottom: `${bottom + m}px`, left: `${m}px` };
    case "bottom-right":
    default:
      return { ...base, bottom: `${bottom + m}px`, right: `${m}px` };
  }
});

function onPipPointerDown(e: PointerEvent) {
  if (!pipRef.value || !callContainerRef.value) return;
  const rect = pipRef.value.getBoundingClientRect();
  const containerRect = callContainerRef.value.getBoundingClientRect();
  dragOffset.value = {
    x: e.clientX - rect.left,
    y: e.clientY - rect.top,
  };
  pipPos.value = {
    x: rect.left - containerRect.left,
    y: rect.top - containerRect.top,
  };
  isDragging.value = true;
  pipRef.value.setPointerCapture(e.pointerId);
}

function onPipPointerMove(e: PointerEvent) {
  if (!isDragging.value || !callContainerRef.value) return;
  const containerRect = callContainerRef.value.getBoundingClientRect();
  const x = e.clientX - containerRect.left - dragOffset.value.x;
  const y = e.clientY - containerRect.top - dragOffset.value.y;
  pipPos.value = {
    x: Math.max(0, Math.min(x, containerRect.width - PIP_W.value)),
    y: Math.max(0, Math.min(y, containerRect.height - PIP_H.value)),
  };
}

function onPipPointerUp() {
  if (!isDragging.value || !callContainerRef.value) return;
  isDragging.value = false;
  // Snap to nearest corner
  const containerRect = callContainerRef.value.getBoundingClientRect();
  const cx = pipPos.value.x + PIP_W.value / 2;
  const cy = pipPos.value.y + PIP_H.value / 2;
  const midX = containerRect.width / 2;
  const midY = containerRect.height / 2;

  if (cx < midX && cy < midY) pipCorner.value = "top-left";
  else if (cx >= midX && cy < midY) pipCorner.value = "top-right";
  else if (cx < midX && cy >= midY) pipCorner.value = "bottom-left";
  else pipCorner.value = "bottom-right";
}

// ── Show/hide controls on hover ──

const controlsVisible = ref(true);
let hideControlsTimer: ReturnType<typeof setTimeout> | null = null;

function showControls() {
  controlsVisible.value = true;
  resetHideTimer();
}

function resetHideTimer() {
  if (hideControlsTimer) clearTimeout(hideControlsTimer);
  // Only auto-hide during connected video call
  if (isConnected.value && isVideoCall.value) {
    hideControlsTimer = setTimeout(() => {
      controlsVisible.value = false;
    }, 4000);
  }
}

watch([isConnected, isVideoCall], () => {
  if (isConnected.value && isVideoCall.value) {
    resetHideTimer();
  } else {
    controlsVisible.value = true;
    if (hideControlsTimer) clearTimeout(hideControlsTimer);
  }
});

// Whether PiP is visible in simple-video mode
const showPip = computed(
  () => (localCameraOn.value && callStore.localStream) || callStore.screenSharing,
);

// Screen sharing badge
const isAnyScreenSharing = computed(
  () => callStore.screenSharing || callStore.remoteScreenSharing,
);
</script>

<template>
  <Teleport to="body">
    <Transition name="call-window">
      <div
        v-if="show"
        ref="callContainerRef"
        class="call-container fixed inset-0 z-50 flex flex-col"
        @mousemove="showControls"
        @click="showControls"
      >
        <!-- Hidden audio element — always in DOM for remote audio playback -->
        <video
          ref="remoteAudioRef"
          class="absolute h-0 w-0 opacity-0"
          autoplay
          playsinline
        />

        <!-- ═══ Header ═══ -->
        <Transition name="header-fade">
          <div
            v-show="controlsVisible || !isConnected || !isVideoCall"
            class="call-header absolute left-0 right-0 top-0 z-20 flex items-center justify-center safe-top"
            :class="isMobile ? 'px-3 py-3' : 'px-6 py-4'"
          >
            <!-- Minimize button (top-left) -->
            <button
              class="minimize-btn absolute left-4 z-30"
              style="top: calc(var(--safe-area-inset-top, 0px) + 16px)"
              :title="t('call.minimize')"
              @click="minimize"
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="4 14 10 14 10 20" />
                <polyline points="20 10 14 10 14 4" />
                <line x1="14" y1="10" x2="21" y2="3" />
                <line x1="3" y1="21" x2="10" y2="14" />
              </svg>
            </button>

            <div class="flex items-center" :class="isMobile ? 'gap-2' : 'gap-3'">
              <UserAvatar
                v-if="callStore.activeCall"
                :address="callStore.activeCall.peerAddress"
                size="sm"
              />
              <div class="text-center">
                <div
                  class="font-semibold text-white leading-tight"
                  :class="isMobile ? 'text-xs max-w-[160px] truncate' : 'text-sm'"
                >
                  {{ callStore.activeCall?.peerName }}
                </div>
                <div class="text-xs text-white/60 tabular-nums leading-tight">
                  {{ statusText }}
                </div>
              </div>
            </div>

            <!-- Screen sharing badge -->
            <Transition name="badge-pop">
              <div
                v-if="isAnyScreenSharing"
                class="absolute right-4 flex items-center gap-1.5 rounded-full bg-green-500/90 px-3 py-1 text-xs font-medium text-white shadow-lg"
                style="top: calc(var(--safe-area-inset-top, 0px) + 16px)"
              >
                <span class="h-2 w-2 shrink-0 contain-strict rounded-full bg-white animate-pulse" />
                {{ callStore.screenSharing ? t('call.screenShare') : t('call.screen') }}
              </div>
            </Transition>
          </div>
        </Transition>

        <!-- ═══ Layout: voice / simple-video / spotlight ═══ -->
        <Transition name="layout-crossfade" mode="out-in">
          <!-- Voice call -->
          <div
            v-if="layoutMode === 'voice'"
            key="voice"
            class="flex flex-1 flex-col items-center justify-center gap-5"
          >
            <!-- Pulsating avatar -->
            <div class="relative">
              <div class="call-pulse-ring absolute -inset-3 rounded-full" />
              <div class="call-pulse-ring-delay absolute -inset-6 rounded-full" />
              <UserAvatar
                v-if="callStore.activeCall"
                :address="callStore.activeCall.peerAddress"
                size="xl"
              />
            </div>
            <div class="text-center">
              <div class="text-xl font-semibold text-white">
                {{ callStore.activeCall?.peerName }}
              </div>
              <div class="mt-1 text-sm text-white/50 tabular-nums">
                {{ statusText }}
              </div>
            </div>
          </div>

          <!-- Simple video (1:1 no screen share) -->
          <div
            v-else-if="layoutMode === 'simple-video'"
            key="simple"
            class="flex flex-1"
          >
            <!-- Remote fullscreen -->
            <VideoTile
              :stream="callStore.remoteStream"
              :video-off="callStore.remoteVideoMuted"
              :address="peerAddress"
              object-fit="cover"
              muted
              class="h-full w-full !rounded-none"
            />

            <!-- Waiting overlay when no remote stream yet -->
            <Transition name="overlay-fade">
              <div
                v-if="!callStore.remoteStream"
                class="absolute inset-0 flex flex-col items-center justify-center"
              >
                <div class="relative">
                  <div class="call-pulse-ring absolute -inset-3 rounded-full" />
                  <UserAvatar
                    v-if="callStore.activeCall"
                    :address="callStore.activeCall.peerAddress"
                    size="xl"
                  />
                </div>
                <div class="mt-5 text-base text-white/60">
                  {{ statusText }}
                </div>
              </div>
            </Transition>

            <!-- Remote camera-off overlay -->
            <Transition name="overlay-fade">
              <div
                v-if="remoteVideoOff"
                class="absolute inset-0 flex flex-col items-center justify-center bg-black/50 backdrop-blur-sm"
              >
                <UserAvatar
                  v-if="callStore.activeCall"
                  :address="callStore.activeCall.peerAddress"
                  size="xl"
                />
                <div class="mt-4 text-sm text-white/40">
                  {{ t("call.peerCameraOff") }}
                </div>
              </div>
            </Transition>

            <!-- Local PiP (draggable, snaps to corners) -->
            <Transition name="pip-scale">
              <div
                v-show="showPip"
                ref="pipRef"
                class="pip-container absolute z-20"
                :style="pipCornerStyle"
                @pointerdown.prevent="onPipPointerDown"
                @pointermove="onPipPointerMove"
                @pointerup="onPipPointerUp"
                @pointercancel="onPipPointerUp"
              >
                <VideoTile
                  :stream="callStore.screenSharing && callStore.localScreenStream ? callStore.localScreenStream : callStore.localStream"
                  :mirror="!callStore.screenSharing"
                  :video-off="callStore.videoMuted && !callStore.screenSharing"
                  object-fit="cover"
                  muted
                  class="h-full w-full"
                />
              </div>
            </Transition>
          </div>

          <!-- Spotlight + filmstrip (screen share active) — Mobile: stacked -->
          <div
            v-else-if="isMobile"
            key="spotlight-mobile"
            class="flex flex-1 flex-col overflow-hidden pt-12 pb-20"
          >
            <!-- Spotlight (main area) -->
            <div class="flex flex-1 p-1.5">
              <VideoTile
                :stream="spotlightTile.stream"
                :video-off="spotlightTile.videoOff"
                :audio-off="spotlightTile.audioOff"
                :address="spotlightTile.address"
                :label="spotlightTile.label"
                :object-fit="spotlightTile.objectFit"
                :mirror="spotlightTile.mirror"
                muted
                class="h-full w-full"
              />
            </div>

            <!-- Filmstrip (horizontal scroll at bottom) -->
            <div class="flex shrink-0 gap-1.5 overflow-x-auto px-1.5 pb-1.5">
              <VideoTile
                v-for="tile in filmstripTiles"
                :key="tile.id"
                :stream="tile.stream"
                :video-off="tile.videoOff"
                :audio-off="tile.audioOff"
                :address="tile.address"
                :label="tile.label"
                :object-fit="tile.objectFit"
                :mirror="tile.mirror"
                :tile-id="tile.id"
                :active="effectivePinned === tile.id"
                muted
                pinnable
                class="h-[72px] w-[108px] shrink-0"
                @pin="onPinTile"
              />
            </div>
          </div>

          <!-- Spotlight + filmstrip (screen share active) — Desktop: side-by-side -->
          <div
            v-else
            key="spotlight-desktop"
            class="flex flex-1 overflow-hidden pt-14 pb-20"
          >
            <!-- Spotlight (main area) -->
            <div class="spotlight-main flex flex-1 p-3">
              <VideoTile
                :stream="spotlightTile.stream"
                :video-off="spotlightTile.videoOff"
                :audio-off="spotlightTile.audioOff"
                :address="spotlightTile.address"
                :label="spotlightTile.label"
                :object-fit="spotlightTile.objectFit"
                :mirror="spotlightTile.mirror"
                muted
                class="h-full w-full rounded-2xl"
              />
            </div>

            <!-- Filmstrip (centered vertical sidebar) -->
            <div class="flex w-[200px] shrink-0 flex-col items-center justify-center gap-3 p-3">
              <VideoTile
                v-for="tile in filmstripTiles"
                :key="tile.id"
                :stream="tile.stream"
                :video-off="tile.videoOff"
                :audio-off="tile.audioOff"
                :address="tile.address"
                :label="tile.label"
                :object-fit="tile.objectFit"
                :mirror="tile.mirror"
                :tile-id="tile.id"
                :active="effectivePinned === tile.id"
                muted
                pinnable
                class="aspect-video w-full max-w-[180px]"
                @pin="onPinTile"
              />
            </div>
          </div>
        </Transition>

        <!-- ═══ Controls ═══ -->
        <Transition name="controls-slide">
          <div
            v-show="controlsVisible || !isConnected || !isVideoCall"
            class="call-controls-bar absolute bottom-0 left-0 right-0 z-20 flex justify-center pb-safe"
            :class="isMobile ? 'pt-8' : 'pt-10'"
          >
            <CallControls :compact="isMobile" />
          </div>
        </Transition>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
/* ── Call container background ── */
.call-container {
  background: radial-gradient(ellipse at 50% 30%, #1a1a2e 0%, #0d0d14 60%, #000 100%);
}

/* ── Header glass ── */
.call-header {
  background: linear-gradient(to bottom, rgba(0, 0, 0, 0.5) 0%, transparent 100%);
}

/* ── Controls bar glass ── */
.call-controls-bar {
  background: linear-gradient(to top, rgba(0, 0, 0, 0.6) 0%, transparent 100%);
}

/* ── Spotlight main dark bg for screen share ── */
.spotlight-main {
  background: rgba(0, 0, 0, 0.15);
}

/* ── Minimize button ── */
.minimize-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.1);
  color: white;
  transition: background-color 0.15s ease, transform 0.12s ease;
}
.minimize-btn:hover {
  background: rgba(255, 255, 255, 0.2);
}
.minimize-btn:active {
  transform: scale(0.9);
}

/* ── PiP container ── */
.pip-container {
  border-radius: 12px;
  overflow: hidden;
  box-shadow: 0 4px 24px rgba(0, 0, 0, 0.4), 0 0 0 1.5px rgba(255, 255, 255, 0.12);
  cursor: grab;
  transition: top 0.35s cubic-bezier(0.34, 1.56, 0.64, 1),
              bottom 0.35s cubic-bezier(0.34, 1.56, 0.64, 1),
              left 0.35s cubic-bezier(0.34, 1.56, 0.64, 1),
              right 0.35s cubic-bezier(0.34, 1.56, 0.64, 1);
  touch-action: none;
  user-select: none;
}
.pip-container:active {
  cursor: grabbing;
}

/* ── Pulsating rings for voice / waiting ── */
.call-pulse-ring {
  background: rgba(255, 255, 255, 0.06);
  animation: pulse-ring 2.5s cubic-bezier(0.4, 0, 0.6, 1) infinite;
}
.call-pulse-ring-delay {
  background: rgba(255, 255, 255, 0.03);
  animation: pulse-ring 2.5s cubic-bezier(0.4, 0, 0.6, 1) infinite 0.8s;
}
@keyframes pulse-ring {
  0%, 100% { opacity: 0; transform: scale(0.85); }
  50% { opacity: 1; transform: scale(1); }
}

/* ── Call window enter/leave ── */
.call-window-enter-active {
  transition: opacity 0.35s ease, transform 0.35s cubic-bezier(0.34, 1.2, 0.64, 1);
}
.call-window-leave-active {
  transition: opacity 0.25s ease, transform 0.25s ease;
}
.call-window-enter-from {
  opacity: 0;
  transform: scale(0.96);
}
.call-window-leave-to {
  opacity: 0;
  transform: scale(0.98);
}

/* ── Header fade ── */
.header-fade-enter-active,
.header-fade-leave-active {
  transition: opacity 0.3s ease, transform 0.3s ease;
}
.header-fade-enter-from {
  opacity: 0;
  transform: translateY(-8px);
}
.header-fade-leave-to {
  opacity: 0;
  transform: translateY(-8px);
}

/* ── Controls slide ── */
.controls-slide-enter-active,
.controls-slide-leave-active {
  transition: opacity 0.3s ease, transform 0.3s ease;
}
.controls-slide-enter-from {
  opacity: 0;
  transform: translateY(12px);
}
.controls-slide-leave-to {
  opacity: 0;
  transform: translateY(12px);
}

/* ── Layout crossfade ── */
.layout-crossfade-enter-active {
  transition: opacity 0.3s ease;
}
.layout-crossfade-leave-active {
  transition: opacity 0.2s ease;
}
.layout-crossfade-enter-from,
.layout-crossfade-leave-to {
  opacity: 0;
}

/* ── Overlay fade ── */
.overlay-fade-enter-active,
.overlay-fade-leave-active {
  transition: opacity 0.35s ease;
}
.overlay-fade-enter-from,
.overlay-fade-leave-to {
  opacity: 0;
}

/* ── PiP scale ── */
.pip-scale-enter-active {
  transition: opacity 0.25s ease, transform 0.3s cubic-bezier(0.34, 1.4, 0.64, 1);
}
.pip-scale-leave-active {
  transition: opacity 0.2s ease, transform 0.2s ease;
}
.pip-scale-enter-from {
  opacity: 0;
  transform: scale(0.7);
}
.pip-scale-leave-to {
  opacity: 0;
  transform: scale(0.8);
}

/* ── Badge pop ── */
.badge-pop-enter-active {
  transition: opacity 0.2s ease, transform 0.3s cubic-bezier(0.34, 1.4, 0.64, 1);
}
.badge-pop-leave-active {
  transition: opacity 0.15s ease, transform 0.15s ease;
}
.badge-pop-enter-from {
  opacity: 0;
  transform: scale(0.6);
}
.badge-pop-leave-to {
  opacity: 0;
  transform: scale(0.8);
}
</style>
