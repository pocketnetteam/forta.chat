import { describe, it, expect } from "vitest";
import { buildExternalShareForward, narrowExternalShareForward } from "./external-share-forward";
import { MessageType } from "../model/types";

const png = (name: string) => ({ uri: `/c/${name}`, name, mimeType: "image/png" });

describe("buildExternalShareForward", () => {
  it("builds a text forward for a text-only share", () => {
    const fwd = buildExternalShareForward({ text: "https://example.com" }, 1);

    expect(fwd).toMatchObject({
      id: "__external_share_1",
      roomId: "__external_share__",
      content: "https://example.com",
      type: MessageType.text,
      isExternalShare: true,
      withSenderInfo: false,
    });
    expect(fwd.fileInfo).toBeUndefined();
    expect(fwd.externalFiles).toBeUndefined();
  });

  it("maps a single screenshot to an image forward", () => {
    const fwd = buildExternalShareForward({ files: [png("Screenshot.png")] });

    expect(fwd.type).toBe(MessageType.image);
    expect(fwd.content).toBe("Screenshot.png");
    expect(fwd.fileInfo).toEqual({ url: "/c/Screenshot.png", name: "Screenshot.png", type: "image/png", size: 0 });
    expect(fwd.externalFiles).toHaveLength(1);
  });

  it("maps a single video to a video forward", () => {
    const fwd = buildExternalShareForward({ files: [{ uri: "/c/v.mp4", name: "v.mp4", mimeType: "video/mp4" }] });
    expect(fwd.type).toBe(MessageType.video);
  });

  it("keeps every file of a multi-image share", () => {
    const fwd = buildExternalShareForward({ files: [png("a.png"), png("b.png"), png("c.png")] });

    expect(fwd.type).toBe(MessageType.image);
    expect(fwd.externalFiles?.map((f) => f.name)).toEqual(["a.png", "b.png", "c.png"]);
    expect(fwd.fileInfo?.name).toBe("a.png");
  });

  it("treats a mixed multi-file share as files", () => {
    const fwd = buildExternalShareForward({
      files: [png("a.png"), { uri: "/c/doc.pdf", name: "doc.pdf", mimeType: "application/pdf" }],
    });
    expect(fwd.type).toBe(MessageType.file);
  });

  it("narrows a partially-sent share to the failed files and re-derives the type", () => {
    const fwd = buildExternalShareForward({
      text: "note",
      files: [png("a.png"), { uri: "/c/doc.pdf", name: "doc.pdf", mimeType: "application/pdf" }, png("b.png")],
    });
    const remaining = [fwd.externalFiles![0], fwd.externalFiles![2]];

    const narrowed = narrowExternalShareForward(fwd, remaining);

    expect(narrowed.externalFiles).toEqual(remaining);
    expect(narrowed.fileInfo).toBe(remaining[0]);
    expect(narrowed.type).toBe(MessageType.image);
    expect(narrowed).toMatchObject({ id: fwd.id, isExternalShare: true, content: "note" });
  });

  it("fills defaults for a nameless / typeless file", () => {
    const fwd = buildExternalShareForward({ files: [{ uri: "/c/x", name: "", mimeType: "" }] });
    expect(fwd.fileInfo).toMatchObject({ name: "shared_file", type: "application/octet-stream" });
    expect(fwd.type).toBe(MessageType.file);
  });
});
