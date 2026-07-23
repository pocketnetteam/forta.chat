import type { TorBridgeType, TorMode, TorNetworkStats, TorRequestFlash, TorStatus } from "./types";
import {
  fromNativeBridgeType,
  resolveBridgeOnEnable,
  shouldAutoEnableSnowflake,
  toNativeBridgeType,
} from "../lib/tor-settings-helpers";
import {
  applyNetworkStatsEvent,
  CURRENT_STATS_RESET_MS,
  REQUEST_FLASH_MS,
  resetCurrentNetworkStats,
  type NetworkStatsEvent,
} from "../lib/network-stats";
import { useLocalStorage } from "@/shared/lib/browser";
import { getElectronAPI, hasTor, isElectron, isNative } from "@/shared/lib/platform";
import { initNetworkStatsListener } from "@/shared/lib/transport/network-stats-listener";
import { defineStore } from "pinia";
import { computed, ref, watch } from "vue";

const NAMESPACE = "tor";

const EMPTY_NETWORK_STATS: TorNetworkStats = {
  directBytes: 0,
  torBytes: 0,
  totalDirectBytes: 0,
  totalTorBytes: 0,
};

const STATUS_POLL_INTERVAL_MS = 2000;

function readAppLocale(): string {
  try {
    return document.documentElement.lang || "";
  } catch {
    return "";
  }
}

export const useTorStore = defineStore(NAMESPACE, () => {
  const { setLSValue: setLSMode, value: lsMode } =
    useLocalStorage<TorMode>("tor_mode", "neveruse");
  const { setLSValue: setLSBridge, value: lsBridge } =
    useLocalStorage<TorBridgeType>("tor_bridge_type", "none");

  const mode = ref<TorMode>(lsMode || "neveruse");
  const bridgeType = ref<TorBridgeType>(lsBridge || "none");
  const status = ref<TorStatus>("stopped");
  const info = ref("");
  const networkStats = ref<TorNetworkStats>({ ...EMPTY_NETWORK_STATS });
  const requestFlash = ref<TorRequestFlash>(null);

  let currentStatsResetTimer: ReturnType<typeof setTimeout> | null = null;
  let requestFlashTimer: ReturnType<typeof setTimeout> | null = null;
  let statusPollTimer: ReturnType<typeof setInterval> | null = null;
  let networkStatsCleanup: (() => void) | null = null;

  // Verification state. `error` is set by TorService.verify() when the
  // platform doesn't ship Tor (iOS) so callers can distinguish "verifier
  // failed" from "no Tor here".
  const verifyResult = ref<{ isTor: boolean; ip: string; error?: string } | null>(null);
  const isVerifying = ref(false);

  const isConnected = computed(() => status.value === "started");
  const isConnecting = computed(
    () => status.value === "running" || status.value === "install",
  );
  const isEnabled = computed(() => mode.value !== "neveruse");
  const isSnowflakeEnabled = computed(() => bridgeType.value === "snowflake");

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

  const hintState = computed((): "off" | "loading" | "on" | "failed" => {
    if (!isEnabled.value) return "off";
    if (status.value === "failed") return "failed";
    if (isConnecting.value || isVerifying.value) return "loading";
    if (isConnected.value) return "on";
    return "loading";
  });

  function mapNativeState(state: string, progress: number): TorStatus {
    switch (state) {
      case "RUNNING":
        return progress >= 100 ? "started" : "running";
      case "STARTING":
        return "running";
      case "STOPPED":
        return "stopped";
      case "FAILED":
        return "failed";
      default:
        return "stopped";
    }
  }

  async function applyNativeConfigure(newMode: TorMode, bridge: TorBridgeType): Promise<void> {
    const { torService } = await import("@/shared/lib/tor");
    await torService.ensureListeners();

    if (newMode === "neveruse") {
      await torService.reconfigure({
        mode: "neveruse",
        bridgeType: toNativeBridgeType(bridge),
      });
      status.value = "stopped";
      info.value = "";
      verifyResult.value = null;
      return;
    }

    status.value = "running";
    info.value = "";
    verifyResult.value = null;
    await torService.reconfigure({
      mode: newMode,
      bridgeType: toNativeBridgeType(bridge),
    });
  }

  async function applyElectronConfigure(newMode: TorMode, bridge: TorBridgeType): Promise<void> {
    const api = getElectronAPI();
    if (!api) return;

    if (api.torConfigure) {
      await api.torConfigure({
        mode: newMode,
        useSnowFlake2: bridge === "snowflake",
      });
    } else {
      await api.torSetMode?.(newMode);
    }
  }

  const setMode = async (newMode: TorMode) => {
    const previousMode = mode.value;
    const resolvedBridge = resolveBridgeOnEnable(
      previousMode,
      newMode,
      bridgeType.value,
      readAppLocale(),
    );

    mode.value = newMode;
    setLSMode(newMode);

    if (resolvedBridge !== bridgeType.value) {
      bridgeType.value = resolvedBridge;
      setLSBridge(resolvedBridge);
    }

    if (isElectron) {
      await applyElectronConfigure(newMode, resolvedBridge);
    } else if (isNative) {
      await applyNativeConfigure(newMode, resolvedBridge);
    }
  };

  const setBridgeType = async (newBridge: TorBridgeType) => {
    bridgeType.value = newBridge;
    setLSBridge(newBridge);

    if (mode.value === "neveruse") return;

    if (isElectron) {
      await applyElectronConfigure(mode.value, newBridge);
    } else if (isNative) {
      await applyNativeConfigure(mode.value, newBridge);
    }
  };

  const toggleSnowflake = async () => {
    await setBridgeType(bridgeType.value === "snowflake" ? "none" : "snowflake");
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
        if (attempt === retries - 1) {
          verifyResult.value = result;
          return;
        }
        await new Promise((r) => setTimeout(r, delayMs));
      }
    } catch {
      verifyResult.value = { isTor: false, ip: "" };
    } finally {
      isVerifying.value = false;
    }
  };

  async function syncFromNative(): Promise<void> {
    if (!isNative) return;
    const { torService } = await import("@/shared/lib/tor");
    const settings = await torService.getSettings();
    mode.value = settings.mode;
    let bridge = fromNativeBridgeType(settings.bridgeType);

    // Migrate users who enabled Tor before Snowflake was persisted correctly:
    // in censored locales, Always/Auto with bridge=none stalls at ~10%.
    // Only update JS state here — initBackground starts the daemon with the
    // resolved bridge (calling reconfigure here would start Tor too early).
    if (
      settings.mode !== "neveruse"
      && bridge === "none"
      && shouldAutoEnableSnowflake(readAppLocale())
    ) {
      bridge = "snowflake";
    }

    bridgeType.value = bridge;
    setLSMode(settings.mode);
    setLSBridge(bridge);
  }

  async function syncFromElectron(): Promise<void> {
    const api = getElectronAPI();
    if (!api?.torGetStatus) return;

    const current = await api.torGetStatus();
    if (!current) return;

    if (current.settingsPersisted && current.mode) {
      mode.value = current.mode;
      setLSMode(current.mode);
      if (typeof current.useSnowFlake2 === "boolean") {
        const bridge: TorBridgeType = current.useSnowFlake2 ? "snowflake" : "none";
        bridgeType.value = bridge;
        setLSBridge(bridge);
      }
    }
  }

  async function pollNativeStatus(): Promise<void> {
    if (!isNative) return;
    try {
      const { registerPlugin } = await import("@capacitor/core");
      const TorNative = registerPlugin<{
        getStatus(): Promise<{ progress: number; state: string }>;
      }>("Tor");
      const nativeStatus = await TorNative.getStatus();
      status.value = mapNativeState(nativeStatus.state, nativeStatus.progress);
      info.value = nativeStatus.progress > 0 && nativeStatus.progress < 100
        ? `Bootstrapped ${nativeStatus.progress}%`
        : "";
    } catch {
      // Polling is best-effort; reactive listeners remain the primary source.
    }
  }

  async function pollElectronStatus(): Promise<void> {
    const api = getElectronAPI();
    if (!api) return;
    try {
      const current = await api.torGetStatus();
      if (current) {
        status.value = current.status;
        info.value = current.info || "";
      }
    } catch {
      // Best-effort polling alongside onTorStatus push events.
    }
  }

  function handleNetworkStats(event: NetworkStatsEvent): void {
    networkStats.value = applyNetworkStatsEvent(networkStats.value, event);

    if (currentStatsResetTimer) clearTimeout(currentStatsResetTimer);
    currentStatsResetTimer = setTimeout(() => {
      networkStats.value = resetCurrentNetworkStats(networkStats.value);
      currentStatsResetTimer = null;
    }, CURRENT_STATS_RESET_MS);

    if (event.torUsed) {
      requestFlash.value = event.status === "success" ? "success" : "failed";
      if (requestFlashTimer) clearTimeout(requestFlashTimer);
      requestFlashTimer = setTimeout(() => {
        requestFlash.value = null;
        requestFlashTimer = null;
      }, REQUEST_FLASH_MS);
    }
  }

  function startStatusPolling(): void {
    if (!hasTor || statusPollTimer) return;

    const poll = () => {
      if (isElectron) {
        void pollElectronStatus();
      } else if (isNative) {
        void pollNativeStatus();
      }
    };

    poll();
    statusPollTimer = setInterval(poll, STATUS_POLL_INTERVAL_MS);
  }

  function startNetworkStatsListener(): void {
    if (!hasTor || networkStatsCleanup) return;
    networkStatsCleanup = initNetworkStatsListener(handleNetworkStats);
  }

  function stopTorMonitoring(): void {
    if (statusPollTimer) {
      clearInterval(statusPollTimer);
      statusPollTimer = null;
    }
    if (currentStatsResetTimer) {
      clearTimeout(currentStatsResetTimer);
      currentStatsResetTimer = null;
    }
    if (requestFlashTimer) {
      clearTimeout(requestFlashTimer);
      requestFlashTimer = null;
    }
    networkStatsCleanup?.();
    networkStatsCleanup = null;
  }

  const init = async () => {
    if (!hasTor) return;

    startNetworkStatsListener();
    startStatusPolling();

    if (isElectron) {
      const api = getElectronAPI();
      if (!api) return;

      api.onTorStatus((data) => {
        status.value = data.status;
        info.value = data.info || "";
      });

      // Prefer main-process persisted settings when present; otherwise migrate LS → main.
      await syncFromElectron();

      if (api.torConfigure) {
        await api.torConfigure({
          mode: mode.value,
          useSnowFlake2: bridgeType.value === "snowflake",
        });
      } else {
        await api.torSetMode?.(mode.value);
      }

      const current = await api.torGetStatus();
      if (current) {
        status.value = current.status;
        info.value = current.info || "";
        if (current.mode) {
          mode.value = current.mode;
          setLSMode(current.mode);
        }
        if (typeof current.useSnowFlake2 === "boolean") {
          const bridge: TorBridgeType = current.useSnowFlake2 ? "snowflake" : "none";
          bridgeType.value = bridge;
          setLSBridge(bridge);
        }
      }
    } else if (isNative) {
      const { torService } = await import("@/shared/lib/tor");

      await syncFromNative();

      watch(
        () => torService.state.value,
        (state) => {
          status.value = mapNativeState(state, torService.progress.value);
        },
        { immediate: true },
      );

      watch(
        () => torService.progress.value,
        (progress) => {
          info.value = progress > 0 && progress < 100
            ? `Bootstrapped ${progress}%`
            : "";
          status.value = mapNativeState(torService.state.value, progress);
        },
        { immediate: true },
      );

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
        { immediate: true },
      );
    }
  };

  return {
    mode,
    bridgeType,
    status,
    info,
    networkStats,
    requestFlash,
    isConnected,
    isConnecting,
    isEnabled,
    isSnowflakeEnabled,
    statusLabel,
    hintState,
    verifyResult,
    isVerifying,
    setMode,
    setBridgeType,
    toggleSnowflake,
    toggle,
    verify,
    init,
    stopTorMonitoring,
  };
});
