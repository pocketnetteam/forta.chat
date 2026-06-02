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
    this.version(1).stores({ callProviders: "++id, kind" });
  }
}

function makeProvider(overrides: Partial<CallProvider> = {}): Omit<CallProvider, "id"> {
  return {
    kind: "zoom",
    label: "Test Zoom",
    urlTemplate: "https://zoom.us/j/123",
    isDefault: false,
    ...overrides,
  };
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
    await repo.add(makeProvider({ kind: "zoom", isDefault: true }));
    const all = await repo.toArray();
    expect(all).toHaveLength(1);
    expect(all[0].kind).toBe("zoom");
    expect(all[0].isDefault).toBe(true);
  });

  it("keeps at most one default when adding", async () => {
    await repo.add(makeProvider({ label: "A", isDefault: true }));
    await repo.add(makeProvider({ label: "B", isDefault: true }));
    const all = await repo.toArray();
    const defaults = all.filter((p) => p.isDefault);
    expect(defaults).toHaveLength(1);
    expect(defaults[0].label).toBe("B");
  });

  it("getDefault returns the marked provider or undefined", async () => {
    expect(await repo.getDefault()).toBeUndefined();
    await repo.add(makeProvider({ label: "X", isDefault: true }));
    expect((await repo.getDefault())?.label).toBe("X");
  });

  it("setDefault promotes one and demotes the rest", async () => {
    const idA = await repo.add(makeProvider({ label: "A", isDefault: true }));
    const idB = await repo.add(makeProvider({ label: "B", isDefault: false }));
    await repo.setDefault(idB);
    const all = await repo.toArray();
    expect(all.find((p) => p.id === idA)?.isDefault).toBe(false);
    expect(all.find((p) => p.id === idB)?.isDefault).toBe(true);
  });

  it("update patches fields and re-points default", async () => {
    const idA = await repo.add(makeProvider({ label: "A", isDefault: true }));
    const idB = await repo.add(makeProvider({ label: "B", isDefault: false }));
    await repo.update(idB, { label: "B2", isDefault: true });
    const all = await repo.toArray();
    expect(all.find((p) => p.id === idB)?.label).toBe("B2");
    expect(all.find((p) => p.id === idA)?.isDefault).toBe(false);
    expect(all.find((p) => p.id === idB)?.isDefault).toBe(true);
  });

  it("delete removes a provider", async () => {
    const id = await repo.add(makeProvider());
    await repo.delete(id);
    expect(await repo.toArray()).toHaveLength(0);
  });

  // ── Privacy regression (A2) ──────────────────────────────────────────
  // Provider config must never leave the device. The repository is the only
  // storage path; assert its source never reaches Matrix account_data or the
  // Pocketnet backend. A future edit that wires a server write here fails.
  it("never persists provider config to Matrix / Pocketnet", () => {
    const src = readFileSync(
      resolve(process.cwd(), "src/shared/lib/local-db/call-providers-repository.ts"),
      "utf8",
    );
    // Strip comments so the documented privacy contract (which mentions these
    // words deliberately) doesn't trip the guard — we check executable code.
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
    expect(code).not.toMatch(/\.setAccountData\b/);          // no Matrix account_data write
    expect(code).not.toMatch(/\bsendStateEvent\b/);          // no Matrix state write
    expect(code).not.toMatch(/from\s+["'][^"']*matrix[^"']*["']/i); // no Matrix import
    expect(code).not.toMatch(/pocketnet/i);                  // no Pocketnet backend call
  });
});
