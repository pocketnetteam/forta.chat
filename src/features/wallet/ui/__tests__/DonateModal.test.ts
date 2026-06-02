import { describe, it, expect, vi, beforeEach } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";

// --- i18n: echo a small dict so assertions read real strings ---
const dict: Record<string, string> = {
  "wallet.transactionError": "Ошибка транзакции",
  "wallet.operationFailed": "Не удалось выполнить операцию. Попробуйте позже.",
  "wallet.senderPaysFees": "Комиссию платит отправитель",
  "wallet.receiverPaysFees": "Комиссию платит получатель",
  "wallet.calculateFees": "Рассчитать комиссию",
  "wallet.send": "Отправить",
};
vi.mock("@/shared/lib/i18n", () => ({
  useI18n: () => ({
    t: (key: string) => dict[key] ?? key,
    locale: { value: "ru" },
  }),
}));

// --- heavy dependencies stubbed to keep the test focused on rendering ---
const estimateFees = vi.fn();
const sendTransfer = vi.fn();
vi.mock("../../model/use-wallet", () => ({
  useWallet: () => ({ estimateFees, sendTransfer }),
}));

vi.mock("../../model/wallet-store", () => ({
  useWalletStore: () => ({ balance: 11183.38, refresh: vi.fn() }),
  formatPkoin: (n: number) => n.toFixed(2),
}));

vi.mock("@/entities/chat", () => ({ useChatStore: () => ({}) }));
vi.mock("@/entities/auth", () => ({ useAuthStore: () => ({ address: "PSender" }) }));
vi.mock("@/features/messaging/model/use-messages", () => ({
  useMessages: () => ({ sendTransferMessage: vi.fn() }),
}));

// Modal stub: always render its default slot so we can inspect inner UI.
vi.mock("@/shared/ui/modal/Modal.vue", () => ({
  default: { name: "ModalStub", template: "<div><slot /></div>" },
}));

import DonateModal from "../DonateModal.vue";

const mountDialog = () =>
  mount(DonateModal, {
    props: { show: true, receiverAddress: "PReceiver", receiverName: "Network_support" },
  });

describe("DonateModal", () => {
  beforeEach(() => {
    estimateFees.mockReset();
    sendTransfer.mockReset();
  });

  it("renders the thrown Error message, not '[object Object]'", async () => {
    // Arrange
    estimateFees.mockRejectedValue(new Error("Insufficient balance"));
    const wrapper = mountDialog();
    await wrapper.find("input[type='number']").setValue("3000");

    // Act — click the "Calculate fees" button
    const calcBtn = wrapper
      .findAll("button")
      .find((b) => b.text().includes("Рассчитать комиссию"));
    await calcBtn!.trigger("click");
    await flushPromises();

    // Assert
    const text = wrapper.text();
    expect(text).toContain("Insufficient balance");
    expect(text).not.toContain("[object Object]");
  });

  it("renders a readable message for a plain RPC error object", async () => {
    // Arrange — the exact failure mode from the bug report
    estimateFees.mockRejectedValue({ code: -6, message: "Fee estimation failed" });
    const wrapper = mountDialog();
    await wrapper.find("input[type='number']").setValue("3000");

    // Act
    const calcBtn = wrapper
      .findAll("button")
      .find((b) => b.text().includes("Рассчитать комиссию"));
    await calcBtn!.trigger("click");
    await flushPromises();

    // Assert
    const text = wrapper.text();
    expect(text).toContain("Fee estimation failed");
    expect(text).not.toContain("[object Object]");
  });

  it("styles fee-payer tabs with theme accent tokens, not hardcoded blue", () => {
    // Arrange / Act
    const wrapper = mountDialog();
    const tabs = wrapper
      .findAll("button")
      .filter((b) => b.text().includes("Комиссию платит"));

    // Assert — selected (sender) tab uses the accent token that follows the
    // user's chosen palette; no hardcoded Tailwind blue anywhere on the tabs.
    expect(tabs.length).toBe(2);
    const senderTab = tabs[0];
    const cls = senderTab.classes().join(" ");
    expect(cls).toContain("text-color-bg-ac");
    expect(cls).not.toContain("text-color-txt-ac");
    for (const tab of tabs) {
      const c = tab.classes().join(" ");
      expect(c).not.toMatch(/blue/);
    }
  });
});
