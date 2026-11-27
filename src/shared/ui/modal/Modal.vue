<script setup lang="ts">
import { useAndroidBackHandler } from "@/shared/lib/composables/use-android-back-handler";
import { useMobile } from "@/shared/lib/composables/use-media-query";
import { isNative } from "@/shared/lib/platform";
import { useSwipeDismiss } from "./use-swipe-dismiss";

/** Where to put focus when the modal opens. */
export type ModalInitialFocus = "first-focusable" | "dialog" | "none";

interface Props {
  show: boolean;
  /** Optional accessible label for the dialog */
  ariaLabel?: string;
  /** Desktop width: `md` for forms and confirmations, `lg` for content (a post). */
  size?: "md" | "lg";
  /** No inner padding: the content (a video) runs to the card edges. */
  bare?: boolean;
  /**
   * Initial focus target. Default: `dialog` on native/mobile (no IME pop),
   * `first-focusable` on desktop. Forms that need the keyboard pass
   * `first-focusable` explicitly.
   */
  initialFocus?: ModalInitialFocus;
}

const props = withDefaults(defineProps<Props>(), {
  ariaLabel: undefined,
  size: "md",
  bare: false,
  initialFocus: undefined,
});

const isMobile = useMobile();
/** `close` asks the owner to hide the modal; `closed` fires once the leave animation is over. */
const emit = defineEmits<{ close: []; closed: [] }>();
const { t } = useI18n();

/** Below Tailwind `sm` the modal is a bottom sheet (layout in the styles below). */
const SHEET_QUERY = "(max-width: 639px)";
const SIZE_CLASS = { md: "sm:max-w-lg", lg: "sm:max-w-2xl" } as const;

const dialogRef = ref<HTMLElement>();
const bodyRef = ref<HTMLElement>();

// Android back: close modal when shown
const modalId = `modal-${Math.random().toString(36).slice(2, 8)}`;
useAndroidBackHandler(modalId, 90, () => {
  if (!props.show) return false;
  emit("close");
  return true;
});

const requestClose = () => {
  emit("close");
};

const swipe = useSwipeDismiss({
  isEnabled: () => typeof window !== "undefined" && window.matchMedia?.(SHEET_QUERY).matches === true,
  getScrollEl: () => bodyRef.value,
  getSheetEl: () => dialogRef.value,
  onDismiss: requestClose,
});

// No inline transform at rest: it would outrank the enter transition's transform.
const cardStyle = computed(() => {
  if (swipe.offset.value <= 0) return undefined;
  return {
    transform: `translateY(${swipe.offset.value}px)`,
    transition: swipe.dragging.value ? "none" : undefined,
  };
});

const backdropStyle = computed(() => {
  if (swipe.offset.value <= 0) return undefined;
  const height = dialogRef.value?.offsetHeight || 1;
  return { opacity: String(1 - Math.min(1, swipe.offset.value / height) * 0.7) };
});

const onKeydown = (e: KeyboardEvent) => {
  if (e.key === "Escape") {
    e.stopPropagation();
    emit("close");
    return;
  }
  // Focus trap: Tab / Shift+Tab cycle within modal
  if (e.key === "Tab") {
    const el = dialogRef.value;
    if (!el) return;
    const focusable = el.querySelectorAll<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    );
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }
};

function resolveInitialFocus(): ModalInitialFocus {
  if (props.initialFocus) return props.initialFocus;
  // Soft-keyboard risk: focusing an input opens the IME over the sheet.
  if (isNative || isMobile.value) return "dialog";
  return "first-focusable";
}

// Focus when shown — policy avoids IME on mobile unless the caller opts in.
// `immediate` covers mount-with-show=true (Donate / forms that open already visible).
watch(
  () => props.show,
  (val) => {
    if (val) {
      // A sheet closed by a swipe kept its offset for the slide-out.
      swipe.reset();
      nextTick(() => {
        const el = dialogRef.value;
        if (!el) return;
        const mode = resolveInitialFocus();
        if (mode === "none") return;
        if (mode === "dialog") {
          el.focus();
          return;
        }
        const firstFocusable = el.querySelector<HTMLElement>(
          'button:not([data-modal-close]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
        );
        if (firstFocusable) firstFocusable.focus();
        else el.focus();
      });
    }
  },
  { immediate: true },
);

const onAfterLeave = () => {
  swipe.reset();
  emit("closed");
};
</script>

<template>
  <Teleport to="body">
    <transition name="modal" :duration="{ enter: 300, leave: 250 }" @after-leave="onAfterLeave">
      <!-- contain-strict: the root is exactly the viewport (fixed inset-0), so size
           containment is safe; it keeps layout/paint inside the modal (video, swipe,
           comments) from invalidating the page behind it. -->
      <div v-if="props.show" class="modal-root contain-strict fixed inset-0 z-50" @keydown="onKeydown">
        <div class="modal-backdrop absolute inset-0 bg-background-overlay" :style="backdropStyle" />

        <!-- Desktop: the whole viewport scrolls, so the scrollbar sits at the
             screen edge instead of being clipped by the card's rounded corners. -->
        <div
          class="modal-scroller absolute inset-0 overflow-y-auto overscroll-contain"
          data-testid="modal-scroller"
          @click.self="requestClose"
        >
          <div class="modal-frame flex min-h-full items-center justify-center px-4 py-16" @click.self="requestClose">
            <div
              ref="dialogRef"
              role="dialog"
              aria-modal="true"
              :aria-label="props.ariaLabel"
              tabindex="-1"
              class="modal-card relative flex w-full flex-col overflow-hidden rounded-2xl bg-background-total-theme shadow-2xl outline-none"
              :class="SIZE_CLASS[props.size]"
              :style="cardStyle"
              @touchstart="swipe.onTouchStart"
              @touchmove="swipe.onTouchMove"
              @touchend="swipe.onTouchEnd"
              @touchcancel="swipe.onTouchCancel"
            >
              <div class="modal-handle" aria-hidden="true">
                <div class="h-1 w-10 rounded-full" :class="props.bare ? 'bg-white/70' : 'bg-neutral-grad-2'" />
              </div>
              <button
                type="button"
                data-modal-close
                data-testid="modal-close-inline"
                class="modal-close-inline h-8 w-8 items-center justify-center rounded-full transition-colors"
                :class="props.bare
                  ? 'bg-black/40 text-white hover:bg-black/60'
                  : 'bg-neutral-grad-0 text-text-on-main-bg-color hover:bg-neutral-grad-1'"
                :aria-label="t('common.close')"
                @click="requestClose"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                  <path d="M18 6L6 18M6 6l12 12" />
                </svg>
              </button>
              <div ref="bodyRef" class="modal-body" :class="{ 'modal-body-padded p-6': !props.bare }">
                <slot />
              </div>
            </div>
          </div>
        </div>

        <button
          type="button"
          data-modal-close
          data-testid="modal-close"
          class="modal-close-corner fixed right-6 h-10 w-10 items-center justify-center rounded-full bg-white/10 text-white transition-colors hover:bg-white/20"
          :aria-label="t('common.close')"
          @click="requestClose"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
            <path d="M18 6L6 18M6 6l12 12" />
          </svg>
        </button>
      </div>
    </transition>
  </Teleport>
</template>

<style scoped>
/* ── Desktop: centered card, page-level scroll, close button in the screen corner ── */
.modal-handle,
.modal-close-inline {
  display: none;
}
.modal-close-corner {
  display: flex;
  top: calc(var(--safe-area-inset-top, 0px) + 1rem);
}

/* ── Mobile: full-width bottom sheet, swipe down to close ── */
@media (max-width: 639px) {
  .modal-scroller {
    overflow: hidden;
  }
  .modal-frame {
    align-items: flex-end;
    padding: 0;
  }
  .modal-card {
    border-radius: 1rem 1rem 0 0;
    max-height: calc((100vh - var(--safe-area-inset-top, 0px)) * 0.95);
    max-height: calc((100dvh - var(--safe-area-inset-top, 0px)) * 0.95);
    /* The sheet holds text fields: lift its content above the keyboard / nav bar. */
    padding-bottom: max(var(--app-bottom-inset, 0px), var(--safe-area-inset-bottom, 0px));
    transition: transform 0.3s cubic-bezier(0.32, 0.72, 0, 1);
  }
  .modal-handle {
    position: absolute;
    inset: 0 0 auto;
    z-index: 10;
    display: flex;
    justify-content: center;
    padding: 0.5rem 0;
    pointer-events: none;
  }
  .modal-close-inline {
    position: absolute;
    top: 0.625rem;
    right: 0.625rem;
    z-index: 10;
    display: flex;
  }
  .modal-close-corner {
    display: none;
  }
  .modal-body {
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
    overscroll-behavior: contain;
  }
  /* Clear the handle and the close button above the content. */
  .modal-body-padded {
    padding-top: 3rem;
  }
}

/* ── Transitions ── */
.modal-enter-active .modal-backdrop,
.modal-enter-active .modal-close-corner {
  transition: opacity 0.3s cubic-bezier(0.32, 0.72, 0, 1);
}
.modal-leave-active .modal-backdrop,
.modal-leave-active .modal-close-corner {
  transition: opacity 0.2s ease-in;
}
.modal-enter-from .modal-backdrop,
.modal-enter-from .modal-close-corner,
.modal-leave-to .modal-close-corner {
  opacity: 0;
}
/* !important: a swipe leaves an inline opacity on the backdrop. */
.modal-leave-to .modal-backdrop {
  opacity: 0 !important;
}
.modal-leave-active {
  /* The fading overlay must not swallow the next tap (WEE-66 / #863). */
  pointer-events: none;
}

.modal-enter-active .modal-card {
  transition: transform 0.3s cubic-bezier(0.32, 0.72, 0, 1), opacity 0.3s cubic-bezier(0.32, 0.72, 0, 1);
}
.modal-leave-active .modal-card {
  transition: transform 0.2s ease-in, opacity 0.2s ease-in;
}
.modal-enter-from .modal-card,
.modal-leave-to .modal-card {
  opacity: 0;
  transform: scale(0.96) translateY(8px);
}

@media (max-width: 639px) {
  .modal-leave-active .modal-card {
    transition: transform 0.25s cubic-bezier(0.4, 0, 1, 1);
  }
  /* !important: after a swipe the sheet slides out from the inline offset. */
  .modal-enter-from .modal-card,
  .modal-leave-to .modal-card {
    opacity: 1;
    transform: translateY(100%) !important;
  }
}
</style>
