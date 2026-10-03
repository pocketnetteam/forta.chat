// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import type { UserData } from "@/app/providers/initializers";

const ADDRESS = "PR7srzZt4EfcNb3s27grgmiG8aB9vYNV82";
const ROOM = "!AbC123:matrix.pocketnet.app";
const TXID = "f".repeat(64);

const { checkUsername, loadUsersInfo, getBastyonUserData, peekRoom, chatState, openExternalUrl } = vi.hoisted(() => ({
  checkUsername: vi.fn(),
  loadUsersInfo: vi.fn(),
  getBastyonUserData: vi.fn(),
  peekRoom: vi.fn(),
  chatState: { rooms: [] as Array<{ id: string; name: string; avatar?: string; members: string[] }> },
  openExternalUrl: vi.fn(),
}));

vi.mock("@/entities/auth", () => ({
  useAuthStore: () => ({ checkUsername, loadUsersInfo, getBastyonUserData }),
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
  it("shows the short txid and opens the explorer", async () => {
    const w = mount(TransactionLinkCard, { props: { txid: TXID, isOwn: false } });

    expect(w.text()).toContain(`${TXID.slice(0, 10)}…${TXID.slice(-8)}`);
    await w.find("button").trigger("click");
    expect(openExternalUrl).toHaveBeenCalledWith(`https://explorer.pocketnet.app/tx/${TXID}`);
  });
});
