<script setup lang="ts">
import { useDrawerStore } from "../model";

interface Props {
  id: string;
}

const props = defineProps<Props>();

const drawerStore = useDrawerStore();

const isDisplayCurrentDrawer = computed(
  () => props.id === drawerStore.currentDrawerId
);
const canShowOverlay = ref(false);

watch(isDisplayCurrentDrawer, isVisible => {
  if (isVisible) {
    canShowOverlay.value = true;
  }
});

const closeDrawer = () => {
  drawerStore.setDrawerId(undefined);
};

const onAfterLeaveTransition = () => {
  canShowOverlay.value = false;
};

onUnmounted(closeDrawer);
</script>

<template>
  <Teleport to="body">
    <transition @after-leave="onAfterLeaveTransition" name="fade">
      <div
        v-show="canShowOverlay"
        class="fixed inset-0 z-40 bg-background-overlay"
        @click="closeDrawer"
      >
        <transition @after-leave="onAfterLeaveTransition" name="slide-in">
          <div
            v-show="isDisplayCurrentDrawer"
            class="h-screen w-[320px] bg-background-total-theme safe-y"
            @click.stop
          >
            <slot name="content" />
          </div>
        </transition>
      </div>
    </transition>
  </Teleport>
</template>

<style scoped>
.fade-enter-active {
  transition: opacity 0.25s ease-out;
}
.fade-leave-active {
  transition: opacity 0.2s ease-in;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}

.slide-in-enter-active {
  transition: transform 0.25s ease-out;
}
.slide-in-leave-active {
  transition: transform 0.2s ease-in;
}
.slide-in-enter-from,
.slide-in-leave-to {
  transform: translateX(-100%);
}
.slide-in-enter-to,
.slide-in-leave-from {
  transform: translateX(0);
}
</style>
