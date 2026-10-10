import { describe, it, expect } from "vitest";
import { toBastyonCollectionData } from "./bastyon-collection";

const TXID = "a".repeat(64);

describe("toBastyonCollectionData", () => {
  it("maps a vendor pCollection to preview data, description from settings.m", () => {
    expect(
      toBastyonCollectionData(TXID, {
        txid: TXID,
        address: "PAuthor",
        caption: "My collection",
        image: "https://img/1.jpg",
        settings: { m: "About it" },
        contentIds: ["b".repeat(64), "c".repeat(64)],
      }),
    ).toEqual({
      txid: TXID,
      address: "PAuthor",
      caption: "My collection",
      description: "About it",
      image: "https://img/1.jpg",
      contentCount: 2,
      deleted: false,
    });
  });

  it("decodes entities left by the vendor xss cleaning (Vue renders text)", () => {
    const data = toBastyonCollectionData(TXID, {
      caption: "Tom &amp; Jerry",
      settings: { m: "a &lt; b" },
    });
    expect(data.caption).toBe("Tom & Jerry");
    expect(data.description).toBe("a < b");
  });

  it("tolerates missing and malformed fields", () => {
    expect(
      toBastyonCollectionData(TXID, { settings: null, contentIds: "not-an-array", deleted: true }),
    ).toEqual({
      txid: TXID,
      address: "",
      caption: "",
      description: "",
      image: "",
      contentCount: 0,
      deleted: true,
    });
  });
});
