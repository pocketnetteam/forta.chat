<script setup lang="ts">
interface Props {
  show: boolean;
  /** Optional accessible label for the dialog */
  ariaLabel?: string;
}

const props = defineProps<Props>();
const emit = defineEmits<{ close: [] }>();

const dialogRef = ref<HTMLElement>();

const onOverlayClick = () => {
  emit("close");
};

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

// Auto-focus the dialog when shown
watch(() => props.show, (val) => {
  if (val) {
    nextTick(() => {
      // Focus the first focusable element inside, or the dialog itself
      const el = dialogRef.value;
      if (!el) return;
      const firstFocusable = el.querySelector<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
      );
      if (firstFocusable) firstFocusable.focus();
      else el.focus();
    });
  }
});
</script>

<template>
  <Teleport to="body">
    <transition name="modal-fade">
      <div
        v-if="props.show"
        class="fixed inset-0 z-50 flex items-center justify-center bg-background-overlay"
        @click.self="onOverlayClick"
        @keydown="onKeydown"
      >
        <div
          ref="dialogRef"
          role="dialog"
          aria-modal="true"
          :aria-label="props.ariaLabel"
          tabindex="-1"
          class="max-h-[90vh] w-full max-w-md overflow-auto rounded-xl bg-background-total-theme p-6 shadow-xl outline-none"
        >
          <slot />
        </div>
      </div>
    </transition>
  </Teleport>
</template>

<style scoped>
.modal-fade-enter-active {
  transition: opacity 0.25s cubic-bezier(0.32, 0.72, 0, 1);
}
.modal-fade-leave-active {
  transition: opacity 0.2s ease-in;
}
.modal-fade-enter-from,
.modal-fade-leave-to {
  opacity: 0;
}

/* Content card scale entrance */
.modal-fade-enter-active > div {
  transition: transform 0.25s cubic-bezier(0.32, 0.72, 0, 1), opacity 0.25s cubic-bezier(0.32, 0.72, 0, 1);
}
.modal-fade-leave-active > div {
  transition: transform 0.2s ease-in, opacity 0.2s ease-in;
}
.modal-fade-enter-from > div {
  opacity: 0;
  transform: scale(0.95) translateY(8px);
}
.modal-fade-leave-to > div {
  opacity: 0;
  transform: scale(0.95) translateY(8px);
}
</style>
