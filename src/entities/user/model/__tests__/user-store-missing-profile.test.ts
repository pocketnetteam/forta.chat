/**
 * Regression: an address the server answers with no profile (unregistered,
 * deleted, empty name) was never cached — neither by the SDK nor by the
 * user store — and loadProfilesForRoomIds never marked its room as done.
 * The sidebar asks for all rooms' members on every list change, so each new
 * message re-requested it: ~160 single-address getuserprofile calls per
 * session. The store must remember "no profile" for a while.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { setActivePinia, createPinia } from "pinia";

const profiles: Record<string, { name: string } | null> = {};
const loadUsersInfo = vi.fn(async (_addrs: string[]) => {});

vi.mock("@/app/providers/initializers/app-initializer", () => ({
  createAppInitializer: () => ({
    initApi: vi.fn(async () => {}),
    loadUsersInfo,
    getUserData: (addr: string) => profiles[addr] ?? null,
  }),
}));

import { useUserStore } from "../user-store";

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("user-store — server-confirmed missing profiles", () => {
  let store: ReturnType<typeof useUserStore>;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1_000_000);
    localStorage.clear();
    setActivePinia(createPinia());
    store = useUserStore();
    loadUsersInfo.mockReset();
    loadUsersInfo.mockImplementation(async () => {});
    for (const k of Object.keys(profiles)) delete profiles[k];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not re-request an address the server returned no profile for", async () => {
    profiles.Ghost = null;
    await store.loadUsersBatch(["Ghost"]);
    expect(loadUsersInfo).toHaveBeenCalledTimes(1);

    await store.loadUsersBatch(["Ghost"]);
    store.loadUserIfMissing("Ghost");
    await flush();
    expect(loadUsersInfo).toHaveBeenCalledTimes(1);
  });

  it("treats an empty-name profile as missing too", async () => {
    profiles.Blank = { name: "  " };
    await store.loadUsersBatch(["Blank"]);
    await store.loadUsersBatch(["Blank"]);
    expect(loadUsersInfo).toHaveBeenCalledTimes(1);
  });

  it("asks again 30s after a single empty answer — it may have been a flaky node", async () => {
    profiles.Flaky = null;
    await store.loadUsersBatch(["Flaky"]);
    vi.setSystemTime(1_000_000 + 30_000 + 1);
    profiles.Flaky = { name: "Flaky" };
    await store.loadUsersBatch(["Flaky"]);
    expect(loadUsersInfo).toHaveBeenCalledTimes(2);
    expect(store.users.Flaky?.name).toBe("Flaky");
  });

  it("backs off for 5 minutes after two empty answers in a row", async () => {
    profiles.Ghost = null;
    await store.loadUsersBatch(["Ghost"]);
    vi.setSystemTime(1_000_000 + 30_001);
    await store.loadUsersBatch(["Ghost"]);
    expect(loadUsersInfo).toHaveBeenCalledTimes(2);

    vi.setSystemTime(1_000_000 + 30_001 + 4 * 60 * 1000);
    await store.loadUsersBatch(["Ghost"]);
    expect(loadUsersInfo).toHaveBeenCalledTimes(2);
  });

  it("asks again after the TTL — the account may have registered since", async () => {
    profiles.Late = null;
    await store.loadUsersBatch(["Late"]);
    vi.setSystemTime(1_000_000 + 30_001);
    await store.loadUsersBatch(["Late"]);
    vi.setSystemTime(1_000_000 + 30_001 + 5 * 60 * 1000 + 1);
    profiles.Late = { name: "Late" };
    await store.loadUsersBatch(["Late"]);
    expect(loadUsersInfo).toHaveBeenCalledTimes(3);
    expect(store.users.Late?.name).toBe("Late");
  });

  it("does not record a network failure as a missing profile", async () => {
    loadUsersInfo.mockRejectedValueOnce(new Error("offline"));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await store.loadUsersBatch(["Flaky"]);
    profiles.Flaky = { name: "Flaky" };
    await store.loadUsersBatch(["Flaky"]);
    expect(loadUsersInfo).toHaveBeenCalledTimes(2);
    expect(store.users.Flaky?.name).toBe("Flaky");
  });

  it("still loads the other addresses of a batch", async () => {
    profiles.Ghost = null;
    await store.loadUsersBatch(["Ghost"]);
    profiles.Alice = { name: "Alice" };
    await store.loadUsersBatch(["Ghost", "Alice"]);
    expect(loadUsersInfo).toHaveBeenLastCalledWith(["Alice"]);
    expect(store.users.Alice?.name).toBe("Alice");
  });
});
