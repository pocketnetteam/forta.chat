import { describe, it, expect, vi, beforeEach } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import CaptchaStep from "../CaptchaStep.vue";

vi.mock("@/shared/lib/i18n", () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

const fetchCaptcha = vi.fn();
const submitCaptcha = vi.fn();
const requestRegistrationFunding = vi.fn();

vi.mock("@/entities/auth", () => ({
  useAuthStore: () => ({
    fetchCaptcha: (...args: unknown[]) => fetchCaptcha(...args),
    submitCaptcha: (...args: unknown[]) => submitCaptcha(...args),
    requestRegistrationFunding: (...args: unknown[]) => requestRegistrationFunding(...args),
  }),
}));

async function mountAndSubmit(text: string) {
  const wrapper = mount(CaptchaStep);
  await flushPromises();
  await wrapper.find("input").setValue(text);
  await wrapper.find("form").trigger("submit.prevent");
  await flushPromises();
  return wrapper;
}

describe("CaptchaStep — distinguishes a wrong captcha answer from a funding failure", () => {
  beforeEach(() => {
    fetchCaptcha.mockReset().mockResolvedValue({ id: "cap1", img: "<svg/>", done: false });
    submitCaptcha.mockReset();
    requestRegistrationFunding.mockReset();
  });

  it("shows the generic incorrect-captcha message when submitCaptcha itself fails, without requesting funding", async () => {
    submitCaptcha.mockRejectedValueOnce(new Error("Incorrect captcha solution"));
    const wrapper = await mountAndSubmit("WRONG");

    expect(wrapper.text()).toContain("register.captchaIncorrect");
    expect(wrapper.text()).not.toContain("register.captchaFundingFailed");
    expect(requestRegistrationFunding).not.toHaveBeenCalled();
    expect(wrapper.emitted("done")).toBeUndefined();
  });

  it("shows the funding-specific message and reloads a fresh captcha when requestRegistrationFunding fails", async () => {
    submitCaptcha.mockResolvedValueOnce({ id: "cap1", done: true });
    requestRegistrationFunding.mockRejectedValueOnce(new Error("free/balance rejected"));
    const wrapper = await mountAndSubmit("ABCD");

    expect(wrapper.text()).toContain("register.captchaFundingFailed");
    expect(wrapper.text()).not.toContain("register.captchaIncorrect");
    // Initial mount load + reload after the funding failure.
    expect(fetchCaptcha).toHaveBeenCalledTimes(2);
    expect(wrapper.emitted("done")).toBeUndefined();
  });

  it("requests funding only after the captcha is verified, and emits done once both succeed", async () => {
    submitCaptcha.mockResolvedValueOnce({ id: "cap1", done: true });
    requestRegistrationFunding.mockResolvedValueOnce(undefined);
    const wrapper = await mountAndSubmit("ABCD");

    expect(submitCaptcha).toHaveBeenCalledWith("ABCD");
    expect(requestRegistrationFunding).toHaveBeenCalledTimes(1);
    expect(wrapper.emitted("done")).toHaveLength(1);
  });
});
