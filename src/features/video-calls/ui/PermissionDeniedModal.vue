<script setup lang="ts">
import { computed } from "vue";
import { callPermissionError, clearCallPermissionError } from "../model/permissions";

const { t } = useI18n();

const show = computed(() => callPermissionError.value !== null);

/**
 * Session 01 — reason-aware message selection. The legacy modal showed the
 * same "permission denied" copy regardless of whether the OS truly denied
 * access, another app was holding the mic, or no microphone device existed.
 * Users (rightly) interpreted "permission denied" as a settings problem and
 * spent time toggling it in Settings — leaving the mic still held by another
 * app. Split the copy so each failure mode gets actionable guidance.
 */
const deviceMessage = computed(() => {
  const err = callPermissionError.value;
  if (!err) return "";
  if (err.device === "camera") return t("call.permissionDenied.camera");

  // Microphone with specific probe reason takes precedence over the generic
  // "denied" message. Older bridges / web paths default reason to "denied".
  if (err.reason === "audio_source_busy") {
    const apps = err.conflicting?.filter((a) => a && a.length > 0) ?? [];
    if (apps.length > 0) {
      return t("call.permissionDenied.audioBusyWithApps", { apps: apps.join(", ") });
    }
    return t("call.permissionDenied.audioBusy");
  }
  if (err.reason === "no_input_device") {
    return t("call.permissionDenied.noInputDevice");
  }
  return t("call.permissionDenied.microphone");
});

// Instructions row is only useful when the problem is a settings-level
// denial. If the mic is busy or missing, showing a "go to settings" hint
// confuses users — the root cause is not a permission toggle. Hide it.
const showInstructions = computed(() => {
  const err = callPermissionError.value;
  if (!err) return false;
  return err.device === "camera" || err.reason === "denied";
});

function close() {
  clearCallPermissionError();
}
</script>

<template>
  <Teleport to="body">
    <Transition name="perm-modal">
      <div
        v-if="show"
        class="perm-modal-backdrop fixed inset-0 z-[60] flex items-center justify-center"
        role="dialog"
        aria-modal="true"
        aria-labelledby="perm-denied-title"
        @click.self="close"
      >
        <div class="perm-modal-card mx-4 max-w-sm rounded-xl bg-background-main p-5 shadow-2xl">
          <div class="mb-3 flex items-start gap-3">
            <div class="perm-modal-icon flex h-10 w-10 shrink-0 items-center justify-center rounded-full">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z" />
                <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                <line x1="12" y1="19" x2="12" y2="23" />
                <line x1="8" y1="23" x2="16" y2="23" />
                <line x1="4" y1="4" x2="20" y2="20" />
              </svg>
            </div>
            <div class="flex-1">
              <h3 id="perm-denied-title" class="text-base font-semibold text-text-color">
                {{ t("call.permissionDenied.title") }}
              </h3>
              <p class="mt-1 text-sm text-text-on-main-bg-color">
                {{ deviceMessage }}
              </p>
            </div>
          </div>

          <p v-if="showInstructions" class="mb-4 text-sm text-text-on-main-bg-color">
            {{ t("call.permissionDenied.instructions") }}
          </p>

          <div class="flex justify-end">
            <button
              type="button"
              class="rounded-lg bg-color-bg-ac px-4 py-2 text-sm font-medium text-text-on-bg-ac-color transition-colors hover:bg-color-bg-ac-1"
              @click="close"
            >
              {{ t("call.permissionDenied.close") }}
            </button>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.perm-modal-backdrop {
  background: rgba(0, 0, 0, 0.55);
  backdrop-filter: blur(4px);
}

.perm-modal-icon {
  background: rgba(239, 68, 68, 0.15);
  color: rgb(239, 68, 68);
}

.perm-modal-enter-active,
.perm-modal-leave-active {
  transition: opacity 0.2s ease;
}
.perm-modal-enter-active .perm-modal-card,
.perm-modal-leave-active .perm-modal-card {
  transition: transform 0.25s cubic-bezier(0.34, 1.4, 0.64, 1);
}
.perm-modal-enter-from,
.perm-modal-leave-to {
  opacity: 0;
}
.perm-modal-enter-from .perm-modal-card {
  transform: scale(0.92);
}
.perm-modal-leave-to .perm-modal-card {
  transform: scale(0.96);
}
</style>
