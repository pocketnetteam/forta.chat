<script setup lang="ts">
import { useCallStore } from "@/entities/call";
import { useChatStore } from "@/entities/chat";
import { UserAvatar } from "@/entities/user";
import { formatDuration } from "@/shared/lib/format";
import { useCallService } from "../model/call-service";

const callStore = useCallStore();
const chatStore = useChatStore();
const callService = useCallService();
const { t } = useI18n();

const show = computed(
  () =>
    callStore.isInCall &&
    (callStore.minimized ||
      callStore.activeCall?.roomId !== chatStore.activeRoomId),
);

const returnToCall = () => {
  if (callStore.activeCall) {
    callStore.minimized = false;
    chatStore.setActiveRoom(callStore.activeCall.roomId);
  }
};

const endCall = (e: Event) => {
  e.stopPropagation();
  callService.hangup();
};
</script>

<template>
  <Transition name="status-slide">
    <div
      v-if="show"
      class="status-bar"
      @click="returnToCall"
    >
      <!-- Pulsating green dot -->
      <span class="status-dot" />

      <!-- Peer avatar -->
      <UserAvatar
        v-if="callStore.activeCall"
        :address="callStore.activeCall.peerAddress"
        size="sm"
      />

      <!-- Name + timer -->
      <div class="flex flex-col leading-tight">
        <span class="max-w-[150px] truncate text-sm font-medium text-white">
          {{ callStore.activeCall?.peerName }}
        </span>
        <span class="text-xs tabular-nums text-white/60">
          {{ formatDuration(callStore.callTimer) }}
        </span>
      </div>

      <!-- Return button -->
      <button class="return-btn">
        {{ t("call.returnToCall") }}
      </button>

      <!-- Hangup button -->
      <button
        class="hangup-btn"
        :title="t('call.hangup')"
        @click="endCall"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <line x1="18" y1="6" x2="6" y2="18" />
          <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </button>
    </div>
  </Transition>
</template>

<style scoped>
/* ── Floating pill bar ── */
.status-bar {
  position: fixed;
  top: 8px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 40;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 16px 6px 12px;
  border-radius: 9999px;
  background: rgba(20, 20, 28, 0.85);
  backdrop-filter: blur(20px);
  -webkit-backdrop-filter: blur(20px);
  border: 1px solid rgba(255, 255, 255, 0.08);
  box-shadow: 0 4px 24px rgba(0, 0, 0, 0.4), 0 0 0 1px rgba(255, 255, 255, 0.05);
  cursor: pointer;
  transition: background-color 0.2s ease, box-shadow 0.2s ease;
}
.status-bar:hover {
  background: rgba(30, 30, 40, 0.95);
  box-shadow: 0 4px 28px rgba(0, 0, 0, 0.5), 0 0 0 1px rgba(255, 255, 255, 0.1);
}

/* ── Pulsating green dot ── */
.status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #22c55e;
  box-shadow: 0 0 6px rgba(34, 197, 94, 0.6);
  animation: dot-pulse 2s ease-in-out infinite;
  flex-shrink: 0;
}
@keyframes dot-pulse {
  0%, 100% { opacity: 1; box-shadow: 0 0 6px rgba(34, 197, 94, 0.6); }
  50% { opacity: 0.6; box-shadow: 0 0 12px rgba(34, 197, 94, 0.9); }
}

/* ── Return button ── */
.return-btn {
  margin-left: 4px;
  padding: 4px 12px;
  border-radius: 9999px;
  background: rgba(34, 197, 94, 0.2);
  color: #4ade80;
  font-size: 12px;
  font-weight: 600;
  transition: background-color 0.15s ease;
  white-space: nowrap;
}
.return-btn:hover {
  background: rgba(34, 197, 94, 0.35);
}

/* ── Hangup button ── */
.hangup-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border-radius: 50%;
  background: rgba(239, 68, 68, 0.2);
  color: #f87171;
  transition: background-color 0.15s ease;
  flex-shrink: 0;
}
.hangup-btn:hover {
  background: rgba(239, 68, 68, 0.4);
}

/* ── Slide transition ── */
.status-slide-enter-active {
  transition: transform 0.35s cubic-bezier(0.34, 1.2, 0.64, 1), opacity 0.35s ease;
}
.status-slide-leave-active {
  transition: transform 0.25s ease, opacity 0.25s ease;
}
.status-slide-enter-from {
  transform: translateX(-50%) translateY(-120%);
  opacity: 0;
}
.status-slide-leave-to {
  transform: translateX(-50%) translateY(-120%);
  opacity: 0;
}
</style>
