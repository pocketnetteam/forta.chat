import { describe, it, expect, vi } from "vitest";
import { mount } from "@vue/test-utils";

// ───────────────── Mocks ─────────────────
vi.mock("@/shared/lib/i18n", () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

// Modal renders its default slot inline so we can query the form fields.
vi.mock("@/shared/ui/modal/Modal.vue", () => ({
  default: {
    name: "Modal",
    props: ["show", "ariaLabel"],
    template: "<div class='modal-stub'><slot /></div>",
  },
}));

import CallProviderDialog from "../CallProviderDialog.vue";

function mountDialog() {
  return mount(CallProviderDialog, { props: { show: true } });
}

describe("CallProviderDialog", () => {
  const MEET_URL = "https://meet.google.com/abc-defg-hij";

  it("Сохранить активна при валидной Google Meet ссылке и заполненном label", async () => {
    const wrapper = mountDialog();
    const saveBtn = wrapper.findAll("button").find((b) => b.text() === "settings.callProviders.save")!;
    expect(saveBtn.attributes("disabled")).toBeDefined();

    await wrapper.find('input[type="text"]').setValue("Meet");
    await wrapper.find('input[inputmode="url"]').setValue(MEET_URL);

    expect(saveBtn.attributes("disabled")).toBeUndefined();

    await saveBtn.trigger("click");
    const saved = wrapper.emitted("save");
    expect(saved).toBeTruthy();
    expect(saved![0][0]).toEqual({ label: "Meet", urlTemplate: MEET_URL });
  });

  it("url-поле использует type=text (без type=url deferral на Android OEM)", () => {
    const wrapper = mountDialog();
    const urlInput = wrapper.find('input[inputmode="url"]');
    // type=url откладывает input-событие до blur на части Android OEM WebView.
    expect(urlInput.attributes("type")).toBe("text");
    expect(urlInput.attributes("inputmode")).toBe("url");
    expect(urlInput.attributes("autocapitalize")).toBe("off");
  });

  it("label показывает индикатор обязательности (*) и Сохранить остаётся disabled при валидном url, но пустом label", async () => {
    const wrapper = mountDialog();
    // Индикатор обязательности виден всегда — это и есть UX-фикс (#918): пользователь понимает, почему Сохранить неактивна.
    expect(wrapper.find("label").text()).toContain("*");

    // url валиден и обновляется немедленно (type=text), но label пуст → Сохранить disabled.
    await wrapper.find('input[inputmode="url"]').setValue(MEET_URL);
    const saveBtn = wrapper.findAll("button").find((b) => b.text() === "settings.callProviders.save")!;
    expect(saveBtn.attributes("disabled")).toBeDefined();
    expect(wrapper.emitted("save")).toBeFalsy();
  });

  it("сохранение существующего провайдера (Zoom/Jitsi) по-прежнему работает — регрессия WEE-57", async () => {
    const wrapper = mount(CallProviderDialog, {
      props: {
        show: true,
        provider: { id: 1, label: "Zoom", urlTemplate: "https://zoom.us/j/123" },
      },
    });
    const saveBtn = wrapper.findAll("button").find((b) => b.text() === "settings.callProviders.save")!;
    expect(saveBtn.attributes("disabled")).toBeUndefined();

    await saveBtn.trigger("click");
    const saved = wrapper.emitted("save");
    expect(saved).toBeTruthy();
    expect(saved![0]).toEqual([{ label: "Zoom", urlTemplate: "https://zoom.us/j/123" }, 1]);
  });
});
