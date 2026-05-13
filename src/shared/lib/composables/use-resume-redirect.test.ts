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

const isNativeRef = ref(true);
vi.mock("@/shared/lib/platform", () => ({
  get isNative() {
    return isNativeRef.value;
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

const isAuthenticatedRef = ref(true);
const matrixReadyRef = ref(true);
const registrationPendingRef = ref(false);
vi.mock("@/entities/auth", () => ({
  useAuthStore: () => ({
    get isAuthenticated() {
      return isAuthenticatedRef.value;
    },
    get matrixReady() {
      return matrixReadyRef.value;
    },
    get registrationPending() {
      return registrationPendingRef.value;
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
  isNativeRef.value = true;
  currentRouteName.value = "SettingsPage";
  isAuthenticatedRef.value = true;
  matrixReadyRef.value = true;
  registrationPendingRef.value = false;
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

  it("does NOT register listener on non-native platforms (web/Electron)", async () => {
    isNativeRef.value = false;
    mount(Host);
    await nextTick();

    expect(handlers.length).toBe(0);
  });

  it("does NOT redirect when user is not authenticated", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1_000_000));
    isAuthenticatedRef.value = false;
    mount(Host);
    await nextTick();

    fire(false);
    vi.setSystemTime(new Date(1_000_000 + 70_000));
    fire(true);

    expect(mockReplace).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("does NOT redirect when Matrix is not ready", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1_000_000));
    matrixReadyRef.value = false;
    mount(Host);
    await nextTick();

    fire(false);
    vi.setSystemTime(new Date(1_000_000 + 70_000));
    fire(true);

    expect(mockReplace).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("does NOT redirect while registration is pending", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1_000_000));
    registrationPendingRef.value = true;
    mount(Host);
    await nextTick();

    fire(false);
    vi.setSystemTime(new Date(1_000_000 + 70_000));
    fire(true);

    expect(mockReplace).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});
