<script setup lang="ts">
import { useAuthStore } from "@/entities/auth";
import { useThemeStore } from "@/entities/theme";
import { useTorStore } from "@/entities/tor";
import { useUserStore } from "@/entities/user/model";
import { AccountList, AddAccountModal } from "@/features/account-switcher";
import { useWallet } from "@/features/wallet/model/use-wallet";
import Avatar from "@/shared/ui/avatar/Avatar.vue";
import { Toggle } from "@/shared/ui/toggle";
import { isNative, isAndroid } from "@/shared/lib/platform";
import { registerPlugin } from "@capacitor/core";
import { App } from "@capacitor/app";
import { useSidebarTab } from "../model/use-sidebar-tab";

// App updater Capacitor plugin (Android only)
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
const { isAvailable: walletAvailable, getBalance } = useWallet();

const isElectron = !!(window as any).electronAPI?.isElectron;
const showTor = isElectron || isNative;
const showDisableWarning = ref(false);

// --- Wallet balance ---
const pkoinBalance = ref<number | null>(null);
const balanceLoading = ref(false);

const loadBalance = async () => {
  if (!walletAvailable.value || balanceLoading.value) return;
  balanceLoading.value = true;
  try {
    pkoinBalance.value = await getBalance();
  } catch (e) {
    console.warn("[settings] Failed to load balance:", e);
    pkoinBalance.value = null;
  } finally {
    balanceLoading.value = false;
  }
};

// Load balance when wallet becomes available
watch(walletAvailable, (v) => { if (v) loadBalance(); }, { immediate: true });

const { t } = useI18n();

// Tor inline status — shows as a compact badge next to the label
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


const handleTorToggle = () => {
  if (torStore.isEnabled) {
    showDisableWarning.value = true;
  } else {
    torStore.toggle();
  }
};

const confirmDisableTor = () => {
  showDisableWarning.value = false;
  torStore.toggle();
};

// --- App version ---
const appVersion = ref("");
onMounted(async () => {
  if (isNative) {
    try {
      const info = await App.getInfo();
      appVersion.value = info.version;
    } catch {
      appVersion.value = "";
    }
  }
});

// --- Check for updates (Android only) ---
const updateChecking = ref(false);

const handleCheckUpdates = async () => {
  if (!AppUpdaterPlugin || updateChecking.value) return;
  updateChecking.value = true;
  try {
    await AppUpdaterPlugin.checkForUpdate();
  } catch (e) {
    console.warn("[settings] Update check failed:", e);
  } finally {
    updateChecking.value = false;
  }
};

const showAddModal = ref(false);

const handleSwitch = (address: string) => {
  if (address !== authStore.activeAddress) {
    authStore.switchAccount(address);
  }
};

const handleRemoveAccount = (address: string) => {
  if (confirm(t("settings.removeAccountConfirm"))) {
    authStore.removeAccount(address);
  }
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
        <Avatar
          :src="currentUser?.image"
          :name="currentUser?.name || authStore.address || t('settings.anonymous')"
          size="xl"
        />
        <p class="mt-3 text-lg font-semibold text-text-color">
          {{ authStore.userInfo?.name || t("settings.anonymous") }}
        </p>
        <p
          v-if="authStore.address"
          class="mt-0.5 break-all text-center text-xs text-text-on-main-bg-color"
        >
          {{ authStore.address }}
        </p>
      </div>

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

        <!-- Tor Proxy -->
        <div
          v-if="showTor"
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
            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
          </svg>
          <span class="text-sm text-text-color">{{ t("settings.torProxy") }}</span>
          <!-- Inline status badge -->
          <span
            v-if="torStatusInfo"
            class="flex items-center gap-1 text-xs"
            :class="[torStatusInfo.color, torStatusInfo.pulse ? 'animate-pulse' : '']"
          >
            <span>{{ torStatusInfo.text }}</span>
            <!-- Small refresh icon right after text -->
            <button
              v-if="torStatusInfo.showRefresh"
              class="inline-flex p-0.5 opacity-50 transition-opacity hover:opacity-100"
              @click.stop="torStore.verify()"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                <path d="M23 4v6h-6" /><path d="M1 20v-6h6" />
                <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
              </svg>
            </button>
          </span>
          <span class="flex-1" />
          <Toggle
            :model-value="torStore.isEnabled"
            @update:model-value="handleTorToggle()"
          />
        </div>

        <!-- PKOIN Wallet Balance -->
        <div
          v-if="walletAvailable"
          class="flex items-center gap-3 rounded-lg px-3 py-3 transition-colors hover:bg-neutral-grad-0 cursor-pointer"
          @click="loadBalance"
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
            v-if="balanceLoading"
            class="text-xs text-text-on-main-bg-color animate-pulse"
          >...</span>
          <span
            v-else-if="pkoinBalance !== null"
            class="text-sm font-semibold text-color-bg-ac"
          >{{ pkoinBalance.toFixed(4) }} PKOIN</span>
          <span
            v-else
            class="text-xs text-text-on-main-bg-color"
          >—</span>
        </div>

        <!-- Check for updates (Android only) -->
        <button
          v-if="isAndroid"
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
            class="h-4 w-4 shrink-0 animate-spin text-text-on-main-bg-color"
            viewBox="0 0 24 24"
            fill="none"
          >
            <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
            <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
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

    <!-- Tor disable warning dialog -->
    <Teleport to="body">
      <div
        v-if="showDisableWarning"
        class="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
        @click.self="showDisableWarning = false"
      >
        <div class="mx-4 max-w-sm rounded-xl bg-background-secondary-theme p-6 shadow-xl">
          <p class="mb-4 text-sm text-text-color">
            {{ t('tor.disableWarning') }}
          </p>
          <div class="flex justify-end gap-3">
            <button
              class="rounded-lg px-4 py-2 text-sm text-text-on-main-bg-color transition-colors hover:bg-neutral-grad-0"
              @click="showDisableWarning = false"
            >
              {{ t('common.cancel') }}
            </button>
            <button
              class="rounded-lg bg-color-bad px-4 py-2 text-sm font-medium text-white transition-opacity hover:opacity-80"
              @click="confirmDisableTor()"
            >
              {{ t('settings.torProxy') }} Off
            </button>
          </div>
        </div>
      </div>
    </Teleport>

    <AddAccountModal
      :show="showAddModal"
      @close="showAddModal = false"
    />
  </div>
</template>
