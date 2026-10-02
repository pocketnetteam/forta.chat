// @vitest-environment happy-dom
import { describe, it, expect, vi } from "vitest";
import { mount } from "@vue/test-utils";
import Avatar from "../Avatar.vue";

describe("Avatar", () => {
  it("shows the image again when a failed instance is reused with another src", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    // RecycleScroller moves Avatar instances between rows; an error on one row's
    // image used to hide the image on every row the instance showed after it.
    const wrapper = mount(Avatar, { props: { src: "https://a.example/broken.png", name: "A" } });
    await wrapper.find("img").trigger("error");
    expect(wrapper.find("img").exists()).toBe(false);

    await wrapper.setProps({ src: "https://a.example/ok.png", name: "B" });
    expect(wrapper.find("img").attributes("src")).toBe("https://a.example/ok.png");
  });
});
