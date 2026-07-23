import { describe, it, expect, vi, beforeEach } from "vitest";
import { mount } from "@vue/test-utils";
import { ref } from "vue";

const mockPrivateKey = ref<string | null>("aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899");
const copyToClipboard = vi.fn().mockResolvedValue(undefined);
const toast = vi.fn();

vi.mock("@/shared/lib/i18n", () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

vi.mock("@/shared/ui/modal/Modal.vue", () => ({
  default: {
    name: "Modal",
    props: ["show", "ariaLabel"],
    emits: ["close"],
    template: "<div class='modal-stub'><slot /></div>",
  },
}));

vi.mock("@/entities/auth", () => ({
  useAuthStore: () => ({
    get privateKey() {
      return mockPrivateKey.value;
    },
  }),
}));

vi.mock("@/shared/lib/share-link", () => ({
  copyToClipboard: (...args: unknown[]) => copyToClipboard(...args),
}));

vi.mock("@/shared/lib/use-toast", () => ({
  useToast: () => ({ toast }),
}));

import ShowPrivateKeyDialog from "../ShowPrivateKeyDialog.vue";

function mountDialog(show = true) {
  return mount(ShowPrivateKeyDialog, { props: { show } });
}

describe("ShowPrivateKeyDialog", () => {
  beforeEach(() => {
    mockPrivateKey.value = "aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899";
    copyToClipboard.mockClear();
    copyToClipboard.mockResolvedValue(undefined);
    toast.mockClear();
  });

  it("shows confirm step by default", () => {
    const wrapper = mountDialog();
    expect(wrapper.text()).toContain("settings.showPrivateKeyConfirm");
    expect(wrapper.text()).toContain("settings.showPrivateKeyYes");
    expect(wrapper.text()).toContain("settings.showPrivateKeyNo");
    expect(wrapper.text()).not.toContain(mockPrivateKey.value!);
  });

  it("No closes the dialog without revealing the key", async () => {
    const wrapper = mountDialog();
    const noBtn = wrapper.findAll("button").find((b) => b.text() === "settings.showPrivateKeyNo")!;
    await noBtn.trigger("click");
    expect(wrapper.emitted("close")).toBeTruthy();
    expect(wrapper.text()).not.toContain(mockPrivateKey.value!);
  });

  it("Yes reveals the private key from the auth store", async () => {
    const wrapper = mountDialog();
    const yesBtn = wrapper.findAll("button").find((b) => b.text() === "settings.showPrivateKeyYes")!;
    await yesBtn.trigger("click");
    expect(wrapper.text()).toContain(mockPrivateKey.value!);
    expect(wrapper.text()).toContain("settings.privateKeyIsPassword");
    expect(wrapper.text()).toContain("settings.privateKeyImportant");
    expect(wrapper.text()).toContain("settings.copyPrivateKey");
  });

  it("Yes with null privateKey closes without revealing", async () => {
    mockPrivateKey.value = null;
    const wrapper = mountDialog();
    const yesBtn = wrapper.findAll("button").find((b) => b.text() === "settings.showPrivateKeyYes")!;
    await yesBtn.trigger("click");
    expect(wrapper.emitted("close")).toBeTruthy();
    expect(wrapper.text()).not.toContain("settings.copyPrivateKey");
  });

  it("Copy copies the private key to the clipboard", async () => {
    const wrapper = mountDialog();
    const yesBtn = wrapper.findAll("button").find((b) => b.text() === "settings.showPrivateKeyYes")!;
    await yesBtn.trigger("click");

    const copyBtn = wrapper.findAll("button").find((b) => b.text().includes("settings.copyPrivateKey"))!;
    await copyBtn.trigger("click");
    await wrapper.vm.$nextTick();

    expect(copyToClipboard).toHaveBeenCalledWith(mockPrivateKey.value);
    expect(wrapper.text()).toContain("chatInfo.copied");
  });

  it("Copy failure shows an error toast", async () => {
    copyToClipboard.mockRejectedValueOnce(new Error("denied"));
    const wrapper = mountDialog();
    const yesBtn = wrapper.findAll("button").find((b) => b.text() === "settings.showPrivateKeyYes")!;
    await yesBtn.trigger("click");

    const copyBtn = wrapper.findAll("button").find((b) => b.text().includes("settings.copyPrivateKey"))!;
    await copyBtn.trigger("click");
    await wrapper.vm.$nextTick();

    expect(toast).toHaveBeenCalledWith("chat.copyFailed", "error");
  });
});
