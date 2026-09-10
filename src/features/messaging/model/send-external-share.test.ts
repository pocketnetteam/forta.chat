import { describe, it, expect, vi } from "vitest";
import { sendExternalShareFiles, type ExternalShareSendDeps } from "./send-external-share";
import type { FileInfo } from "@/entities/chat/model/types";

const info = (name: string, type: string): FileInfo => ({ url: `/c/${name}`, name, type, size: 0 });

function makeDeps(overrides: Partial<ExternalShareSendDeps> = {}) {
  const calls: string[] = [];
  const deps: ExternalShareSendDeps = {
    readBlob: vi.fn(async (_uri: string, mime: string) => new Blob(["x"], { type: mime })),
    sendImage: vi.fn(async (file: File) => {
      calls.push(`image:${file.name}`);
      return true;
    }),
    sendFile: vi.fn(async (file: File) => {
      calls.push(`file:${file.name}`);
      return true;
    }),
    sendText: vi.fn(async (text: string) => {
      calls.push(`text:${text}`);
      return true;
    }),
    ...overrides,
  };
  return { deps, calls };
}

describe("sendExternalShareFiles", () => {
  it("sends a single screenshot as an image with the typed caption inline", async () => {
    const { deps, calls } = makeDeps();

    const result = await sendExternalShareFiles([info("shot.png", "image/png")], "  look  ", deps);

    expect(result).toEqual({ sent: 1, failedFiles: [] });
    expect(deps.sendImage).toHaveBeenCalledWith(expect.any(File), { caption: "look" });
    expect(calls).toEqual(["image:shot.png"]);
  });

  it("builds the File with the shared name and explicit mime", async () => {
    const { deps } = makeDeps();

    await sendExternalShareFiles([info("doc.pdf", "application/pdf")], "", deps);

    const file = (deps.sendFile as ReturnType<typeof vi.fn>).mock.calls[0][0] as File;
    expect(file.name).toBe("doc.pdf");
    expect(file.type).toBe("application/pdf");
  });

  it("sends every file in order, then the caption as its own message", async () => {
    const { deps, calls } = makeDeps();

    const result = await sendExternalShareFiles(
      [info("a.png", "image/png"), info("b.mp4", "video/mp4"), info("c.png", "image/png")],
      "trip",
      deps,
    );

    expect(result).toEqual({ sent: 3, failedFiles: [] });
    expect(calls).toEqual(["image:a.png", "file:b.mp4", "image:c.png", "text:trip"]);
    expect(deps.sendImage).toHaveBeenCalledWith(expect.any(File), {});
  });

  it("reports which files failed (read or send) without aborting the rest", async () => {
    const broken = info("broken.png", "image/png");
    const doc = info("doc.pdf", "application/pdf");
    const { deps, calls } = makeDeps({
      readBlob: vi.fn(async (uri: string, mime: string) => {
        if (uri.endsWith("broken.png")) throw new Error("gone");
        return new Blob(["x"], { type: mime });
      }),
    });
    (deps.sendFile as ReturnType<typeof vi.fn>).mockResolvedValueOnce(false);

    const result = await sendExternalShareFiles([broken, doc, info("ok.png", "image/png")], "", deps);

    expect(result).toEqual({ sent: 1, failedFiles: [broken, doc] });
    expect(calls).toEqual(["image:ok.png"]);
  });

  it("does not send the caption when every file failed (the input restores it)", async () => {
    const { deps } = makeDeps({
      readBlob: vi.fn(async () => {
        throw new Error("gone");
      }),
    });

    const result = await sendExternalShareFiles(
      [info("a.png", "image/png"), info("b.png", "image/png")],
      "hello",
      deps,
    );

    expect(result.sent).toBe(0);
    expect(result.failedFiles).toHaveLength(2);
    expect(deps.sendText).not.toHaveBeenCalled();
  });
});
