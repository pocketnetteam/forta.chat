import { describe, it, expect, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { nextTick } from "vue";

vi.mock("@/shared/lib/composables/use-android-back-handler", () => ({ useAndroidBackHandler: vi.fn() }));

import BottomSheet from "../BottomSheet.vue";

/**
 * Regression: the message menu "opened not fully". Closing a sheet by
 * dragging it down kept the drag offset, and the inline transform outranks the
 * enter transition, so the next sheet opened pushed down by that offset
 * (Samsung, 2026-09-28: translateY(250.764px), 174 of 425 px on screen).
 */
function touch(y: number) {
  return { touches: [{ clientY: y }] };
}

function mountSheet() {
  return mount(BottomSheet, {
    props: { show: true },
    slots: { default: "<div class='item'>Reply</div>" },
    global: { stubs: { teleport: true, transition: false } },
  });
}

const sheet = (w: ReturnType<typeof mountSheet>) => w.find('[role="dialog"]');

describe("BottomSheet drag state", () => {
  it("opens at rest after the previous sheet was dragged closed", async () => {
    const wrapper = mountSheet();
    await sheet(wrapper).trigger("touchstart", touch(100));
    await sheet(wrapper).trigger("touchmove", touch(400));
    await sheet(wrapper).trigger("touchend");
    expect(wrapper.emitted("close")).toHaveLength(1);

    await wrapper.setProps({ show: false });
    await wrapper.setProps({ show: true });
    await nextTick();

    expect(sheet(wrapper).attributes("style")).toContain("translateY(0px)");
  });

  it("snaps back when the system cancels the touch", async () => {
    const wrapper = mountSheet();
    await sheet(wrapper).trigger("touchstart", touch(100));
    await sheet(wrapper).trigger("touchmove", touch(160));
    expect(sheet(wrapper).attributes("style")).toContain("translateY(60px)");

    await sheet(wrapper).trigger("touchcancel");

    expect(sheet(wrapper).attributes("style")).toContain("translateY(0px)");
    expect(wrapper.emitted("close")).toBeUndefined();
  });

  it("does not drag the sheet while its list is scrolled down", async () => {
    const wrapper = mountSheet();
    const list = sheet(wrapper).find(".overflow-y-auto");
    (list.element as HTMLElement).scrollTop = 120;
    const item = wrapper.find(".item");

    await item.trigger("touchstart", touch(100));
    await item.trigger("touchmove", touch(300));

    expect(sheet(wrapper).attributes("style")).toContain("translateY(0px)");
  });
});
