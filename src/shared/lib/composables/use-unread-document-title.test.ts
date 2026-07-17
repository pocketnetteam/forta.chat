import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ref, defineComponent, nextTick } from "vue";
import { mount } from "@vue/test-utils";
import { useUnreadDocumentTitle } from "./use-unread-document-title";

const totalUnreadRef = ref(0);

vi.mock("@/entities/chat", () => ({
  useChatStore: () => ({
    get totalUnread() {
      return totalUnreadRef.value;
    },
  }),
}));

vi.mock("@/shared/lib/i18n", () => ({
  tRaw: (key: string) => (key === "titleBar.appName" ? "Forta Chat" : key),
}));

const Host = defineComponent({
  setup() {
    useUnreadDocumentTitle();
    return () => null;
  },
});

describe("useUnreadDocumentTitle", () => {
  const prevTitle = document.title;

  beforeEach(() => {
    totalUnreadRef.value = 0;
    document.title = "Forta Chat";
  });

  afterEach(() => {
    document.title = prevTitle;
  });

  it("sets bare app name immediately when unread is 0", () => {
    mount(Host);
    expect(document.title).toBe("Forta Chat");
  });

  it("prefixes title when totalUnread becomes positive", async () => {
    mount(Host);
    totalUnreadRef.value = 5;
    await nextTick();
    expect(document.title).toBe("(5) Forta Chat");
  });

  it("clears the prefix when unread returns to 0", async () => {
    totalUnreadRef.value = 3;
    mount(Host);
    expect(document.title).toBe("(3) Forta Chat");

    totalUnreadRef.value = 0;
    await nextTick();
    expect(document.title).toBe("Forta Chat");
  });

  it("caps at 99+", async () => {
    mount(Host);
    totalUnreadRef.value = 120;
    await nextTick();
    expect(document.title).toBe("(99+) Forta Chat");
  });
});
