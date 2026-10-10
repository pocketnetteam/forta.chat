// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import type { UserData } from "@/app/providers/initializers";

const ADDRESS = "PR7srzZt4EfcNb3s27grgmiG8aB9vYNV82";
const ROOM = "!AbC123:matrix.pocketnet.app";
const TXID = "f".repeat(64);

const { checkUsername, loadUsersInfo, getBastyonUserData, loadTransaction, peekRoom, chatState, openExternalUrl, openUserProfile } = vi.hoisted(() => ({
  checkUsername: vi.fn(),
  loadTransaction: vi.fn(),
  openUserProfile: vi.fn(),
  loadUsersInfo: vi.fn(),
  getBastyonUserData: vi.fn(),
  peekRoom: vi.fn(),
  chatState: { rooms: [] as Array<{ id: string; name: string; avatar?: string; members: string[] }> },
  openExternalUrl: vi.fn(),
}));

vi.mock("@/entities/auth", () => ({
  useAuthStore: () => ({
    checkUsername, loadUsersInfo, getBastyonUserData, loadTransaction,
    blockHeight: 4051812,
    ensureBlockHeight: () => Promise.resolve(4051812),
  }),
}));
vi.mock("@/entities/user", () => ({
  UserAvatar: { name: "UserAvatar", props: ["address", "size"], template: "<i />" },
  useUserStore: () => ({
    getUser: (address: string) => (address === "PSender" ? { name: "maxim" } : address === "PRecipient" ? { name: "maxtest" } : undefined),
    loadUserIfMissing: vi.fn(),
  }),
}));
vi.mock("@/entities/chat", () => ({
  useChatStore: () => ({ rooms: chatState.rooms, peekRoom }),
}));
vi.mock("@/shared/lib/open-external-url", () => ({ openExternalUrl }));
vi.mock("@/shared/lib/image-url", () => ({ normalizePocketnetImageUrl: (x: string) => x }));

// useI18n is auto-imported from the real module — mock it to return keys.
vi.mock("@/shared/lib/i18n", () => ({ useI18n: () => ({ t: (k: string) => k }) }));

import ProfileLinkCard from "../ProfileLinkCard.vue";
import RoomLinkCard from "../RoomLinkCard.vue";
import TransactionLinkCard from "../TransactionLinkCard.vue";
import { clearProfileAddressCache } from "../../model/resolve-profile-address";
import { clearTransactionLoaderCache } from "../../model/use-transaction-loader";
import { JOIN_ROOM_REQUEST_EVENT } from "@/shared/lib/join-room-request";

function user(partial: Partial<UserData>): UserData {
  return {
    about: "", addresses: [], image: "", keys: null, language: "", name: "", ref: null, site: "",
    ...partial,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  clearProfileAddressCache();
  chatState.rooms = [];
  loadUsersInfo.mockResolvedValue(undefined);
});

describe("ProfileLinkCard", () => {
  const href = "https://bastyon.com/kleine_viogelein?ref=x";

  it("resolves the username and shows the profile; click opens it in-app", async () => {
    checkUsername.mockResolvedValue(ADDRESS);
    getBastyonUserData.mockReturnValue(user({ name: "Kleine", about: "hello", subscribers_count: 12 }));
    const openUserProfile = vi.fn();
    const w = mount(ProfileLinkCard, {
      props: { href, name: "kleine_viogelein", isOwn: false },
      global: { provide: { openUserProfile } },
    });
    await flushPromises();

    expect(checkUsername).toHaveBeenCalledWith("kleine_viogelein");
    expect(loadUsersInfo).toHaveBeenCalledWith([ADDRESS]);
    expect(w.text()).toContain("Kleine");
    expect(w.text()).toContain("hello");
    expect(w.text()).toContain("profileLink.subscribers");

    await w.find("button").trigger("click");
    expect(openUserProfile).toHaveBeenCalledWith(ADDRESS);
    expect(openExternalUrl).not.toHaveBeenCalled();
  });

  it("uses the address directly without a username lookup", async () => {
    getBastyonUserData.mockReturnValue(user({ name: "Kleine" }));
    const w = mount(ProfileLinkCard, { props: { href, address: ADDRESS, isOwn: false } });
    await flushPromises();

    expect(checkUsername).not.toHaveBeenCalled();
    expect(w.text()).toContain("Kleine");
  });

  it("falls back to a plain https link when the user does not exist", async () => {
    checkUsername.mockResolvedValue(null);
    const w = mount(ProfileLinkCard, { props: { href, name: "nosuchuser", isOwn: false } });
    await flushPromises();

    const link = w.find("a");
    expect(link.attributes("href")).toBe(href);
    expect(link.text()).toBe(href);
    await link.trigger("click");
    expect(openExternalUrl).toHaveBeenCalledWith(href);
  });
});

describe("RoomLinkCard", () => {
  it("does not peek an unknown room (a card per link would cancel each other's peek)", async () => {
    const onRequest = vi.fn();
    window.addEventListener(JOIN_ROOM_REQUEST_EVENT, onRequest);
    const w = mount(RoomLinkCard, { props: { roomId: ROOM, isOwn: false } });
    await flushPromises();

    expect(peekRoom).not.toHaveBeenCalled();
    expect(w.text()).toContain("roomLink.unknown");
    expect(w.find("button").text()).toBe("joinRoom.join");

    // Join goes through the app's join pipeline (preview modal peeks once there).
    await w.find("button").trigger("click");
    expect(onRequest).toHaveBeenCalledTimes(1);
    expect((onRequest.mock.calls[0][0] as CustomEvent).detail).toEqual({ roomId: ROOM });
    window.removeEventListener(JOIN_ROOM_REQUEST_EVENT, onRequest);
  });

  it("shows a known room from the local list", async () => {
    chatState.rooms = [{ id: ROOM, name: "My group", members: ["a", "b"] }];
    const w = mount(RoomLinkCard, { props: { roomId: ROOM, isOwn: false } });
    await flushPromises();

    expect(w.text()).toContain("My group");
    expect(w.text()).toContain("roomLink.members");
    expect(w.find("button").text()).toBe("roomLink.open");
  });
});

describe("TransactionLinkCard", () => {
  // Real node shape: no `confirmations`, block `height` + `nTime`.
  const rawTx = {
    txid: TXID,
    height: 4051390,
    blockHash: "3ece9e7a",
    nTime: 1_700_000_000,
    vin: [{ address: "PSender" }],
    vout: [
      { value: 0, scriptPubKey: { asm: "OP_RETURN" } },
      { value: 20, scriptPubKey: { addresses: ["PRecipient"] } },
      { value: 4.5, scriptPubKey: { addresses: ["PSender"] } },
    ],
  };

  beforeEach(() => {
    vi.useFakeTimers();
    clearTransactionLoaderCache();
    loadTransaction.mockReset();
    openExternalUrl.mockReset();
    openUserProfile.mockReset();
  });
  afterEach(() => vi.useRealTimers());

  const mountCard = () =>
    mount(TransactionLinkCard, {
      props: { txid: TXID, isOwn: false },
      global: { provide: { openUserProfile } },
    });

  /** Past the 3s pre-delay of the first node call. */
  const firstAttempt = () => vi.advanceTimersByTimeAsync(3_000);

  it("waits for the transaction, then shows sender, recipient, amount and confirmations", async () => {
    loadTransaction.mockResolvedValue(rawTx);
    const w = mountCard();
    await flushPromises();
    expect(loadTransaction).not.toHaveBeenCalled();
    expect(w.find("[data-testid='tx-link-loading']").exists()).toBe(true);

    await firstAttempt();

    expect(loadTransaction).toHaveBeenCalledWith(TXID, false);
    expect(w.find("[data-testid='tx-link-total']").text()).toBe("20");
    const senders = w.findAll("[data-testid='tx-link-sender']");
    const recipients = w.findAll("[data-testid='tx-link-recipient']");
    expect(senders).toHaveLength(1);
    expect(senders[0].text()).toContain("maxim");
    expect(recipients).toHaveLength(1);
    expect(recipients[0].text()).toContain("maxtest");
    expect(recipients[0].text()).toContain("+20");
    // tip 4051812 − block 4051390 + 1
    expect(w.find("[data-testid='tx-link-status']").text()).toBe("txLink.confirmations");
    expect(w.text()).not.toContain("txLink.unconfirmed");
  });

  it("keeps polling while our node doesn't know the transaction yet", async () => {
    loadTransaction.mockResolvedValueOnce(null).mockResolvedValue(rawTx);
    const w = mountCard();
    await firstAttempt();
    expect(w.find("[data-testid='tx-link-loading']").exists()).toBe(true);

    await vi.advanceTimersByTimeAsync(15_000);
    expect(loadTransaction).toHaveBeenCalledTimes(2);
    expect(w.find("[data-testid='tx-link-details']").exists()).toBe(true);
  });

  it("a mempool transaction shows as awaiting confirmation", async () => {
    loadTransaction.mockResolvedValue({ ...rawTx, height: undefined, blockHash: undefined });
    const w = mountCard();
    await firstAttempt();
    expect(w.find("[data-testid='tx-link-status']").text()).toBe("txLink.unconfirmed");
    // Still polling for its block: no manual recheck yet.
    expect(w.find("[data-testid='tx-link-recheck']").exists()).toBe(false);
  });

  it("still unmined after the window: a recheck button asks the node again", async () => {
    loadTransaction.mockResolvedValue({ ...rawTx, height: undefined, blockHash: undefined });
    const w = mountCard();
    await vi.advanceTimersByTimeAsync(5 * 60_000 + 30_000);
    const calls = loadTransaction.mock.calls.length;

    loadTransaction.mockResolvedValue(rawTx);
    await w.find("[data-testid='tx-link-recheck']").trigger("click");
    await vi.advanceTimersByTimeAsync(0);
    expect(loadTransaction.mock.calls.length).toBe(calls + 1);
    expect(w.find("[data-testid='tx-link-status']").text()).toBe("txLink.confirmations");
    expect(w.find("[data-testid='tx-link-recheck']").exists()).toBe(false);
  });

  it("tapping a participant opens their profile", async () => {
    loadTransaction.mockResolvedValue(rawTx);
    const w = mountCard();
    await firstAttempt();

    await w.find("[data-testid='tx-link-recipient']").trigger("click");
    expect(openUserProfile).toHaveBeenCalledWith("PRecipient");
  });

  it("after the 5-minute window shows not-found, and retry asks again at once", async () => {
    loadTransaction.mockRejectedValue(new Error("No such transaction"));
    const w = mountCard();
    await vi.advanceTimersByTimeAsync(5 * 60_000 + 30_000);
    expect(w.find("[data-testid='tx-link-not-found']").exists()).toBe(true);

    loadTransaction.mockReset().mockResolvedValue(rawTx);
    await w.find("[data-testid='tx-link-retry']").trigger("click");
    await vi.advanceTimersByTimeAsync(0);
    expect(loadTransaction).toHaveBeenCalledTimes(1);
    expect(w.find("[data-testid='tx-link-details']").exists()).toBe(true);
  });

  it("a new txid reloads the card and a late answer for the old one is ignored", async () => {
    const OTHER = "e".repeat(64);
    let resolveOld!: (v: unknown) => void;
    loadTransaction
      .mockReturnValueOnce(new Promise((r) => { resolveOld = r; }))
      .mockResolvedValueOnce({ ...rawTx, txid: OTHER, vout: [{ value: 7, scriptPubKey: { addresses: ["PRecipient"] } }] });
    const w = mountCard();
    await firstAttempt();
    await w.setProps({ txid: OTHER });
    await firstAttempt();
    resolveOld(rawTx);
    await flushPromises();

    expect(loadTransaction).toHaveBeenLastCalledWith(OTHER, false);
    expect(w.find("[data-testid='tx-link-total']").text()).toBe("7");
  });

  it("shows the short txid and opens the explorer", async () => {
    loadTransaction.mockResolvedValue(rawTx);
    const w = mountCard();
    await firstAttempt();

    expect(w.text()).toContain(`${TXID.slice(0, 10)}…${TXID.slice(-8)}`);
    await w.find("[data-testid='tx-link-open']").trigger("click");
    expect(openExternalUrl).toHaveBeenCalledWith(`https://bastyon.com/blockexplorer/transaction/${TXID}`);
  });
});
