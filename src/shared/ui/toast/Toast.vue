<script setup lang="ts">
interface Props {
  message: string;
  type?: "info" | "success" | "error";
  show: boolean;
}

const props = withDefaults(defineProps<Props>(), { type: "info" });
const emit = defineEmits<{ close: [] }>();

const typeClasses = computed(() => ({
  info: "bg-color-bg-ac text-text-on-bg-ac-color",
  success: "bg-color-good text-white",
  error: "bg-color-bad text-white"
}[props.type]));

watch(() => props.show, (val) => {
  if (val) {
    setTimeout(() => emit("close"), 3000);
  }
});
</script>

<template>
  <Teleport to="body">
    <transition name="toast-slide">
      <div
        v-if="props.show"
        role="status"
        aria-live="polite"
        :class="typeClasses"
        class="fixed left-1/2 z-50 -translate-x-1/2 rounded-lg px-4 py-2 text-sm shadow-lg"
        style="bottom: calc(1.5rem + var(--safe-area-inset-bottom, 0px))"
      >
        {{ props.message }}
      </div>
    </transition>
  </Teleport>
</template>

<style scoped>
.toast-slide-enter-active {
  transition: opacity 0.3s cubic-bezier(0.34, 1.56, 0.64, 1), transform 0.3s cubic-bezier(0.34, 1.56, 0.64, 1);
}
.toast-slide-leave-active {
  transition: opacity 0.2s ease-in, transform 0.2s ease-in;
}
.toast-slide-enter-from {
  opacity: 0;
  transform: translate(-50%, 20px) scale(0.9);
}
.toast-slide-leave-to {
  opacity: 0;
  transform: translate(-50%, 20px) scale(0.9);
}
</style>
