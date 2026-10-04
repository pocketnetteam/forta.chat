// @vitest-environment happy-dom
import { describe, it, expect, vi } from "vitest";
import { mount } from "@vue/test-utils";

// The Emoji Kitchen dataset (~2.5 MB parsed) must not load on import:
// EmojiPicker sits in the startup graph, so an eager load parsed it on every
// cold start. It loads when the kitchen bar mounts.

const dataFactory = vi.hoisted(() => vi.fn());

vi.mock("@/shared/lib/emoji-kitchen-data.json", () => {
  dataFactory();
  return { default: { "2615": [["1f600", "2615", "20201001"]] } };
});

describe("Emoji Kitchen dataset loading", () => {
  it("does not load the dataset when the module is imported", async () => {
    await import("@/shared/lib/emoji-kitchen");
    await vi.dynamicImportSettled();

    expect(dataFactory).not.toHaveBeenCalled();
  });

  it("loads on bar mount and shows combos for an emoji picked before the data arrived", async () => {
    const { default: EmojiKitchenBar } = await import("../EmojiKitchenBar.vue");

    const wrapper = mount(EmojiKitchenBar, { props: { selectedEmoji: "☕" } });
    await vi.waitFor(() => expect(wrapper.findAll("img")).toHaveLength(1), { timeout: 5000 });

    expect(dataFactory).toHaveBeenCalledTimes(1);
    const imgs = wrapper.findAll("img");
    expect(imgs).toHaveLength(1);
    expect(imgs[0].attributes("src")).toBe(
      "https://www.gstatic.com/android/keyboard/emojikitchen/20201001/u1f600/u1f600_u2615.png",
    );
  });
});
