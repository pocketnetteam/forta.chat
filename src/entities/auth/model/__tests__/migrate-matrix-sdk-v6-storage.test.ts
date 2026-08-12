import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { migrateMatrixSdkV6Storage } from "../storage-migration";

/**
 * Regression (code review on the lazyLoadMembers fix): renaming the Matrix
 * JS SDK's IndexedDBStore from "matrix-js-sdk-v6:*" to "matrix-js-sdk-v7:*"
 * (matrix-client.ts) forces every client onto a fresh sync store, but never
 * deleted the superseded v6 database — it would sit on disk forever on every
 * existing install, unlike the sibling migrateCryptoStorage() which does
 * clean up its superseded databases.
 */
describe("migrateMatrixSdkV6Storage", () => {
  let originalIndexedDB: typeof indexedDB | undefined;
  let deleteDatabaseSpy: ReturnType<typeof vi.fn>;
  let databasesMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    originalIndexedDB = window.indexedDB;
    deleteDatabaseSpy = vi.fn();
    databasesMock = vi.fn();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).indexedDB = {
      databases: databasesMock,
      deleteDatabase: deleteDatabaseSpy,
    };
  });

  afterEach(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).indexedDB = originalIndexedDB;
  });

  it("deletes every database whose name starts with matrix-js-sdk-v6:", async () => {
    databasesMock.mockResolvedValue([
      { name: "matrix-js-sdk-v6:hexaddr1" },
      { name: "matrix-js-sdk-v6:hexaddr2" },
      { name: "matrix-js-sdk-v7:hexaddr1" },
      { name: "psdk_production" },
    ]);

    await migrateMatrixSdkV6Storage();

    expect(deleteDatabaseSpy).toHaveBeenCalledTimes(2);
    expect(deleteDatabaseSpy).toHaveBeenCalledWith("matrix-js-sdk-v6:hexaddr1");
    expect(deleteDatabaseSpy).toHaveBeenCalledWith("matrix-js-sdk-v6:hexaddr2");
    expect(deleteDatabaseSpy).not.toHaveBeenCalledWith("matrix-js-sdk-v7:hexaddr1");
  });

  it("does nothing when no v6 database exists", async () => {
    databasesMock.mockResolvedValue([{ name: "matrix-js-sdk-v7:hexaddr1" }]);

    await migrateMatrixSdkV6Storage();

    expect(deleteDatabaseSpy).not.toHaveBeenCalled();
  });

  it("is a no-op when indexedDB.databases() is unavailable (e.g. Safari)", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).indexedDB = { deleteDatabase: deleteDatabaseSpy };

    await expect(migrateMatrixSdkV6Storage()).resolves.toBeUndefined();
    expect(deleteDatabaseSpy).not.toHaveBeenCalled();
  });

  it("swallows errors from a failed databases() enumeration", async () => {
    databasesMock.mockRejectedValue(new Error("boom"));

    await expect(migrateMatrixSdkV6Storage()).resolves.toBeUndefined();
  });
});
