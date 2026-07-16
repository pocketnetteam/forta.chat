import { describe, it, expect, vi } from "vitest";
import { mount } from "@vue/test-utils";
import RegistrationStepper from "../RegistrationStepper.vue";

vi.mock("@/shared/lib/i18n", () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

vi.mock("@/shared/ui/modal/Modal.vue", () => ({
  default: {
    name: "Modal",
    props: ["show", "ariaLabel"],
    emits: ["close"],
    template: `
      <div v-if="show" class="modal-stub" data-testid="cancel-modal">
        <slot />
      </div>
    `,
  },
}));

function mountStepper(props: Partial<InstanceType<typeof RegistrationStepper>["$props"]> = {}) {
  return mount(RegistrationStepper, {
    props: {
      phase: "confirming",
      showCancel: false,
      ...props,
    },
  });
}

describe("RegistrationStepper — cancel registration", () => {
  it("does not show cancel button when showCancel is false", () => {
    const wrapper = mountStepper({ showCancel: false, phase: "confirming" });
    expect(wrapper.text()).not.toContain("register.cancelRegistration");
  });

  it("shows cancel button when showCancel is true during poll", () => {
    const wrapper = mountStepper({ showCancel: true, phase: "confirming" });
    expect(wrapper.text()).toContain("register.cancelRegistration");
  });

  it("opens confirm modal on cancel click and emits cancel after confirm", async () => {
    const wrapper = mountStepper({ showCancel: true, phase: "init" });

    const cancelBtn = wrapper.findAll("button").find((b) =>
      b.text().includes("register.cancelRegistration"),
    );
    expect(cancelBtn).toBeDefined();
    await cancelBtn!.trigger("click");
    expect(wrapper.find("[data-testid='cancel-modal']").exists()).toBe(true);

    const confirmButtons = wrapper.findAll("button").filter((b) =>
      b.text().includes("register.cancelConfirmAction"),
    );
    expect(confirmButtons.length).toBe(1);
    await confirmButtons[0].trigger("click");

    expect(wrapper.emitted("cancel")).toHaveLength(1);
  });

  it("does not show cancel button on error phase even when showCancel is true", () => {
    const wrapper = mountStepper({ showCancel: true, phase: "error", errorType: "timeout" });
    expect(wrapper.text()).not.toContain("register.cancelRegistration");
  });
});
