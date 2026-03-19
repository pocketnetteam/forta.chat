<script setup lang="ts">
import { useAuthStore } from "@/entities/auth";
import { useChatStore } from "@/entities/chat";
import { useContacts } from "@/features/contacts";
import { useToast } from "@/shared/lib/use-toast";
import Toast from "@/shared/ui/toast/Toast.vue";
import TitleBar from "@/widgets/title-bar/TitleBar.vue";
import IncomingCallModal from "@/features/video-calls/ui/IncomingCallModal.vue";
import CallWindow from "@/features/video-calls/ui/CallWindow.vue";
import CallStatusBar from "@/features/video-calls/ui/CallStatusBar.vue";
import QuickSearchModal from "@/features/search/ui/QuickSearchModal.vue";
import { SyncBanner } from "@/features/sync-status";
import { useRouter } from "vue-router";

import { AppPages, AppRoutes, EAppProviders } from "./providers";

const isElectron = !!(window as any).electronAPI?.isElectron;

const { message: toastMessage, type: toastType, show: toastShow, close: toastClose } = useToast();

provide(EAppProviders.AppRoutes, AppRoutes);
provide(EAppProviders.AppPages, AppPages);

const authStore = useAuthStore();
const chatStore = useChatStore();
const router = useRouter();

const processJoinRoom = async () => {
  if (!authStore.isAuthenticated || !authStore.matrixReady) return;

  const roomId = localStorage.getItem("bastyon-chat-join-room");
  if (!roomId) return;

  localStorage.removeItem("bastyon-chat-join-room");

  try {
    const ok = await chatStore.joinRoomById(roomId);
    if (ok) {
      router.push({ name: "ChatPage" });
    }
  } catch (e) {
    console.error("[App] join room error:", e);
  }
};

const processReferral = async () => {
  if (!authStore.isAuthenticated || !authStore.matrixReady) return;

  const ref = localStorage.getItem("bastyon-chat-referral");
  if (!ref) return;

  // Remove immediately to prevent duplicate processing
  localStorage.removeItem("bastyon-chat-referral");

  // Don't create chat with yourself
  if (ref === authStore.address) return;

  try {
    const { getOrCreateRoom } = useContacts();
    const roomId = await getOrCreateRoom(ref);
    if (roomId) {
      router.push({ name: "ChatPage" });
    }
  } catch (e) {
    console.error("[App] referral processing error:", e);
  }
};

// Watch for Matrix becoming ready (e.g., after registration poll completes)
watch(
  () => authStore.matrixReady,
  (ready) => {
    if (ready) {
      if (localStorage.getItem("bastyon-chat-referral")) processReferral();
      if (localStorage.getItem("bastyon-chat-join-room")) processJoinRoom();
    }
  },
);

const isMobile = ref(window.innerWidth < 768);
const onResize = () => { isMobile.value = window.innerWidth < 768; };

const showQuickSearch = ref(false);

const handleGlobalKeydown = (e: KeyboardEvent) => {
  if ((e.metaKey || e.ctrlKey) && e.key === "k") {
    e.preventDefault();
    showQuickSearch.value = !showQuickSearch.value;
  }
  if (e.key === "Escape" && showQuickSearch.value) {
    showQuickSearch.value = false;
  }
};

onMounted(async () => {
  window.addEventListener("resize", onResize);
  window.addEventListener("keydown", handleGlobalKeydown);

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

  // If registration is still pending from a previous session, resume polling
  if (authStore.isAuthenticated && authStore.registrationPending) {
    authStore.resumeRegistrationPoll();
  } else if (authStore.isAuthenticated && !authStore.matrixReady) {
    // Initialize Matrix on reload if already logged in
    await authStore.initMatrix();
  }

  // Process referral / join links after Matrix is ready
  await processReferral();
  await processJoinRoom();
});

onUnmounted(() => {
  window.removeEventListener("resize", onResize);
  window.removeEventListener("keydown", handleGlobalKeydown);
});
</script>

<template>
  <div class="relative flex flex-col bg-background-total-theme text-text-color" style="height: 100vh; height: 100dvh; padding-top: env(safe-area-inset-top, 0px)">
    <TitleBar v-if="isElectron" />
    <SyncBanner />
    <div class="relative min-h-0 flex-1 overflow-hidden">
      <transition :name="isMobile ? '' : 'fade'" mode="out-in">
        <router-view class="h-full" />
      </transition>
    </div>
    <Toast :message="toastMessage" :type="toastType" :show="toastShow" @close="toastClose" />
    <IncomingCallModal />
    <CallWindow />
    <CallStatusBar />
    <QuickSearchModal
      v-if="showQuickSearch"
      @close="showQuickSearch = false"
      @select-room="showQuickSearch = false"
    />
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
