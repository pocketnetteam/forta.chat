import { describe, it, expect, vi } from "vitest";
import { mount } from "@vue/test-utils";
import AiComposer from "../AiComposer.vue";

vi.mock("@/shared/lib/i18n", () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

// Regression: the textarea only respected the `disabled` prop (true while
// *another* AI chat is generating) — while generating in *this* chat,
// `isGenerating` alone was true, `disabled` stayed false, and the textarea
// stayed editable. Typing didn't do anything useful (sending was already
// blocked), but it looked like the composer was just broken/unresponsive
// rather than intentionally locked during generation.
describe("AiComposer", () => {
  it("disables the textarea while generating, even when disabled is not set", () => {
    const wrapper = mount(AiComposer, { props: { isGenerating: true } });

    expect(wrapper.find("textarea").attributes("disabled")).toBeDefined();
  });

  it("disables the textarea when disabled is set, regardless of isGenerating", () => {
    const wrapper = mount(AiComposer, { props: { disabled: true, isGenerating: false } });

    expect(wrapper.find("textarea").attributes("disabled")).toBeDefined();
  });

  it("leaves the textarea enabled when neither disabled nor isGenerating is set", () => {
    const wrapper = mount(AiComposer, {});

    expect(wrapper.find("textarea").attributes("disabled")).toBeUndefined();
  });

  it("shows the stop button instead of send while generating", () => {
    const wrapper = mount(AiComposer, { props: { isGenerating: true } });

    expect(wrapper.find('[title]').attributes("title")).toBeDefined();
    expect(wrapper.findAll("button")).toHaveLength(1);
  });

  it("does not emit send while generating, even if handleSend is somehow triggered", async () => {
    const wrapper = mount(AiComposer, { props: { isGenerating: true } });

    await wrapper.find("textarea").setValue("hello");
    // Enter would normally trigger send — blocked here since isGenerating.
    await wrapper.find("textarea").trigger("keydown", { key: "Enter" });

    expect(wrapper.emitted("send")).toBeUndefined();
  });
});
