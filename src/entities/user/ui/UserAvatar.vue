<script setup lang="ts">
import { ref } from "vue";
import { useUserStore } from "../model";
import { useLazyLoad } from "@/shared/lib/use-lazy-load";

interface Props {
  address: string;
  size?: "sm" | "md" | "lg" | "xl";
}

const props = withDefaults(defineProps<Props>(), { size: "md" });

const userStore = useUserStore();
const rootRef = ref<HTMLElement>();
const { isVisible } = useLazyLoad(rootRef);

const user = computed(() => userStore.getUser(props.address));

const sizeClasses = computed(() => ({
  sm: "h-8 w-8",
  md: "h-10 w-10",
  lg: "h-14 w-14",
  xl: "h-20 w-20",
}[props.size]));

const iconSize = computed(() => ({
  sm: 14,
  md: 20,
  lg: 28,
  xl: 36,
}[props.size]));

// Only load profile when element is visible
watch(isVisible, (visible) => {
  if (visible) userStore.loadUserIfMissing(props.address);
});

watch(() => props.address, (addr) => {
  if (isVisible.value) userStore.loadUserIfMissing(addr);
});
</script>

<template>
  <div ref="rootRef">
    <div
      v-if="isVisible && user?.deleted"
      class="flex shrink-0 items-center justify-center rounded-full bg-neutral-grad-2"
      :class="sizeClasses"
    >
      <svg :width="iconSize" :height="iconSize" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" class="text-text-on-main-bg-color">
        <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><line x1="17" y1="8" x2="23" y2="14" /><line x1="23" y1="8" x2="17" y2="14" />
      </svg>
    </div>
    <Avatar
      v-else-if="isVisible"
      :src="user?.image"
      :name="user?.name || address"
      :size="props.size"
    />
    <div
      v-else
      class="rounded-full bg-neutral-grad-0"
      :class="sizeClasses"
    />
  </div>
</template>
