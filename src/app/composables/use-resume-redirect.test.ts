import { describe, it, expect, vi, beforeEach } from "vitest";
import { ref, defineComponent, nextTick } from "vue";
import { mount } from "@vue/test-utils";
import { useResumeRedirect } from "./use-resume-redirect";

const handlers: Array<(state: { isActive: boolean }) => void> = [];

vi.mock("@capacitor/app", () => ({
  App: {
    addListener: vi.fn(async (_event: string, cb: (s: { isActive: boolean }) => void) => {
      handlers.push(cb);
      return { remove: vi.fn() };
    }),
  },
}));

const mockReplace = vi.fn();
const currentRouteName = ref<string>("SettingsPage");

vi.mock("vue-router", () => ({
  useRouter: () => ({
    replace: mockReplace,
    currentRoute: {
      value: {
        get name() {
          return currentRouteName.value;
        },
      },
    },
  }),
}));

const isInCallRef = ref(false);
vi.mock("@/entities/call", () => ({
  useCallStore: () => ({
    get isInCall() {
      return isInCallRef.value;
    },
  }),
}));

const Host = defineComponent({
  setup() {
    useResumeRedirect();
    return () => null;
  },
});

beforeEach(() => {
  handlers.length = 0;
  mockReplace.mockClear();
  currentRouteName.value = "SettingsPage";
  isInCallRef.value = false;
});

const fire = (isActive: boolean) => handlers.forEach((h) => h({ isActive }));

describe("useResumeRedirect", () => {
  it("redirects to ChatPage after > 60s background", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1_000_000));
    mount(Host);
    await nextTick();

    fire(false); // pause
    vi.setSystemTime(new Date(1_000_000 + 70_000)); // +70s
    fire(true); // resume

    expect(mockReplace).toHaveBeenCalledWith({ name: "ChatPage" });
    vi.useRealTimers();
  });

  it("does NOT redirect when < 60s passed", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1_000_000));
    mount(Host);
    await nextTick();

    fire(false);
    vi.setSystemTime(new Date(1_000_000 + 30_000));
    fire(true);

    expect(mockReplace).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("does NOT redirect during active call", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1_000_000));
    isInCallRef.value = true;
    mount(Host);
    await nextTick();

    fire(false);
    vi.setSystemTime(new Date(1_000_000 + 70_000));
    fire(true);

    expect(mockReplace).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("does NOT redirect when already on ChatPage", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1_000_000));
    currentRouteName.value = "ChatPage";
    mount(Host);
    await nextTick();

    fire(false);
    vi.setSystemTime(new Date(1_000_000 + 70_000));
    fire(true);

    expect(mockReplace).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});
