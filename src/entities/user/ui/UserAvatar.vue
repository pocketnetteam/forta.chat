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

// Lazy-load the profile data when element enters viewport, but always render
// the underlying Avatar — it falls back to a colored initials tile when src/name
// are empty. Previously we swapped between a gray placeholder div and Avatar on
// isVisible flip, which produced visible flicker on every RecycleScroller recycle
// (each recycled row starts with isVisible=false for a frame).
watch(isVisible, (visible) => {
  if (visible) userStore.loadUserIfMissing(props.address);
});

watch(() => props.address, (addr) => {
  if (isVisible.value) userStore.loadUserIfMissing(addr);
});
</script>

<template>
  <div ref="rootRef">
    <Avatar
      :src="user?.image"
      :name="user?.name || address"
      :size="props.size"
    />
  </div>
</template>
