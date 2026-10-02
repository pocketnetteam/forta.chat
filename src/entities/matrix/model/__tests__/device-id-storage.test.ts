// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from "vitest";
import {
  getStoredDeviceId,
  storeDeviceId,
  clearStoredDeviceId,
} from "../device-id-storage";

describe("device-id-storage", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  describe("getStoredDeviceId", () => {
    it("returns undefined when nothing is stored for the address", () => {
      expect(getStoredDeviceId("addr1")).toBeUndefined();
    });

    it("returns the stored value when present", () => {
      localStorage.setItem("matrix_device_id:addr1", "ABCDEF");
      expect(getStoredDeviceId("addr1")).toBe("ABCDEF");
    });

    it("returns undefined for empty address (defensive)", () => {
      localStorage.setItem("matrix_device_id:", "X");
      expect(getStoredDeviceId("")).toBeUndefined();
    });

    it("is scoped per account — another address is not returned", () => {
      localStorage.setItem("matrix_device_id:addr1", "DEV_A");
      localStorage.setItem("matrix_device_id:addr2", "DEV_B");
      expect(getStoredDeviceId("addr1")).toBe("DEV_A");
      expect(getStoredDeviceId("addr2")).toBe("DEV_B");
    });
  });

  describe("storeDeviceId", () => {
    it("persists the device_id under a per-account key", () => {
      storeDeviceId("addr1", "DEV_A");
      expect(localStorage.getItem("matrix_device_id:addr1")).toBe("DEV_A");
    });

    it("overwrites an existing value for the same address", () => {
      storeDeviceId("addr1", "OLD");
      storeDeviceId("addr1", "NEW");
      expect(getStoredDeviceId("addr1")).toBe("NEW");
    });

    it("is a no-op when the address is empty", () => {
      storeDeviceId("", "DEV_A");
      expect(localStorage.getItem("matrix_device_id:")).toBeNull();
    });

    it("is a no-op when the device_id is empty", () => {
      // Pre-seed — empty device_id must never overwrite an existing entry
      localStorage.setItem("matrix_device_id:addr1", "EXISTING");
      storeDeviceId("addr1", "");
      expect(getStoredDeviceId("addr1")).toBe("EXISTING");
    });

    it("does not leak values across accounts", () => {
      storeDeviceId("addr1", "DEV_A");
      storeDeviceId("addr2", "DEV_B");
      expect(getStoredDeviceId("addr1")).toBe("DEV_A");
      expect(getStoredDeviceId("addr2")).toBe("DEV_B");
    });
  });

  describe("clearStoredDeviceId", () => {
    it("removes the persisted entry for the address", () => {
      storeDeviceId("addr1", "DEV_A");
      clearStoredDeviceId("addr1");
      expect(getStoredDeviceId("addr1")).toBeUndefined();
      expect(localStorage.getItem("matrix_device_id:addr1")).toBeNull();
    });

    it("does not touch other accounts", () => {
      storeDeviceId("addr1", "DEV_A");
      storeDeviceId("addr2", "DEV_B");
      clearStoredDeviceId("addr1");
      expect(getStoredDeviceId("addr1")).toBeUndefined();
      expect(getStoredDeviceId("addr2")).toBe("DEV_B");
    });

    it("is a no-op for empty address", () => {
      storeDeviceId("addr1", "DEV_A");
      clearStoredDeviceId("");
      expect(getStoredDeviceId("addr1")).toBe("DEV_A");
    });
  });

  describe("round-trip", () => {
    it("store then get returns the same value", () => {
      storeDeviceId("PPVgnH4N22yriNu9HsvViXjshNFy3BLqoJ", "HXZVWBNWCJ");
      expect(getStoredDeviceId("PPVgnH4N22yriNu9HsvViXjshNFy3BLqoJ")).toBe(
        "HXZVWBNWCJ",
      );
    });
  });
});
