import { describe, it, expect, vi, beforeEach } from "vitest";
import { mount } from "@vue/test-utils";
import { setActivePinia, createPinia } from "pinia";
import ReactionPicker from "../ReactionPicker.vue";

vi.stubGlobal("useI18n", () => ({ t: (k: string) => k }));

vi.mock("@/entities/theme", () => ({
  useThemeStore: () => ({
    quickReactions: ["👍", "❤️", "😂", "😮", "😢", "🙏"],
    animationsEnabled: true,
  }),
}));

describe("ReactionPicker", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.stubGlobal("useI18n", () => ({ t: (k: string) => k }));
  });

  it("emits select with the emoji on click", async () => {
    const wrapper = mount(ReactionPicker);

    const firstButton = wrapper.findAll("button")[0];
    await firstButton.trigger("click");

    const selectEvents = wrapper.emitted("select");
    expect(selectEvents).toBeTruthy();
    expect(selectEvents![0]).toEqual(["👍"]);
  });

  it("ignores rapid double-click on the same emoji (anti-double-fire)", async () => {
    const wrapper = mount(ReactionPicker);

    const firstButton = wrapper.findAll("button")[0];
    await firstButton.trigger("click");
    await firstButton.trigger("click");
    await firstButton.trigger("click");

    const selectEvents = wrapper.emitted("select");
    expect(selectEvents).toBeTruthy();
    expect(selectEvents!.length).toBe(1);
  });

  it("allows selecting a different emoji right after another", async () => {
    const wrapper = mount(ReactionPicker);

    const buttons = wrapper.findAll("button");
    await buttons[0].trigger("click");
    await buttons[1].trigger("click");

    const selectEvents = wrapper.emitted("select");
    expect(selectEvents).toBeTruthy();
    expect(selectEvents!.length).toBe(2);
    expect(selectEvents![0]).toEqual(["👍"]);
    expect(selectEvents![1]).toEqual(["❤️"]);
  });

  it("anti-double-fire guard is instance-scoped (multiple pickers don't cross-cancel)", async () => {
    const wrapperA = mount(ReactionPicker);
    const wrapperB = mount(ReactionPicker);

    // Fire the same emoji on two different picker instances in quick succession.
    await wrapperA.findAll("button")[0].trigger("click");
    await wrapperB.findAll("button")[0].trigger("click");

    expect(wrapperA.emitted("select")).toHaveLength(1);
    expect(wrapperB.emitted("select")).toHaveLength(1);
  });
});
