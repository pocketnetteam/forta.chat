import type { TorMode, TorStatus } from "./types";
import { useLocalStorage } from "@/shared/lib/browser";
import { isElectron, isNative } from "@/shared/lib/platform";
import { defineStore } from "pinia";
import { computed, ref, watch } from "vue";

const NAMESPACE = "tor";

export const useTorStore = defineStore(NAMESPACE, () => {
  const { setLSValue: setLSMode, value: lsMode } =
    useLocalStorage<TorMode>("tor_mode", "neveruse");

  const mode = ref<TorMode>(lsMode || "neveruse");
  const status = ref<TorStatus>("stopped");
  const info = ref("");

  // Verification state
  const verifyResult = ref<{ isTor: boolean; ip: string } | null>(null);
  const isVerifying = ref(false);

  // --- Computed ---
  const isConnected = computed(() => status.value === "started");
  const isConnecting = computed(
    () => status.value === "running" || status.value === "install"
  );
  const isEnabled = computed(() => mode.value !== "neveruse");
  const statusLabel = computed(() => {
    switch (status.value) {
      case "started":
        return "Connected";
      case "running":
      case "install":
        return "Connecting...";
      case "failed":
        return "Error";
      default:
        return "Off";
    }
  });

  // --- Native helpers ---

  /** Map native TorService state strings to TorStore status */
  function mapNativeState(state: string, progress: number): TorStatus {
    switch (state) {
      case "RUNNING":
        return progress >= 100 ? "started" : "running";
      case "STOPPED":
        return "stopped";
      case "FAILED":
        return "failed";
      default:
        return "stopped";
    }
  }

  // --- Actions ---
  const setMode = async (newMode: TorMode) => {
    mode.value = newMode;
    setLSMode(newMode);

    if (isElectron) {
      (window as any).electronAPI?.torSetMode(newMode);
    } else if (isNative) {
      const { torService } = await import("@/shared/lib/tor");
      if (newMode === "neveruse") {
        await torService.stop();
        status.value = "stopped";
        info.value = "";
        verifyResult.value = null;
      } else {
        // Immediately show connecting state
        status.value = "running";
        info.value = "";
        verifyResult.value = null;
        const nativeMode = newMode === "auto" ? "auto" : "always";
        await torService.init(nativeMode);
      }
    }
  };

  const toggle = async () => {
    await setMode(mode.value === "neveruse" ? "auto" : "neveruse");
  };

  const verify = async (retries = 3, delayMs = 3000) => {
    if (!isNative) return;
    isVerifying.value = true;
    verifyResult.value = null;
    try {
      const { torService } = await import("@/shared/lib/tor");
      for (let attempt = 0; attempt < retries; attempt++) {
        const result = await torService.verify();
        if (result.isTor && result.ip) {
          verifyResult.value = result;
          return;
        }
        // Last attempt — accept whatever we got
        if (attempt === retries - 1) {
          verifyResult.value = result;
          return;
        }
        // Wait before retry (SOCKS may not be ready yet)
        await new Promise((r) => setTimeout(r, delayMs));
      }
    } catch {
      verifyResult.value = { isTor: false, ip: "" };
    } finally {
      isVerifying.value = false;
    }
  };

  const init = async () => {
    if (isElectron) {
      const api = (window as any).electronAPI;
      if (!api) return;

      api.onTorStatus((data: { status: TorStatus; info: string }) => {
        status.value = data.status;
        info.value = data.info || "";
      });

      await api.torSetMode(mode.value);

      const current = await api.torGetStatus();
      if (current) {
        status.value = current.status;
        info.value = current.info || "";
      }
    } else if (isNative) {
      const { torService } = await import("@/shared/lib/tor");

      // Sync reactive state from torService → store
      watch(
        () => torService.state.value,
        (state) => {
          status.value = mapNativeState(state, torService.progress.value);
        },
        { immediate: true }
      );

      watch(
        () => torService.progress.value,
        (progress) => {
          info.value = progress > 0 && progress < 100
            ? `Bootstrapped ${progress}%`
            : "";
          // Re-evaluate status when progress changes
          status.value = mapNativeState(torService.state.value, progress);
        },
        { immediate: true }
      );

      // Auto-verify when Tor becomes connected (delay for SOCKS listener to be ready)
      watch(
        () => status.value,
        (newStatus) => {
          if (newStatus === "started" && !isVerifying.value) {
            setTimeout(() => {
              if (status.value === "started" && !isVerifying.value) {
                verify(3, 5000);
              }
            }, 3000);
          }
        },
        { immediate: true }
      );
    }
  };

  return {
    mode,
    status,
    info,
    isConnected,
    isConnecting,
    isEnabled,
    statusLabel,
    verifyResult,
    isVerifying,
    setMode,
    toggle,
    verify,
    init,
  };
});
