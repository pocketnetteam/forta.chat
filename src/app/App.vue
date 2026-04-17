<script setup lang="ts">
import { migrateAll } from "@/entities/auth/model/storage-migration";
import { useAuthStore } from "@/entities/auth";
import { useChatStore } from "@/entities/chat";

// Run storage migration before any store initialization
migrateAll();
import { useUserStore } from "@/entities/user/model";
import { useContacts } from "@/features/contacts";
import { useToast } from "@/shared/lib/use-toast";
import Toast from "@/shared/ui/toast/Toast.vue";
import TitleBar from "@/widgets/title-bar/TitleBar.vue";
import IncomingCallModal from "@/features/video-calls/ui/IncomingCallModal.vue";
import CallWindow from "@/features/video-calls/ui/CallWindow.vue";
import CallStatusBar from "@/features/video-calls/ui/CallStatusBar.vue";
import QuickSearchModal from "@/features/search/ui/QuickSearchModal.vue";
import { handleSdkSync } from "@/features/sync-status";
import { isNative } from "@/shared/lib/platform";
import { useRouter } from "vue-router";
import { initAndroidBackListener, useAndroidBackHandler } from "@/shared/lib/composables/use-android-back-handler";
import { initShareTargetListener, consumeShareData, saveShareData, type ExternalShareData } from "@/shared/lib/share-target";
import RegistrationStepper from "@/features/auth/ui/RegistrationStepper.vue";
import { AppDownloadBanner } from "@/features/app-download-banner";
import {
  BugReportStatusSheet,
  useBugReportStatus,
  shouldCheckOnBoot,
  markBootCheckCompleted,
} from "@/features/bug-report";
import { useI18n } from "@/shared/lib/i18n";

import { useKeyboardFallback } from "@/shared/lib/composables/use-keyboard-fallback";
import { AppPages, AppRoutes, EAppProviders } from "./providers";

const isElectron = !!(window as any).electronAPI?.isElectron;
const { t } = useI18n();

const { message: toastMessage, type: toastType, show: toastShow, close: toastClose } = useToast();

provide(EAppProviders.AppRoutes, AppRoutes);
provide(EAppProviders.AppPages, AppPages);

const authStore = useAuthStore();
authStore.setSyncStatusCallback(handleSdkSync);
const chatStore = useChatStore();
const router = useRouter();

const retryError = ref("");

const registrationErrorType = computed<'username' | 'timeout' | 'network' | null>(() => {
  if (authStore.registrationUsernameError) return 'username';
  if (authStore.registrationErrorMessage === 'timeout') return 'timeout';
  if (authStore.registrationErrorMessage === 'network') return 'network';
  return null;
});

const handleRetryRegistration = () => {
  retryError.value = "";
  authStore.retryRegistration();
};

const handleRetryUsername = async (newName: string) => {
  const trimmed = newName.trim();
  if (!trimmed) return;
  retryError.value = "";
  try {
    const owner = await authStore.checkUsername(trimmed);
    if (owner) {
      retryError.value = t("register.nameTaken");
      return;
    }
    await authStore.retryRegistrationWithNewName(trimmed);
  } catch (e) {
    retryError.value = e instanceof Error ? e.message : t("register.registrationFailed");
    console.error("[App] retry username failed:", e);
  }
};

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
    // Eagerly load inviter's profile so name/avatar appear immediately in chat list
    useUserStore().loadUserIfMissing(ref);

    const { getOrCreateRoom } = useContacts();
    const roomId = await getOrCreateRoom(ref);
    if (roomId) {
      router.push({ name: "ChatPage" });
    }
  } catch (e) {
    console.error("[App] referral processing error:", e);
  }
};

// Handle push notification tap → navigate to specific chat room
const processPushOpenRoom = (roomId: string) => {
  if (!authStore.isAuthenticated || !authStore.matrixReady) {
    // Defer until Matrix is ready
    localStorage.setItem("bastyon-chat-push-room", roomId);
    return;
  }
  // Kick Matrix sync immediately — WebView may have been suspended in background
  import("@/entities/matrix").then(({ getMatrixClientService }) => {
    getMatrixClientService().client?.retryImmediately();
  }).catch(() => {});

  // Wait for rooms to load before navigating (on cold-start, sync may not have finished)
  if (chatStore.roomsInitialized) {
    chatStore.setActiveRoom(roomId);
    router.push({ name: "ChatPage" });
  } else {
    const unwatch = watch(
      () => chatStore.roomsInitialized,
      (ready) => {
        if (ready) {
          unwatch();
          chatStore.setActiveRoom(roomId);
          router.push({ name: "ChatPage" });
        }
      },
      { immediate: true },
    );
  }
};

const processPendingPushRoom = () => {
  const roomId = localStorage.getItem("bastyon-chat-push-room");
  if (!roomId) return;
  localStorage.removeItem("bastyon-chat-push-room");
  if (!authStore.isAuthenticated || !authStore.matrixReady) return;
  processPushOpenRoom(roomId);
};

const processExternalShare = (data?: ExternalShareData) => {
  const shareData = data || consumeShareData();
  if (!shareData) return;

  if (!authStore.isAuthenticated || !authStore.matrixReady) {
    saveShareData(shareData);
    return;
  }

  if (!chatStore.roomsInitialized) {
    const unwatch = watch(
      () => chatStore.roomsInitialized,
      (ready) => {
        if (ready) {
          unwatch();
          chatStore.initExternalShare(shareData);
          router.push({ name: "ChatPage" });
        }
      },
      { immediate: true },
    );
    return;
  }

  chatStore.initExternalShare(shareData);
  router.push({ name: "ChatPage" });
};

if (isNative) {
  window.addEventListener('push:openRoom', ((e: CustomEvent) => {
    const roomId = e.detail?.roomId;
    if (roomId) processPushOpenRoom(roomId);
  }) as EventListener);
}

// Watch for Matrix becoming ready (e.g., after registration poll completes)
watch(
  () => authStore.matrixReady,
  (ready) => {
    if (ready) {
      if (localStorage.getItem("bastyon-chat-referral")) processReferral();
      if (localStorage.getItem("bastyon-chat-join-room")) processJoinRoom();
      processPendingPushRoom();
      const pendingShare = consumeShareData();
      if (pendingShare) processExternalShare(pendingShare);
    }
  },
);

const isMobile = ref(window.innerWidth < 768);
const onResize = () => { isMobile.value = window.innerWidth < 768; };

// ─── Bug-report sheet: auto-open from local cache on version change / 3-day idle ───
const {
  allIssues: bugStatusIssues,
  sheetOpen: bugStatusSheetOpen,
  loadAllIssues: loadBugIssues,
  openSheet: openBugStatusSheet,
  closeSheet: closeBugStatusSheet,
  resetState: resetBugStatus,
} = useBugReportStatus();

let pendingBugCheckVersion: string | null = null;

async function runBugStatusCheck() {
  if (!authStore.address) return;
  let version = "web";
  if (isNative) {
    try {
      const { App } = await import("@capacitor/app");
      const info = await App.getInfo();
      version = info.version ?? "native";
    } catch {
      version = "native";
    }
  } else if ((window as any).electronAPI?.getVersion) {
    try {
      version = await (window as any).electronAPI.getVersion();
    } catch {
      version = "electron";
    }
  }
  if (!shouldCheckOnBoot(version)) return;
  loadBugIssues(authStore.address);
  if (bugStatusIssues.value.length > 0) {
    pendingBugCheckVersion = version;
    openBugStatusSheet();
  } else {
    markBootCheckCompleted(version);
  }
}

function handleBugStatusSheetClose() {
  closeBugStatusSheet();
  if (pendingBugCheckVersion) {
    markBootCheckCompleted(pendingBugCheckVersion);
    pendingBugCheckVersion = null;
  }
}

let bugStatusCheckTriggered = false;
watch(
  () => authStore.address,
  (addr) => {
    if (addr && !bugStatusCheckTriggered) {
      bugStatusCheckTriggered = true;
      runBugStatusCheck().catch((e) =>
        console.warn("[App] bug status check failed:", e),
      );
    }
  },
  { immediate: true },
);

// Reset on logout so another account on the same tab starts clean.
watch(
  () => authStore.isAuthenticated,
  (isAuthed, was) => {
    if (was && !isAuthed) resetBugStatus();
  },
);

const showQuickSearch = ref(false);

// Android back: close quick search
useAndroidBackHandler("quick-search", 95, () => {
  if (!showQuickSearch.value) return false;
  showQuickSearch.value = false;
  return true;
});

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

  // Initialize Android hardware back button handler
  initAndroidBackListener();

  // Android keyboard: auto-scroll to focused input + inset cross-check
  useKeyboardFallback();

  // Initialize Android Share Target listener
  initShareTargetListener((data) => processExternalShare(data));

  // Mark Electron mode on <html> for CSS adjustments (drag regions, traffic light padding)
  if ((window as any).electronAPI?.isElectron) {
    document.documentElement.classList.add("is-electron");
    if ((window as any).electronAPI?.platform === "darwin") {
      document.documentElement.classList.add("is-electron-mac");
    }
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
  <div class="safe-top fixed inset-0 flex flex-col overflow-hidden bg-background-total-theme text-text-color">
    <AppDownloadBanner />
    <!-- Registration stepper overlay — shows progress during blockchain registration -->
    <RegistrationStepper
      v-if="authStore.registrationPending || authStore.registrationPhase === 'done' || authStore.registrationUsernameError || authStore.registrationErrorMessage"
      :phase="authStore.registrationPhase"
      :error-message="retryError"
      :error-type="registrationErrorType"
      @back-to-name="handleRetryUsername"
      @retry="handleRetryRegistration"
    />
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
    <QuickSearchModal
      v-if="showQuickSearch"
      @close="showQuickSearch = false"
      @select-room="showQuickSearch = false"
    />
    <BugReportStatusSheet
      v-if="authStore.address"
      :show="bugStatusSheetOpen"
      :address="authStore.address"
      mode="manage"
      @close="handleBugStatusSheetClose"
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
