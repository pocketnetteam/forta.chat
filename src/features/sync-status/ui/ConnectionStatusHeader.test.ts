import { describe, it, expect, vi, beforeEach } from "vitest";
import { mount } from "@vue/test-utils";
import { computed, ref } from "vue";
import type { DisplayPhase } from "../model/use-debounced-status";

const displayStatus = ref<DisplayPhase>("idle");

vi.mock("../model/use-sync-status", () => ({
  useSyncStatus: () => ({
    displayStatus,
    bannerText: computed(() => `sync.${displayStatus.value}`),
    bannerVariant: computed(() =>
      displayStatus.value === "error" ? "error"
        : displayStatus.value === "offline" || displayStatus.value === "connecting" ? "warning"
          : "info",
    ),
  }),
}));
vi.mock("@/shared/lib/i18n", () => ({
  useI18n: () => ({ t: (k: string) => k }),
}));

import ConnectionStatusHeader from "./ConnectionStatusHeader.vue";

describe("ConnectionStatusHeader", () => {
  beforeEach(() => {
    displayStatus.value = "idle";
  });

  it("error: settled state — a visible static red dot, not an endless spinner", async () => {
    const wrapper = mount(ConnectionStatusHeader);
    displayStatus.value = "error";
    await wrapper.vm.$nextTick();

    expect(wrapper.find("svg.animate-spin").exists()).toBe(false);
    const dot = wrapper.find("span.rounded-full");
    expect(dot.exists()).toBe(true);
    // Regression: the dot only had a text color and no background → invisible.
    expect(dot.classes()).toContain("bg-current");
    expect(dot.classes()).toContain("text-red-400");
  });

  it("offline: visible dot", async () => {
    const wrapper = mount(ConnectionStatusHeader);
    displayStatus.value = "offline";
    await wrapper.vm.$nextTick();

    expect(wrapper.find("span.rounded-full").classes()).toContain("bg-current");
  });

  it("connecting: spinner", async () => {
    const wrapper = mount(ConnectionStatusHeader);
    displayStatus.value = "connecting";
    await wrapper.vm.$nextTick();

    expect(wrapper.find("svg.animate-spin").exists()).toBe(true);
  });

  it("idle: no indicator", () => {
    const wrapper = mount(ConnectionStatusHeader);
    expect(wrapper.find("svg").exists()).toBe(false);
    expect(wrapper.find("span.rounded-full").exists()).toBe(false);
  });
});
