import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import Dexie from "dexie";
import "fake-indexeddb/auto";
import { CallProvidersRepository } from "../call-providers-repository";
import type { CallProvider } from "../schema";

// Minimal in-memory Dexie mirroring the v17 callProviders store.
class TestDb extends Dexie {
  callProviders!: import("dexie").Table<CallProvider, number>;
  constructor() {
    super("test-call-providers", { indexedDB, IDBKeyRange });
    this.version(1).stores({ callProviders: "++id" });
  }
}

function makeProvider(overrides: Partial<CallProvider> = {}): Omit<CallProvider, "id"> {
  return { label: "Test Zoom", urlTemplate: "https://zoom.us/j/123", ...overrides };
}

describe("CallProvidersRepository", () => {
  let db: TestDb;
  let repo: CallProvidersRepository;

  beforeEach(() => {
    db = new TestDb();
    repo = new CallProvidersRepository(db as never);
  });

  afterEach(async () => {
    await db.delete();
  });

  it("saves a provider and reads it back", async () => {
    await repo.add(makeProvider({ label: "Zoom" }));
    const all = await repo.toArray();
    expect(all).toHaveLength(1);
    expect(all[0].label).toBe("Zoom");
    expect(all[0].urlTemplate).toBe("https://zoom.us/j/123");
  });

  it("keeps multiple providers in insertion order", async () => {
    await repo.add(makeProvider({ label: "A" }));
    await repo.add(makeProvider({ label: "B" }));
    const all = await repo.toArray();
    expect(all.map((p) => p.label)).toEqual(["A", "B"]);
  });

  it("update patches fields", async () => {
    const id = await repo.add(makeProvider({ label: "A" }));
    await repo.update(id, { label: "A2", urlTemplate: "https://meet.example/x" });
    const all = await repo.toArray();
    expect(all[0].label).toBe("A2");
    expect(all[0].urlTemplate).toBe("https://meet.example/x");
  });

  it("delete removes a provider", async () => {
    const id = await repo.add(makeProvider());
    await repo.delete(id);
    expect(await repo.toArray()).toHaveLength(0);
  });

  // ── Privacy regression (A2) ──────────────────────────────────────────
  // Provider config must never leave the device. The repository is the only
  // storage path; assert its executable code never reaches Matrix account
  // data or the Pocketnet backend. A future server write here fails this.
  it("never persists provider config to Matrix / Pocketnet", () => {
    const src = readFileSync(
      resolve(process.cwd(), "src/shared/lib/local-db/call-providers-repository.ts"),
      "utf8",
    );
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
    expect(code).not.toMatch(/\.setAccountData\b/);
    expect(code).not.toMatch(/\bsendStateEvent\b/);
    expect(code).not.toMatch(/from\s+["'][^"']*matrix[^"']*["']/i);
    expect(code).not.toMatch(/pocketnet/i);
  });
});
