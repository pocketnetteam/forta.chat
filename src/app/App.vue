<script setup lang="ts">
import { useAuthStore } from "@/entities/auth";
import { useToast } from "@/shared/lib/use-toast";
import Toast from "@/shared/ui/toast/Toast.vue";
import TitleBar from "@/widgets/title-bar/TitleBar.vue";
import IncomingCallModal from "@/features/video-calls/ui/IncomingCallModal.vue";
import CallWindow from "@/features/video-calls/ui/CallWindow.vue";
import CallStatusBar from "@/features/video-calls/ui/CallStatusBar.vue";

import { AppPages, AppRoutes, EAppProviders } from "./providers";

const isElectron = !!(window as any).electronAPI?.isElectron;

const { message: toastMessage, type: toastType, show: toastShow, close: toastClose } = useToast();

provide(EAppProviders.AppRoutes, AppRoutes);
provide(EAppProviders.AppPages, AppPages);

const authStore = useAuthStore();

const isMobile = ref(window.innerWidth < 768);
const onResize = () => { isMobile.value = window.innerWidth < 768; };

onMounted(async () => {
  window.addEventListener("resize", onResize);

  // Mark Electron mode on <html> for CSS adjustments (drag regions, traffic light padding)
  if ((window as any).electronAPI?.isElectron) {
    document.documentElement.classList.add("is-electron");
    if ((window as any).electronAPI?.platform === "darwin") {
      document.documentElement.classList.add("is-electron-mac");
    }
  }

  // Keyboard height detection via visualViewport API
  if (window.visualViewport) {
    const vv = window.visualViewport;
    const updateKeyboardHeight = () => {
      const kbh = window.innerHeight - vv.height;
      document.documentElement.style.setProperty("--keyboardheight", `${Math.max(0, kbh)}px`);
    };
    vv.addEventListener("resize", updateKeyboardHeight);
    onUnmounted(() => vv.removeEventListener("resize", updateKeyboardHeight));
  }

  try {
    await authStore.fetchUserInfo();
  } catch (e) {
    console.error("[App] fetchUserInfo error:", e);
  }

  // Initialize Matrix on reload if already logged in
  if (authStore.isAuthenticated && !authStore.matrixReady) {
    await authStore.initMatrix();
  }
});

onUnmounted(() => {
  window.removeEventListener("resize", onResize);
});
</script>

<template>
  <div class="relative flex flex-col bg-background-total-theme text-text-color" style="height: 100vh; height: 100dvh; padding-top: env(safe-area-inset-top, 0px)">
    <TitleBar v-if="isElectron" />
    <div class="relative min-h-0 flex-1 overflow-hidden">
      <transition :name="isMobile ? '' : 'fade'" mode="out-in">
        <router-view class="h-full" />
      </transition>
    </div>
    <Toast :message="toastMessage" :type="toastType" :show="toastShow" @close="toastClose" />
    <IncomingCallModal />
    <CallWindow />
    <CallStatusBar />
  </div>
</template>

<style scoped>
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.15s;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>
