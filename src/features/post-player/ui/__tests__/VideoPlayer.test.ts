import { describe, it, expect } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import VideoPlayer from "../VideoPlayer.vue";

describe("VideoPlayer iframe security", () => {
  it("renders iframe with sandbox attribute set after play is clicked", async () => {
    const wrapper = mount(VideoPlayer, {
      props: { url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" },
    });

    expect(wrapper.find("iframe").exists()).toBe(false);

    await wrapper.find("button").trigger("click");
    await flushPromises();

    const iframe = wrapper.find("iframe");
    expect(iframe.exists()).toBe(true);

    const sandbox = iframe.attributes("sandbox") ?? "";
    expect(sandbox).toContain("allow-scripts");
    expect(sandbox).toContain("allow-same-origin");
    expect(sandbox).toContain("allow-presentation");
  });
});
