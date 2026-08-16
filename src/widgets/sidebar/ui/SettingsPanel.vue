<script setup lang="ts">
import { useAuthStore } from "@/entities/auth";
import { useThemeStore } from "@/entities/theme";
import { useTorStore } from "@/entities/tor";
import { useUserStore } from "@/entities/user/model";
import { AccountList, AddAccountModal } from "@/features/account-switcher";
import { useWalletStore, formatPkoin } from "@/features/wallet";
import Avatar from "@/shared/ui/avatar/Avatar.vue";
import { Toggle } from "@/shared/ui/toggle";
import {
  isNative,
  isNativePlatform,
  isAndroid,
  hasTor,
  isElectron,
  isWeb,
  resolveAppUpdaterEnabled,
} from "@/shared/lib/platform";
import { AppPages } from "@/app/providers/router";
import { registerPlugin } from "@capacitor/core";
import { App } from "@capacitor/app";
import {
  BugReportModal,
  BugReportStatusSheet,
  useBugReport,
  useBugReportStatus,
} from "@/features/bug-report";
import { getLocalIssueCache } from "@/shared/lib/bug-report";
import { BastyonInteropBanner } from "@/features/bastyon-interop";
import { useSidebarTab } from "../model/use-sidebar-tab";

// App updater Capacitor plugin (Android sideload only; absent on Play builds)
interface AppUpdaterPlugin {
  checkForUpdate(): Promise<void>;
}
const AppUpdaterPlugin = isAndroid ? registerPlugin<AppUpdaterPlugin>("AppUpdater") : null;

const authStore = useAuthStore();
const themeStore = useThemeStore();
const torStore = useTorStore();
const userStore = useUserStore();
const router = useRouter();
const { openSettingsContent } = useSidebarTab();
const walletStore = useWalletStore();

const showTor = hasTor;


const { t } = useI18n();

const torModeLabel = computed(() => {
  switch (torStore.mode) {
    case "auto": return t("tor.modeAuto");
    case "always": return t("tor.modeAlways");
    default: return t("tor.modeNever");
  }
});

// Tor inline status — compact badge in settings list
const torStatusInfo = computed(() => {
  if (!torStore.isEnabled) return null;
  const r = torStore.verifyResult;
  if (torStore.isVerifying) return { text: t("tor.verifying"), color: "text-text-on-main-bg-color", pulse: true, showRefresh: false };
  if (torStore.isConnecting && torStore.info) return { text: torStore.info, color: "text-color-star-yellow", pulse: true, showRefresh: false };
  if (torStore.isConnecting) return { text: t("tor.connecting"), color: "text-color-star-yellow", pulse: true, showRefresh: false };
  if (torStore.status === "failed") return { text: t("tor.error"), color: "text-color-bad", pulse: false, showRefresh: false };
  if (torStore.isConnected && r?.isTor) return { text: r.ip, color: "text-color-good", pulse: false, showRefresh: true };
  if (torStore.isConnected && r && !r.isTor) return { text: t("tor.notUsingTor"), color: "text-color-bad", pulse: false, showRefresh: true };
  // No verify result yet — auto-verify will kick in, show "Verifying..." instead of "Connected"
  if (torStore.isConnected && !r) return { text: t("tor.verifying"), color: "text-text-on-main-bg-color", pulse: true, showRefresh: false };
  return null;
});

// Eagerly load current user's profile for the settings header
watch(
  () => authStore.address,
  (addr) => { if (addr) userStore.loadUserIfMissing(addr); },
  { immediate: true },
);

const currentUser = computed(() =>
  authStore.address ? userStore.getUser(authStore.address) : undefined,
);


// --- App version ---
const appVersion = ref("");
/** Sideload Android only — Play AAB hides the check-updates control. */
const appUpdaterEnabled = ref(false);
onMounted(async () => {
  if (isNative) {
    try {
      const info = await App.getInfo();
      appVersion.value = info.version;
    } catch {
      appVersion.value = "";
    }
  }
  appUpdaterEnabled.value = await resolveAppUpdaterEnabled();
});

// --- Check for updates (Android sideload only) ---
const updateChecking = ref(false);

const handleCheckUpdates = async () => {
  if (!AppUpdaterPlugin || !appUpdaterEnabled.value || updateChecking.value) return;
  updateChecking.value = true;
  try {
    await AppUpdaterPlugin.checkForUpdate();
  } catch (e) {
    console.warn("[settings] Update check failed:", e);
  } finally {
    updateChecking.value = false;
  }
};



const bugReport = useBugReport();
const bugStatus = useBugReportStatus();
const myReportsSheetOpen = ref(false);

// Hide the "My reports" entry if the current account has nothing in the
// local cache — no point in showing an empty sheet to a user who has never
// filed a report from this device.
const hasLocalBugReports = computed(() => {
  if (!authStore.address) return false;
  return getLocalIssueCache(authStore.address).length > 0;
});

const handleOpenMyReports = () => {
  if (!authStore.address) return;
  bugStatus.loadAllIssues(authStore.address);
  myReportsSheetOpen.value = true;
};

const handleCloseMyReports = () => {
  myReportsSheetOpen.value = false;
};
const showAddModal = ref(false);
const showRemoveConfirm = ref(false);
const removeTargetAddress = ref("");

const handleSwitch = (address: string) => {
  if (address !== authStore.activeAddress) {
    authStore.switchAccount(address);
  }
};

const handleRemoveAccount = (address: string) => {
  removeTargetAddress.value = address;
  showRemoveConfirm.value = true;
};

const confirmRemoveAccount = () => {
  showRemoveConfirm.value = false;
  authStore.removeAccount(removeTargetAddress.value);
  removeTargetAddress.value = "";
};

const handleLogout = () => {
  authStore.logout();
  router.push({ name: "WelcomePage" });
};
</script>

<template>
  <div class="flex h-full flex-col">
    <!-- Header -->
    <div
      class="flex h-14 shrink-0 items-center border-b border-neutral-grad-0 px-4"
    >
      <span class="text-base font-semibold text-text-color">{{ t("settings.title") }}</span>
    </div>

    <!-- Scrollable content -->
    <div class="flex-1 overflow-y-auto">
      <!-- Profile header -->
      <div class="flex flex-col items-center px-4 pb-4 pt-6">
        <!-- Skeleton while user data not yet loaded -->
        <template v-if="!currentUser && !authStore.userInfo?.name">
          <div class="h-16 w-16 animate-pulse rounded-full bg-neutral-grad-0" />
          <div class="mt-3 h-5 w-32 animate-pulse rounded bg-neutral-grad-0" />
          <div v-if="authStore.address" class="mt-1.5 h-3 w-48 animate-pulse rounded bg-neutral-grad-0" />
        </template>
        <template v-else>
          <Avatar
            :src="currentUser?.image"
            :name="currentUser?.name || authStore.userInfo?.name || authStore.address || t('settings.anonymous')"
            size="xl"
          />
          <p class="mt-3 text-lg font-semibold text-text-color">
            {{ currentUser?.name || authStore.userInfo?.name || t("settings.anonymous") }}
          </p>
          <p
            v-if="authStore.address"
            class="mt-0.5 break-all text-center text-xs text-text-on-main-bg-color"
          >
            {{ authStore.address }}
          </p>
        </template>
      </div>

      <!-- Dual-install warning (WEE-35) — shown when the account looks
           Bastyon-registered and both apps can coexist on this device. -->
      <BastyonInteropBanner />

      <!-- Multi-account list (shown between profile header and menu items) -->
      <div class="px-2">
        <AccountList
          :show-active="false"
          @switch="handleSwitch"
          @add="showAddModal = true"
          @remove="handleRemoveAccount"
        />
      </div>

      <!-- Menu items -->
      <div class="px-2 pb-4">
        <!-- My Profile -->
        <button
          class="flex w-full items-center gap-3 rounded-lg px-3 py-3 transition-colors hover:bg-neutral-grad-0"
          @click="openSettingsContent('profile')"
        >
          <svg
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            class="shrink-0 text-text-on-main-bg-color"
          >
            <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
            <circle cx="12" cy="7" r="4" />
          </svg>
          <span class="flex-1 text-left text-sm text-text-color">{{ t("settings.myProfile") }}</span>
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            class="shrink-0 text-text-on-main-bg-color"
          >
            <polyline points="9 18 15 12 9 6" />
          </svg>
        </button>

        <!-- Appearance -->
        <button
          class="flex w-full items-center gap-3 rounded-lg px-3 py-3 transition-colors hover:bg-neutral-grad-0"
          @click="openSettingsContent('appearance')"
        >
          <svg
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            class="shrink-0 text-text-on-main-bg-color"
          >
            <circle cx="12" cy="12" r="5" />
            <line x1="12" y1="1" x2="12" y2="3" />
            <line x1="12" y1="21" x2="12" y2="23" />
            <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
            <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
            <line x1="1" y1="12" x2="3" y2="12" />
            <line x1="21" y1="12" x2="23" y2="12" />
            <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
            <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
          </svg>
          <span class="flex-1 text-left text-sm text-text-color">{{ t("settings.appearance") }}</span>
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            class="shrink-0 text-text-on-main-bg-color"
          >
            <polyline points="9 18 15 12 9 6" />
          </svg>
        </button>

        <!-- Call methods (WEE-57) -->
        <button
          class="flex w-full items-center gap-3 rounded-lg px-3 py-3 transition-colors hover:bg-neutral-grad-0"
          @click="openSettingsContent('callMethods')"
        >
          <svg
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            class="shrink-0 text-text-on-main-bg-color"
          >
            <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
            <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
          </svg>
          <span class="flex-1 text-left text-sm text-text-color">{{ t("settings.callProviders.title") }}</span>
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            class="shrink-0 text-text-on-main-bg-color"
          >
            <polyline points="9 18 15 12 9 6" />
          </svg>
        </button>

        <!-- Notifications (WEE-75) -->
        <button
          class="flex w-full items-center gap-3 rounded-lg px-3 py-3 transition-colors hover:bg-neutral-grad-0"
          @click="openSettingsContent('notifications')"
        >
          <svg
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            class="shrink-0 text-text-on-main-bg-color"
          >
            <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
            <path d="M13.73 21a2 2 0 0 1-3.46 0" />
          </svg>
          <span class="flex-1 text-left text-sm text-text-color">{{ t("settings.notifications") }}</span>
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            class="shrink-0 text-text-on-main-bg-color"
          >
            <polyline points="9 18 15 12 9 6" />
          </svg>
        </button>

        <!-- Storage (WEE-33) -->
        <button
          class="flex w-full items-center gap-3 rounded-lg px-3 py-3 transition-colors hover:bg-neutral-grad-0"
          @click="openSettingsContent('storage')"
        >
          <svg
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            class="shrink-0 text-text-on-main-bg-color"
          >
            <ellipse cx="12" cy="5" rx="9" ry="3" />
            <path d="M3 5v6c0 1.66 4 3 9 3s9-1.34 9-3V5" />
            <path d="M3 11v6c0 1.66 4 3 9 3s9-1.34 9-3v-6" />
          </svg>
          <span class="flex-1 text-left text-sm text-text-color">{{ t("settings.storage") }}</span>
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            class="shrink-0 text-text-on-main-bg-color"
          >
            <polyline points="9 18 15 12 9 6" />
          </svg>
        </button>

        <!-- Local AI (roadmap Phase 6) — native-only; live Capacitor check
             (not module-load `isNative` snapshot) so a late androidBridge
             still unlocks the row in-session. -->
        <button
          v-if="isNativePlatform()"
          class="flex w-full items-center gap-3 rounded-lg px-3 py-3 transition-colors hover:bg-neutral-grad-0"
          @click="openSettingsContent('localAi')"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="shrink-0 text-text-on-main-bg-color">
            <path d="M12 8V4H8" />
            <rect width="16" height="12" x="4" y="8" rx="2" />
            <path d="M2 14h2m16 0h2M9 13v2m6-2v2" />
          </svg>
          <span class="flex-1 text-left text-sm text-text-color">{{ t("ai.settingsTitle") }}</span>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="shrink-0 text-text-on-main-bg-color">
            <polyline points="9 18 15 12 9 6" />
          </svg>
        </button>

        <!-- Dark Mode -->
        <div
          class="flex items-center gap-3 rounded-lg px-3 py-3 transition-colors hover:bg-neutral-grad-0"
        >
          <svg
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            class="shrink-0 text-text-on-main-bg-color"
          >
            <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
          </svg>
          <span class="flex-1 text-sm text-text-color">{{ t("settings.darkMode") }}</span>
          <Toggle
            :model-value="themeStore.isDarkMode"
            @update:model-value="themeStore.toggleTheme()"
          />
        </div>

        <!-- Networking / Tor -->
        <button
          v-if="showTor"
          class="flex w-full items-center gap-3 rounded-lg px-3 py-3 transition-colors hover:bg-neutral-grad-0"
          @click="openSettingsContent('networking')"
        >
          <svg
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            class="shrink-0 text-text-on-main-bg-color"
          >
            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
          </svg>
          <span class="text-sm text-text-color">{{ t("tor.networking") }}</span>
          <span
            v-if="torStatusInfo"
            class="flex items-center gap-1 text-xs"
            :class="[torStatusInfo.color, torStatusInfo.pulse ? 'animate-pulse' : '']"
          >
            <span>{{ torStatusInfo.text }}</span>
          </span>
          <span v-else class="text-xs text-text-on-main-bg-color">{{ torModeLabel }}</span>
          <span class="flex-1" />
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            class="shrink-0 text-text-on-main-bg-color"
          >
            <polyline points="9 18 15 12 9 6" />
          </svg>
        </button>

        <!-- Desktop (Electron) -->
        <button
          v-if="isElectron"
          class="flex w-full items-center gap-3 rounded-lg px-3 py-3 transition-colors hover:bg-neutral-grad-0"
          @click="openSettingsContent('desktop')"
        >
          <svg
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            class="shrink-0 text-text-on-main-bg-color"
          >
            <rect x="2" y="3" width="20" height="14" rx="2" />
            <path d="M8 21h8" />
            <path d="M12 17v4" />
          </svg>
          <span class="flex-1 text-left text-sm text-text-color">{{ t("desktopSettings.title") }}</span>
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            class="shrink-0 text-text-on-main-bg-color"
          >
            <polyline points="9 18 15 12 9 6" />
          </svg>
        </button>

        <!-- PKOIN Wallet Balance -->
        <div
          v-if="walletStore.isAvailable"
          class="flex items-center gap-3 rounded-lg px-3 py-3 transition-colors hover:bg-neutral-grad-0 cursor-pointer"
          @click="walletStore.refresh()"
        >
          <svg
            width="20"
            height="20"
            viewBox="0 0 18 18"
            fill="currentColor"
            class="shrink-0 text-text-on-main-bg-color"
          >
            <path fill-rule="evenodd" clip-rule="evenodd" d="M17.2584 1.97869L15.182 0L12.7245 2.57886C11.5308 1.85218 10.1288 1.43362 8.62907 1.43362C7.32722 1.43362 6.09904 1.74902 5.01676 2.30756L2.81787 6.45386e-05L0.741455 1.97875L2.73903 4.07498C1.49651 5.46899 0.741455 7.30694 0.741455 9.32124C0.741455 11.1753 1.38114 12.8799 2.45184 14.2264L0.741455 16.0213L2.81787 18L4.61598 16.1131C5.79166 16.8092 7.1637 17.2088 8.62907 17.2088C10.2903 17.2088 11.8317 16.6953 13.1029 15.8182L15.182 18L17.2584 16.0213L15.1306 13.7884C16.0049 12.5184 16.5167 10.9796 16.5167 9.32124C16.5167 7.50123 15.9003 5.8252 14.8648 4.49052L17.2584 1.97869ZM3.5551 9.32124C3.5551 12.1235 5.82679 14.3952 8.62907 14.3952C11.4313 14.3952 13.703 12.1235 13.703 9.32124C13.703 6.51896 11.4313 4.24727 8.62907 4.24727C5.82679 4.24727 3.5551 6.51896 3.5551 9.32124Z" />
          </svg>
          <span class="flex-1 text-sm text-text-color">{{ t("settings.wallet") }}</span>
          <span
            v-if="walletStore.status === 'loading'"
            class="text-xs text-text-on-main-bg-color animate-pulse"
          >...</span>
          <span
            v-else-if="walletStore.balance !== null"
            class="text-sm font-semibold text-color-bg-ac"
          >{{ formatPkoin(walletStore.balance) }} PKOIN</span>
          <span
            v-else
            class="text-xs text-text-on-main-bg-color"
          >—</span>
        </div>

        <!--
          Auto-update is Android sideload only (not Play AAB): Apple App Store
          and Google Play forbid in-app APK install outside their stores.
          See docs/plans/ios/2026-05-12-ios-simple-tasks.md Task 6.
        -->
        <button
          v-if="appUpdaterEnabled"
          class="flex w-full items-center gap-3 rounded-lg px-3 py-3 transition-colors hover:bg-neutral-grad-0"
          :disabled="updateChecking"
          @click="handleCheckUpdates"
        >
          <svg
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            class="shrink-0 text-text-on-main-bg-color"
          >
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="7 10 12 15 17 10" />
            <line x1="12" y1="15" x2="12" y2="3" />
          </svg>
          <span class="flex-1 text-left text-sm text-text-color">
            {{ updateChecking ? t("settings.checking") : t("settings.checkUpdates") }}
          </span>
          <svg
            v-if="updateChecking"
            class="contain-strict h-4 w-4 shrink-0 animate-spin text-text-on-main-bg-color"
            viewBox="0 0 24 24"
            fill="none"
          >
            <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
            <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
        </button>

        <!-- Download apps (web only) -->
        <button
          v-if="isWeb"
          class="flex w-full items-center gap-3 rounded-lg px-3 py-3 transition-colors hover:bg-neutral-grad-0"
          @click="router.push({ name: AppPages.apps })"
        >
          <svg
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            class="shrink-0 text-text-on-main-bg-color"
          >
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="7 10 12 15 17 10" />
            <line x1="12" y1="15" x2="12" y2="3" />
          </svg>
          <span class="flex-1 text-left text-sm text-text-color">{{ t("settings.downloadApps") }}</span>
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            class="shrink-0 text-text-on-main-bg-color"
          >
            <polyline points="9 18 15 12 9 6" />
          </svg>
        </button>

        <!-- About -->
        <button
          class="flex w-full items-center gap-3 rounded-lg px-3 py-3 transition-colors hover:bg-neutral-grad-0"
          @click="openSettingsContent('about')"
        >
          <svg
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            class="shrink-0 text-text-on-main-bg-color"
          >
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="16" x2="12" y2="12" />
            <line x1="12" y1="8" x2="12.01" y2="8" />
          </svg>
          <span class="flex-1 text-left text-sm text-text-color">{{ t("settings.about") }}</span>
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            class="shrink-0 text-text-on-main-bg-color"
          >
            <polyline points="9 18 15 12 9 6" />
          </svg>
        </button>

        <!-- Bug Report -->
        <button
          class="flex w-full items-center gap-3 rounded-lg px-3 py-3 transition-colors hover:bg-neutral-grad-0"
          @click="bugReport.open()"
        >
          <svg
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            class="shrink-0 text-text-on-main-bg-color"
          >
            <path d="M8 2l1.88 1.88" /><path d="M14.12 3.88L16 2" />
            <path d="M9 7.13v-1a3.003 3.003 0 1 1 6 0v1" />
            <path d="M12 20c-3.3 0-6-2.7-6-6v-3a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v3c0 3.3-2.7 6-6 6" />
            <path d="M12 20v-9" /><path d="M6.53 9C4.6 8.8 3 7.1 3 5" />
            <path d="M6 13H2" /><path d="M3 21c0-2.1 1.7-3.9 3.8-4" />
            <path d="M20.97 5c0 2.1-1.6 3.8-3.5 4" />
            <path d="M22 13h-4" /><path d="M17.2 17c2.1.1 3.8 1.9 3.8 4" />
          </svg>
          <span class="flex-1 text-left text-sm text-text-color">{{ t("settings.bugReport") }}</span>
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            class="shrink-0 text-text-on-main-bg-color"
          >
            <polyline points="9 18 15 12 9 6" />
          </svg>
        </button>

        <!-- My Bug Reports -->
        <button
          v-if="hasLocalBugReports"
          class="flex w-full items-center gap-3 rounded-lg px-3 py-3 transition-colors hover:bg-neutral-grad-0"
          @click="handleOpenMyReports"
        >
          <svg
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            class="shrink-0 text-text-on-main-bg-color"
          >
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <polyline points="14 2 14 8 20 8" />
            <line x1="9" y1="13" x2="15" y2="13" />
            <line x1="9" y1="17" x2="15" y2="17" />
          </svg>
          <span class="flex-1 text-left text-sm text-text-color">{{ t("settings.myBugReports") }}</span>
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            class="shrink-0 text-text-on-main-bg-color"
          >
            <polyline points="9 18 15 12 9 6" />
          </svg>
        </button>

        <!-- Divider -->
        <div class="my-1 border-t border-neutral-grad-0" />

        <!-- App version -->
        <div
          v-if="appVersion"
          class="px-3 py-2 text-center text-xs text-text-on-main-bg-color opacity-60"
        >
          Forta Chat v{{ appVersion }}
        </div>

        <!-- Logout -->
        <button
          class="flex w-full items-center gap-3 rounded-lg px-3 py-3 text-color-bad transition-colors hover:bg-neutral-grad-0"
          @click="handleLogout"
        >
          <svg
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            class="shrink-0"
          >
            <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
            <polyline points="16 17 21 12 16 7" />
            <line x1="21" y1="12" x2="9" y2="12" />
          </svg>
          <span class="flex-1 text-left text-sm">{{ t("settings.logout") }}</span>
        </button>
      </div>
    </div>

    <AddAccountModal
      :show="showAddModal"
      @close="showAddModal = false"
    />

    <BugReportModal />

    <BugReportStatusSheet
      v-if="authStore.address"
      :show="myReportsSheetOpen"
      :address="authStore.address"
      mode="manage"
      @close="handleCloseMyReports"
    />

    <!-- Remove account confirmation dialog -->
    <Teleport to="body">
      <div
        v-if="showRemoveConfirm"
        class="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
        @click.self="showRemoveConfirm = false"
      >
        <div class="mx-4 max-w-sm rounded-xl bg-background-secondary-theme p-6 shadow-xl">
          <p class="mb-4 text-sm text-text-color">
            {{ t('settings.removeAccountConfirm') }}
          </p>
          <div class="flex justify-end gap-3">
            <button
              class="rounded-lg px-4 py-2 text-sm text-text-on-main-bg-color transition-colors hover:bg-neutral-grad-0"
              @click="showRemoveConfirm = false"
            >
              {{ t('common.cancel') }}
            </button>
            <button
              class="rounded-lg bg-color-bad px-4 py-2 text-sm font-medium text-white transition-opacity hover:opacity-80"
              @click="confirmRemoveAccount()"
            >
              {{ t('settings.removeAccount') }}
            </button>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>
