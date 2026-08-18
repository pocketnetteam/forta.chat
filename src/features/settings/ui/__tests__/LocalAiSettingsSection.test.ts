import { describe, it, expect, vi, beforeEach } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { reactive } from "vue";
import LocalAiSettingsSection from "../LocalAiSettingsSection.vue";

// Regression: same as AiModelGate.test.ts — an `ensureClient()` failure only
// reached `initError`, never `downloadState.model.error`, and the "Скачать"/
// "Обновить" buttons in Settings → Local AI silently no-op'd on it.
const fakeLocalAiStore = reactive({
  supportReport: { isNative: true, capabilities: { inference: true } } as {
    isNative: boolean;
    capabilities: { inference: boolean };
  } | null,
  eligibilityReport: null as { verdict: "ok" | "tight" | "no" | "unknown" } | null,
  currentModel: null as { displayName: string; quant: string; sizeBytes: number } | null,
  downloadState: { model: { error: null as string | null, progress: null as { percent: number } | null } },
  modelReady: false,
  initError: null as string | null,
  checkSupportOnce: vi.fn(async () => {}),
  checkEligibility: vi.fn(async () => {}),
  refreshManifest: vi.fn(async () => {}),
  restoreModelIfPreviouslyDownloaded: vi.fn(async () => {}),
  downloadModel: vi.fn(async () => {}),
  switchModel: vi.fn(async () => {}),
});

vi.mock("@/entities/local-ai", () => ({
  useLocalAiStore: () => fakeLocalAiStore,
}));

vi.mock("@/entities/auth", () => ({
  useAuthStore: () => ({ address: "addr_a" }),
}));

vi.mock("@/entities/tor", () => ({
  useTorStore: () => ({ mode: "off" }),
}));

// Mirrors GroupCreationPanel.i18n.test.ts's pattern: a real template string
// per key (so `{error}` placeholder substitution is actually exercised),
// not just the raw key echoed back.
const dict: Record<string, string> = {
  "ai.initError": "Failed to prepare the AI engine: {error}",
};

vi.mock("@/shared/lib/i18n", () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, string | number>) => {
      const text = dict[key] ?? key;
      if (!params) return text;
      return Object.entries(params).reduce(
        (acc, [k, v]) => acc.replace(new RegExp(`\\{${k}\\}`, "g"), String(v)),
        text,
      );
    },
  }),
}));

beforeEach(() => {
  fakeLocalAiStore.supportReport = { isNative: true, capabilities: { inference: true } };
  fakeLocalAiStore.eligibilityReport = null;
  fakeLocalAiStore.currentModel = null;
  fakeLocalAiStore.downloadState = { model: { error: null, progress: null } };
  fakeLocalAiStore.modelReady = false;
  fakeLocalAiStore.initError = null;
  vi.clearAllMocks();
});

describe("LocalAiSettingsSection", () => {
  it("renders initError when ensureClient() failed and downloadState.error was never set", async () => {
    fakeLocalAiStore.initError = "Execute: Failed in beginTransaction Already in transaction";

    const wrapper = mount(LocalAiSettingsSection);
    await flushPromises();

    expect(wrapper.text()).toContain("Failed to prepare the AI engine: Execute: Failed in beginTransaction Already in transaction");
  });

  it("prefers downloadState.error over initError when both are set", async () => {
    fakeLocalAiStore.downloadState = { model: { error: "download-specific failure", progress: null } };
    fakeLocalAiStore.initError = "stale init error from an earlier attempt";

    const wrapper = mount(LocalAiSettingsSection);
    await flushPromises();

    expect(wrapper.text()).toContain("download-specific failure");
    expect(wrapper.text()).not.toContain("stale init error from an earlier attempt");
  });
});
