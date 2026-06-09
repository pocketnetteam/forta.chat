<script setup lang="ts">
import { useCallStore, CallStatus } from "@/entities/call";
import { UserAvatar } from "@/entities/user";
import { useCallService } from "../model/call-service";
import { isNative } from "@/shared/lib/platform";
import { useAndroidBackHandler } from "@/shared/lib/composables/use-android-back-handler";

const INCOMING_TIMEOUT_SECONDS = 30;

const callStore = useCallStore();
const callService = useCallService();
const { t } = useI18n();

const show = computed(
  // On native, incoming call UI is handled by IncomingCallActivity (ConnectionService)
  () => !isNative && callStore.activeCall?.status === CallStatus.incoming,
);

// WEE-45 / forta-bugs#724 — visible double-tap guard. answerCall has a
// sync re-entry lock at the service layer, but without disabling the
// button the user sees no feedback on first tap and bangs it again
// (especially on slow Android WebView), which compounds the impression
// that the button "doesn't work". Setting accepting=true synchronously
// on first click keeps the UI in sync with the actual call state until
// the modal hides on status transition.
const accepting = ref(false);
const rejecting = ref(false);

function onAccept() {
  if (accepting.value || rejecting.value) return;
  accepting.value = true;
  callService.answerCall();
}

function onReject() {
  if (rejecting.value) return;
  rejecting.value = true;
  callService.rejectCall();
}

// WEE-63 / forta-bugs#759 — Android Back on the incoming ringer rejects the
// call instead of minimizing the app. Priority 100 (same tier as the active
// call window) so it wins over chat/router handlers. Returns false when the
// modal isn't showing so Back falls through to the normal handler chain.
useAndroidBackHandler("incoming-call-modal", 100, () => {
  if (!show.value) return false;
  onReject();
  return true;
});

const countdown = ref(INCOMING_TIMEOUT_SECONDS);
let countdownInterval: ReturnType<typeof setInterval> | null = null;

function startCountdown() {
  stopCountdown();
  countdown.value = INCOMING_TIMEOUT_SECONDS;
  countdownInterval = setInterval(() => {
    countdown.value--;
    if (countdown.value <= 0) {
      stopCountdown();
      callService.rejectCall();
    }
  }, 1000);
}

function stopCountdown() {
  if (countdownInterval !== null) {
    clearInterval(countdownInterval);
    countdownInterval = null;
  }
}

// Start/stop countdown when modal visibility changes
watch(show, (visible) => {
  if (visible) {
    startCountdown();
    // Reset the click-once flags when a fresh incoming call appears so a
    // previous accept/reject doesn't keep the buttons locked on a new ring.
    accepting.value = false;
    rejecting.value = false;
  } else {
    stopCountdown();
  }
}, { immediate: true });

onUnmounted(() => {
  stopCountdown();
});
</script>

<template>
  <Teleport to="body">
    <Transition name="fade">
      <div
        v-if="show"
        class="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm safe-all"
      >
        <div class="flex flex-col items-center gap-6">
          <!-- Pulsating ring animation -->
          <div class="relative">
            <div class="absolute inset-0 animate-ping rounded-full bg-color-good/30" style="animation-duration: 2s" />
            <div class="absolute -inset-2 animate-pulse rounded-full bg-color-good/20" style="animation-duration: 1.5s" />
            <UserAvatar
              v-if="callStore.activeCall"
              :address="callStore.activeCall.peerAddress"
              size="xl"
            />
          </div>

          <!-- Caller info -->
          <div class="text-center">
            <h3 class="text-xl font-bold text-white">
              {{ callStore.activeCall?.peerName }}
            </h3>
            <p class="mt-1 text-sm text-white/70">
              {{
                callStore.activeCall?.type === "video"
                  ? t("call.incomingVideo")
                  : t("call.incomingVoice")
              }}
            </p>
            <p class="mt-1 text-xs text-white/40 tabular-nums">
              {{ countdown }}s
            </p>
          </div>

          <!-- Accept / Reject buttons -->
          <div class="flex gap-8">
            <button
              class="flex h-16 w-16 items-center justify-center rounded-full bg-color-bad text-white transition-transform hover:scale-110 active:scale-95 disabled:opacity-60 disabled:hover:scale-100"
              :title="t('call.decline')"
              :disabled="rejecting"
              @click="onReject"
            >
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M10.68 13.31a16 16 0 003.41 2.6l1.27-1.27a2 2 0 012.11-.45 12.84 12.84 0 002.81.7 2 2 0 011.72 2v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07 19.5 19.5 0 01-6-6 19.79 19.79 0 01-3.07-8.67A2 2 0 014.11 2h3a2 2 0 012 1.72 12.84 12.84 0 00.7 2.81 2 2 0 01-.45 2.11L8.09 9.91" />
                <line x1="23" y1="1" x2="1" y2="23" />
              </svg>
            </button>
            <button
              class="flex h-16 w-16 items-center justify-center rounded-full bg-color-good text-white transition-transform hover:scale-110 active:scale-95 disabled:opacity-60 disabled:hover:scale-100"
              :title="t('call.accept')"
              :disabled="accepting || rejecting"
              @click="onAccept"
            >
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07 19.5 19.5 0 01-6-6 19.79 19.79 0 01-3.07-8.67A2 2 0 014.11 2h3a2 2 0 012 1.72c.127.96.361 1.903.7 2.81a2 2 0 01-.45 2.11L8.09 9.91a16 16 0 006 6l1.27-1.27a2 2 0 012.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0122 16.92z" />
              </svg>
            </button>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.3s ease;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>
