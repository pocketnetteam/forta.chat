import { describe, it, expect, vi, beforeEach } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { reactive } from "vue";
import AiModelGate from "../AiModelGate.vue";

// Regression: an `ensureClient()` failure (e.g. the native SQLite plugin
// rejecting with "CreateConnection: ... already exists") only ever reached
// `localAiStore.initError` — `downloadState.model.error` stayed untouched
// since `downloadModel()`'s own try/catch never runs — and the view's
// `.catch(() => console.warn(...))` swallowed it, so the "Скачать" button
// appeared to just do nothing. The gate must render `initError` too.
const fakeLocalAiStore = reactive({
  supportReport: { isNative: true, capabilities: { inference: true } } as {
    isNative: boolean;
    capabilities: { inference: boolean };
  } | null,
  eligibilityReport: null as { verdict: "ok" | "tight" | "no" | "unknown" } | null,
  downloadState: { model: { error: null as string | null, progress: null as { percent: number } | null } },
  modelReady: false,
  initError: null as string | null,
  checkSupportOnce: vi.fn(async () => {}),
  checkEligibility: vi.fn(async () => {}),
  restoreModelIfPreviouslyDownloaded: vi.fn(async () => {}),
  downloadModel: vi.fn(async () => {}),
});

vi.mock("@/entities/local-ai", () => ({
  useLocalAiStore: () => fakeLocalAiStore,
}));

vi.mock("@/entities/auth", () => ({
  useAuthStore: () => ({ address: "addr_a" }),
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
  fakeLocalAiStore.downloadState = { model: { error: null, progress: null } };
  fakeLocalAiStore.modelReady = false;
  fakeLocalAiStore.initError = null;
  vi.clearAllMocks();
});

describe("AiModelGate", () => {
  it("renders initError when ensureClient() failed and downloadState.error was never set", async () => {
    fakeLocalAiStore.initError = "CreateConnection: Connection local_ai_addr_a already exists";

    const wrapper = mount(AiModelGate);
    await flushPromises();

    expect(wrapper.text()).toContain("Failed to prepare the AI engine: CreateConnection: Connection local_ai_addr_a already exists");
    // The download button must still be present/clickable — this isn't a
    // dead end, the user can retry.
    expect(wrapper.find("button").exists()).toBe(true);
  });

  it("prefers downloadState.error over initError when both are set", async () => {
    fakeLocalAiStore.downloadState = { model: { error: "download-specific failure", progress: null } };
    fakeLocalAiStore.initError = "stale init error from an earlier attempt";

    const wrapper = mount(AiModelGate);
    await flushPromises();

    expect(wrapper.text()).toContain("download-specific failure");
    expect(wrapper.text()).not.toContain("stale init error from an earlier attempt");
  });

  it("renders neither error message when there is no failure", async () => {
    const wrapper = mount(AiModelGate);
    await flushPromises();

    expect(wrapper.find(".text-color-bad").exists()).toBe(false);
  });
});
