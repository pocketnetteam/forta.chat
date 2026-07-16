import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mount } from "@vue/test-utils";
import { defineComponent, h, ref } from "vue";

let currentDict: Record<string, string> = {};
const isMobileRef = ref(true);

vi.mock("@/shared/lib/i18n", () => ({
  useI18n: () => ({
    t: (key: string) => currentDict[key] ?? key,
    locale: { value: "ru" },
  }),
}));

vi.mock("@/shared/lib/composables/use-media-query", () => ({
  useMobile: () => isMobileRef,
  useTablet: () => ref(false),
  useDesktop: () => ref(false),
}));

// BottomSheet is auto-registered globally; stub it so the test renders
// inline (instead of via teleport) and so aria-label propagates to a
// container we can query.
vi.mock("@/shared/ui/bottom-sheet", () => ({
  BottomSheet: defineComponent({
    name: "BottomSheet",
    props: ["show", "ariaLabel"],
    setup(props, { slots, attrs }) {
      return () =>
        props.show
          ? h(
              "div",
              {
                class: "mock-bottom-sheet",
                "aria-label": (attrs["aria-label"] as string) ?? props.ariaLabel,
              },
              slots.default?.(),
            )
          : null;
    },
  }),
}));

const RU = {
  "attachment.panelLabel": "Вложения",
  "attachment.photoOrVideo": "Фото или видео",
  "attachment.file": "Файл",
  "attachment.poll": "Опрос",
};

const EN = {
  "attachment.panelLabel": "Attachments",
  "attachment.photoOrVideo": "Photo or Video",
  "attachment.file": "File",
  "attachment.poll": "Poll",
};

let AttachmentPanel: typeof import("../AttachmentPanel.vue").default;

describe("AttachmentPanel i18n — mobile BottomSheet (WEE-30)", () => {
  beforeEach(async () => {
    currentDict = RU;
    isMobileRef.value = true;
    AttachmentPanel = (await import("../AttachmentPanel.vue")).default;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders Russian item labels when show=true (ru locale)", () => {
    const w = mount(AttachmentPanel, {
      props: { show: true, x: 100, y: 100, showDonate: false },
    });
    const text = w.text();
    expect(text).toContain("Фото или видео");
    expect(text).toContain("Файл");
    expect(text).toContain("Опрос");
  });

  it("does not leak hardcoded English item labels in ru locale", () => {
    const w = mount(AttachmentPanel, {
      props: { show: true, x: 100, y: 100, showDonate: false },
    });
    const text = w.text();
    expect(text).not.toMatch(/\bPhoto or Video\b/);
    expect(text).not.toMatch(/\bPoll\b/);
  });

  it("uses translated aria-label for the bottom sheet", () => {
    const w = mount(AttachmentPanel, {
      props: { show: true, x: 100, y: 100, showDonate: false },
    });
    const sheet = w.find(".mock-bottom-sheet");
    expect(sheet.exists()).toBe(true);
    expect(sheet.attributes("aria-label")).toBe("Вложения");
  });

  it("falls back to English dictionary keys when locale is en", () => {
    currentDict = EN;
    const w = mount(AttachmentPanel, {
      props: { show: true, x: 100, y: 100, showDonate: false },
    });
    const text = w.text();
    expect(text).toContain("Photo or Video");
    expect(text).toContain("File");
    expect(text).toContain("Poll");
  });
});

describe("AttachmentPanel i18n — desktop dropdown (WEE-30)", () => {
  beforeEach(async () => {
    currentDict = RU;
    isMobileRef.value = false;
    AttachmentPanel = (await import("../AttachmentPanel.vue")).default;
  });

  afterEach(() => {
    // Clean up any teleported nodes from the body between tests.
    document.body.querySelectorAll('[role="menu"]').forEach((n) => n.remove());
    isMobileRef.value = true;
  });

  it("renders translated labels and aria-label on the desktop dropdown", () => {
    const w = mount(AttachmentPanel, {
      props: { show: true, x: 100, y: 100, showDonate: false },
      attachTo: document.body,
    });
    const menu = document.querySelector('[role="menu"]');
    expect(menu).not.toBeNull();
    expect(menu?.getAttribute("aria-label")).toBe("Вложения");
    const text = menu?.textContent ?? "";
    expect(text).toContain("Фото или видео");
    expect(text).toContain("Файл");
    expect(text).toContain("Опрос");
    expect(text).not.toMatch(/\bPhoto or Video\b/);
    expect(text).not.toMatch(/\bPoll\b/);
    w.unmount();
  });
});
