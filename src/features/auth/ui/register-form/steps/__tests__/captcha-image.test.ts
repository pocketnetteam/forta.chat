// @vitest-environment happy-dom
import { describe, it, expect, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { captchaImageSrc } from "../captcha-image";

/**
 * Audit S10-02 / S5-04: the captcha SVG from third-party proxy nodes went into
 * v-html after a regex clean-up that let `<svg onload=alert(1)>` through.
 * It is now only ever an <img> source, where SVG cannot run anything.
 */

vi.mock("@/shared/lib/i18n", () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

const fetchCaptcha = vi.fn();
vi.mock("@/entities/auth", () => ({
  useAuthStore: () => ({
    fetchCaptcha: (...args: unknown[]) => fetchCaptcha(...args),
    submitCaptcha: vi.fn(),
    requestRegistrationFunding: vi.fn(),
  }),
}));

const decode = (src: string): string => decodeURIComponent(src.slice(src.indexOf(",") + 1));

describe("captchaImageSrc", () => {
  it("turns the SVG into an image data URI", () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="150" height="50"><path d="M0 0L10 10"/></svg>';
    const src = captchaImageSrc(svg);
    expect(src.startsWith("data:image/svg+xml;charset=utf-8,")).toBe(true);
    expect(decode(src)).toBe(svg);
  });

  it("adds the SVG namespace an <img> needs when the markup omits it", () => {
    const decoded = decode(captchaImageSrc('<svg width="150" height="50"><path d="M0 0"/></svg>'));
    expect(decoded).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="150"/);
  });

  it("still finds the root behind an XML prolog or a BOM", () => {
    const decoded = decode(captchaImageSrc('﻿<?xml version="1.0" encoding="UTF-8"?>\n<svg width="150"><path/></svg>'));
    expect(decoded).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="150"/);
  });

  it("is empty for an empty captcha", () => {
    expect(captchaImageSrc("")).toBe("");
    expect(captchaImageSrc("   ")).toBe("");
  });
});

describe("CaptchaStep renders the captcha as an image only", () => {
  it.each([
    "<svg onload=alert(1)></svg>",
    "<svg OnLoad = alert(1)></svg>",
    "<svg\tonload\n=alert(1)></svg>",
    '<svg><set attributeName="onmouseover" to="alert(1)"/></svg>',
    "<svg><script>alert(1)</script></svg>",
  ])("never puts %s into the document", async (payload) => {
    fetchCaptcha.mockResolvedValueOnce({ id: "cap", img: payload, done: false });
    const { default: CaptchaStep } = await import("../CaptchaStep.vue");
    const wrapper = mount(CaptchaStep);
    await flushPromises();

    expect(wrapper.find("svg").exists()).toBe(false);
    expect(wrapper.find("script").exists()).toBe(false);
    const img = wrapper.find("img");
    expect(img.exists()).toBe(true);
    expect(img.attributes("src")).toMatch(/^data:image\/svg\+xml;charset=utf-8,/);
    expect(img.attributes("onload")).toBeUndefined();
    wrapper.unmount();
  });
});
