import { describe, it, expect, beforeEach } from "vitest";

import {
  readSelfProfile,
  writeSelfProfile,
  clearSelfProfile,
  purgeEmptySelfProfiles,
  mergeSelfProfileWithRemote,
  SELF_PROFILE_GRACE_MS,
  type SelfProfileSnapshot,
} from "../self-profile-cache";
import type { UserData } from "@/app/providers/initializers/types";

const ADDR = "PSelfProfileTestAddrXXXXXXXXXXXXXXXX";

function makeSnapshot(overrides: Partial<SelfProfileSnapshot> = {}): SelfProfileSnapshot {
  return {
    address: ADDR,
    name: "Alice",
    about: "hi",
    image: "https://cdn.example/alice.png",
    site: "https://alice.dev",
    language: "en",
    localEditedAt: 0,
    syncedAt: 0,
    ...overrides,
  };
}

function makeRemote(overrides: Partial<UserData> = {}): UserData {
  return {
    name: "RemoteName",
    about: "remote about",
    image: "https://remote.example/img.png",
    site: "https://remote.example",
    language: "ru",
    addresses: [],
    ref: null,
    keys: [],
    ...overrides,
  } as UserData;
}

describe("self-profile-cache (WEE-26)", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  describe("read/write/clear", () => {
    it("returns null when no snapshot is stored", () => {
      expect(readSelfProfile(ADDR)).toBeNull();
    });

    it("round-trips a snapshot through localStorage", () => {
      const snap = makeSnapshot({ localEditedAt: 1_000, syncedAt: 2_000 });
      writeSelfProfile(snap);
      const restored = readSelfProfile(ADDR);
      expect(restored).toEqual(snap);
    });

    it("does not persist an empty-name snapshot", () => {
      writeSelfProfile(makeSnapshot({ name: "" }));
      expect(readSelfProfile(ADDR)).toBeNull();
      writeSelfProfile(makeSnapshot({ name: "   " }));
      expect(readSelfProfile(ADDR)).toBeNull();
    });

    it("purgeEmptySelfProfiles removes blank-name snapshots", () => {
      localStorage.setItem(
        `forta-chat-self-profile:${ADDR}`,
        JSON.stringify({ address: ADDR, name: "" }),
      );
      expect(purgeEmptySelfProfiles()).toBe(1);
      expect(readSelfProfile(ADDR)).toBeNull();
    });

    it("ignores snapshots whose stored address does not match the lookup key", () => {
      writeSelfProfile(makeSnapshot({ address: ADDR }));
      // Forge a tampered entry under the same key but with a different address.
      const key = `forta-chat-self-profile:${ADDR}`;
      localStorage.setItem(
        key,
        JSON.stringify({ ...makeSnapshot(), address: "PDifferentAddr" }),
      );
      expect(readSelfProfile(ADDR)).toBeNull();
    });

    it("returns null when the stored JSON is corrupt", () => {
      localStorage.setItem(`forta-chat-self-profile:${ADDR}`, "{not-json");
      expect(readSelfProfile(ADDR)).toBeNull();
    });

    it("coerces missing optional fields to empty strings / zero timestamps", () => {
      localStorage.setItem(
        `forta-chat-self-profile:${ADDR}`,
        JSON.stringify({ address: ADDR }),
      );
      const restored = readSelfProfile(ADDR);
      expect(restored).toEqual({
        address: ADDR,
        name: "",
        about: "",
        image: "",
        site: "",
        language: "",
        localEditedAt: 0,
        syncedAt: 0,
      });
    });

    it("clearSelfProfile removes the snapshot", () => {
      writeSelfProfile(makeSnapshot());
      clearSelfProfile(ADDR);
      expect(readSelfProfile(ADDR)).toBeNull();
    });

    it("no-ops on empty address rather than touching storage", () => {
      writeSelfProfile(makeSnapshot({ address: "" }));
      // Nothing got written under any key
      expect(localStorage.length).toBe(0);
      expect(readSelfProfile("")).toBeNull();
      // clear is also safe
      clearSelfProfile("");
    });
  });

  describe("mergeSelfProfileWithRemote", () => {
    it("returns the remote unchanged when no cache exists", () => {
      const remote = makeRemote();
      expect(mergeSelfProfileWithRemote(null, remote)).toEqual(remote);
    });

    it("prefers cached non-empty fields when remote returns empty", () => {
      const cached = makeSnapshot({ localEditedAt: Date.now() });
      const remote = makeRemote({ name: "", image: "", about: "" });
      const merged = mergeSelfProfileWithRemote(cached, remote);
      expect(merged.name).toBe("Alice");
      expect(merged.image).toBe("https://cdn.example/alice.png");
      expect(merged.about).toBe("hi");
      // Authoritative remote fields untouched
      expect(merged.addresses).toEqual(remote.addresses);
      expect(merged.keys).toEqual(remote.keys);
    });

    it("prefers cached values when local edit is within grace window and remote disagrees", () => {
      const now = 1_000_000_000;
      const cached = makeSnapshot({
        name: "Alice",
        localEditedAt: now - 60_000, // 1 minute ago — well within grace
      });
      const remote = makeRemote({ name: "OldPocketnetName" });
      const merged = mergeSelfProfileWithRemote(cached, remote, now);
      expect(merged.name).toBe("Alice");
    });

    it("accepts the remote value once the propagation grace window elapses", () => {
      const now = 1_000_000_000;
      const cached = makeSnapshot({
        name: "Alice",
        localEditedAt: now - SELF_PROFILE_GRACE_MS - 1,
      });
      const remote = makeRemote({ name: "NewBlockchainName" });
      const merged = mergeSelfProfileWithRemote(cached, remote, now);
      expect(merged.name).toBe("NewBlockchainName");
    });

    it("treats localEditedAt=0 as 'never edited locally' so remote always wins on conflict", () => {
      const cached = makeSnapshot({ name: "InheritedFromSync", localEditedAt: 0 });
      const remote = makeRemote({ name: "BlockchainName" });
      const merged = mergeSelfProfileWithRemote(cached, remote);
      expect(merged.name).toBe("BlockchainName");
    });

    it("falls back to cached value even with localEditedAt=0 if remote field is empty", () => {
      const cached = makeSnapshot({ name: "Alice", localEditedAt: 0 });
      const remote = makeRemote({ name: "" });
      const merged = mergeSelfProfileWithRemote(cached, remote);
      expect(merged.name).toBe("Alice");
    });

    it("does not back-fill an empty cached field with a remote empty value", () => {
      const cached = makeSnapshot({ about: "", localEditedAt: Date.now() });
      const remote = makeRemote({ about: "" });
      expect(mergeSelfProfileWithRemote(cached, remote).about).toBe("");
    });

    it("merges field-by-field — different fields can take different sources", () => {
      const now = 1_000_000_000;
      const cached = makeSnapshot({
        name: "Alice",
        about: "hi",
        image: "https://cdn/alice.png",
        site: "",
        language: "",
        localEditedAt: now - 60_000,
      });
      const remote = makeRemote({
        name: "OldName",
        about: "",
        image: "",
        site: "https://remote.site",
        language: "ru",
      });
      const merged = mergeSelfProfileWithRemote(cached, remote, now);
      expect(merged.name).toBe("Alice");
      expect(merged.about).toBe("hi");
      expect(merged.image).toBe("https://cdn/alice.png");
      expect(merged.site).toBe("https://remote.site");
      expect(merged.language).toBe("ru");
    });
  });
});
