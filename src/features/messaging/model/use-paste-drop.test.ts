import { describe, it, expect, beforeEach, vi } from "vitest";
import { ref, nextTick } from "vue";
import { usePasteDrop } from "./use-paste-drop";

// ── Helpers ──────────────────────────────────────────────────────

function makeFile(name: string, type: string): File {
  return new File(["content"], name, { type });
}

function makePasteEvent(files?: File[], strings?: Record<string, string>): ClipboardEvent {
  const event = new ClipboardEvent("paste", {
    clipboardData: files ? new DataTransfer() : undefined,
    cancelable: true,
  });
  if (files && event.clipboardData) {
    files.forEach((f) => event.clipboardData!.items.add(f));
    Object.entries(strings ?? {}).forEach(([type, value]) => event.clipboardData!.setData(type, value));
  }
  return event;
}

/** Create a mock DragEvent with proper dataTransfer (JSDOM doesn't support DragEvent init well) */
function makeDragEvent(
  type: string,
  options?: { files?: File[]; textOnly?: boolean },
): DragEvent {
  const event = new Event(type, { bubbles: true, cancelable: true }) as DragEvent;
  const dt = new DataTransfer();
  if (options?.files) {
    options.files.forEach((f) => dt.items.add(f));
  }
  if (options?.textOnly) {
    dt.setData("text/plain", "some text");
  }
  // happy-dom/jsdom doesn't add "Files" to types automatically — patch it
  const types = options?.files?.length
    ? Object.assign(["Files"], { contains: (s: string) => s === "Files" })
    : options?.textOnly
      ? Object.assign(["text/plain"], { contains: (s: string) => s === "text/plain" })
      : Object.assign([] as string[], { contains: () => false });
  Object.defineProperty(dt, "types", { value: types, writable: false });
  Object.defineProperty(event, "dataTransfer", { value: dt, writable: false });
  return event;
}

/**
 * Capture drag handlers registered via addEventListener.
 * The composable uses setupDragListeners which calls el.addEventListener.
 */
function captureHandlers(el: HTMLElement) {
  const handlers: Record<string, EventListener> = {};
  const origAdd = el.addEventListener.bind(el);
  vi.spyOn(el, "addEventListener").mockImplementation((type: string, handler: any) => {
    handlers[type] = handler;
    origAdd(type, handler);
  });
  return handlers;
}

// ─────────────────────────────────────────────────────────────────

describe("usePasteDrop", () => {
  let onMediaFiles: ReturnType<typeof vi.fn<(files: File[]) => void>>;
  let onOtherFiles: ReturnType<typeof vi.fn<(files: File[]) => void>>;

  beforeEach(() => {
    onMediaFiles = vi.fn<(files: File[]) => void>();
    onOtherFiles = vi.fn<(files: File[]) => void>();
  });

  function setup() {
    return usePasteDrop({ onMediaFiles, onOtherFiles });
  }

  // ─── File classification ────────────────────────────────────────

  describe("file classification via paste", () => {
    it("routes image files to onMediaFiles", () => {
      const { handlePaste } = setup();
      const png = makeFile("photo.png", "image/png");
      handlePaste(makePasteEvent([png]));

      expect(onMediaFiles).toHaveBeenCalledWith([png]);
      expect(onOtherFiles).not.toHaveBeenCalled();
    });

    it("routes video files to onMediaFiles", () => {
      const { handlePaste } = setup();
      const mp4 = makeFile("clip.mp4", "video/mp4");
      handlePaste(makePasteEvent([mp4]));

      expect(onMediaFiles).toHaveBeenCalledWith([mp4]);
      expect(onOtherFiles).not.toHaveBeenCalled();
    });

    it("routes non-media files to onOtherFiles", () => {
      const { handlePaste } = setup();
      const pdf = makeFile("doc.pdf", "application/pdf");
      handlePaste(makePasteEvent([pdf]));

      expect(onOtherFiles).toHaveBeenCalledWith([pdf]);
      expect(onMediaFiles).not.toHaveBeenCalled();
    });

    it("splits mixed files into media and other", () => {
      const { handlePaste } = setup();
      const jpg = makeFile("photo.jpg", "image/jpeg");
      const webm = makeFile("video.webm", "video/webm");
      const zip = makeFile("archive.zip", "application/zip");
      const txt = makeFile("readme.txt", "text/plain");
      handlePaste(makePasteEvent([jpg, webm, zip, txt]));

      expect(onMediaFiles).toHaveBeenCalledWith([jpg, webm]);
      expect(onOtherFiles).toHaveBeenCalledWith([zip, txt]);
    });

    it("handles multiple images correctly", () => {
      const { handlePaste } = setup();
      const a = makeFile("a.png", "image/png");
      const b = makeFile("b.gif", "image/gif");
      const c = makeFile("c.webp", "image/webp");
      handlePaste(makePasteEvent([a, b, c]));

      expect(onMediaFiles).toHaveBeenCalledWith([a, b, c]);
      expect(onOtherFiles).not.toHaveBeenCalled();
    });
  });

  // ─── Paste event handling ───────────────────────────────────────

  describe("handlePaste", () => {
    it("prevents default when files are present", () => {
      const { handlePaste } = setup();
      const event = makePasteEvent([makeFile("a.png", "image/png")]);
      const spy = vi.spyOn(event, "preventDefault");

      handlePaste(event);

      expect(spy).toHaveBeenCalled();
    });

    it("does nothing when clipboardData has no files", () => {
      const { handlePaste } = setup();
      handlePaste(makePasteEvent([]));

      expect(onMediaFiles).not.toHaveBeenCalled();
      expect(onOtherFiles).not.toHaveBeenCalled();
    });

    it("pastes text, not the bitmap preview, when copying Excel cells", () => {
      const { handlePaste } = setup();
      const event = makePasteEvent([makeFile("image.png", "image/png")], {
        "text/plain": "42\t=SUM(A1:A3)\n",
        "text/html": "<table><tr><td>42</td></tr></table>",
      });
      const spy = vi.spyOn(event, "preventDefault");

      handlePaste(event);

      expect(spy).not.toHaveBeenCalled();
      expect(onMediaFiles).not.toHaveBeenCalled();
      expect(onOtherFiles).not.toHaveBeenCalled();
    });

    it("pastes text when clipboard has RTF + plain text + image (Word)", () => {
      const { handlePaste } = setup();
      handlePaste(makePasteEvent([makeFile("image.png", "image/png")], {
        "text/plain": "hello",
        "text/rtf": "{\\rtf1 hello}",
      }));

      expect(onMediaFiles).not.toHaveBeenCalled();
    });

    it("still attaches an image copied from a browser (html, no plain text)", () => {
      const { handlePaste } = setup();
      const png = makeFile("image.png", "image/png");
      handlePaste(makePasteEvent([png], { "text/html": "<img src=\"x.png\">" }));

      expect(onMediaFiles).toHaveBeenCalledWith([png]);
    });

    it("still attaches a file copied from a file manager (plain-text name only)", () => {
      const { handlePaste } = setup();
      const png = makeFile("photo.png", "image/png");
      handlePaste(makePasteEvent([png], { "text/plain": "photo.png" }));

      expect(onMediaFiles).toHaveBeenCalledWith([png]);
    });

    it("does nothing when clipboardData is undefined", () => {
      const { handlePaste } = setup();
      handlePaste(new ClipboardEvent("paste"));

      expect(onMediaFiles).not.toHaveBeenCalled();
      expect(onOtherFiles).not.toHaveBeenCalled();
    });
  });

  // ─── Drag state management ─────────────────────────────────────

  describe("drag state (isDragging + counter)", () => {
    function setupWithElement() {
      const result = setup();
      const el = document.createElement("div");
      const handlers = captureHandlers(el);
      const elRef = ref<HTMLElement | undefined>(el);
      result.setupDragListeners(elRef);
      return { ...result, el, handlers };
    }

    it("sets isDragging=true on dragenter with Files", () => {
      const { isDragging, handlers } = setupWithElement();
      handlers.dragenter(makeDragEvent("dragenter", { files: [makeFile("a.png", "image/png")] }));

      expect(isDragging.value).toBe(true);
    });

    it("stays isDragging=true when entering nested child elements", () => {
      const { isDragging, handlers } = setupWithElement();
      const fileOpts = { files: [makeFile("a.png", "image/png")] };

      // Enter parent (counter=1), enter child (counter=2)
      handlers.dragenter(makeDragEvent("dragenter", fileOpts));
      handlers.dragenter(makeDragEvent("dragenter", fileOpts));
      expect(isDragging.value).toBe(true);

      // Leave child (counter=1) — still dragging
      handlers.dragleave(makeDragEvent("dragleave"));
      expect(isDragging.value).toBe(true);
    });

    it("sets isDragging=false when all drag-leaves match drag-enters", () => {
      const { isDragging, handlers } = setupWithElement();
      const fileOpts = { files: [makeFile("a.png", "image/png")] };

      handlers.dragenter(makeDragEvent("dragenter", fileOpts));
      handlers.dragenter(makeDragEvent("dragenter", fileOpts));
      handlers.dragleave(makeDragEvent("dragleave"));
      handlers.dragleave(makeDragEvent("dragleave"));

      expect(isDragging.value).toBe(false);
    });

    it("resets isDragging on drop", () => {
      const { isDragging, handlers } = setupWithElement();
      handlers.dragenter(makeDragEvent("dragenter", { files: [makeFile("a.png", "image/png")] }));
      expect(isDragging.value).toBe(true);

      handlers.drop(makeDragEvent("drop", { files: [makeFile("a.png", "image/png")] }));
      expect(isDragging.value).toBe(false);
    });

    it("routes dropped files correctly", () => {
      const { handlers } = setupWithElement();
      const jpg = makeFile("photo.jpg", "image/jpeg");
      const pdf = makeFile("doc.pdf", "application/pdf");

      handlers.drop(makeDragEvent("drop", { files: [jpg, pdf] }));

      expect(onMediaFiles).toHaveBeenCalledWith([jpg]);
      expect(onOtherFiles).toHaveBeenCalledWith([pdf]);
    });

    it("does nothing on drop with no files", () => {
      const { isDragging, handlers } = setupWithElement();
      handlers.dragenter(makeDragEvent("dragenter", { files: [makeFile("a.png", "image/png")] }));
      handlers.drop(makeDragEvent("drop"));

      expect(isDragging.value).toBe(false);
      expect(onMediaFiles).not.toHaveBeenCalled();
      expect(onOtherFiles).not.toHaveBeenCalled();
    });

    it("does not activate isDragging for non-File drags (text-only)", () => {
      const { isDragging, handlers } = setupWithElement();
      handlers.dragenter(makeDragEvent("dragenter", { textOnly: true }));

      expect(isDragging.value).toBe(false);
    });
  });

  // ─── dragover ──────────────────────────────────────────────────

  describe("handleDragOver", () => {
    it("sets dropEffect to copy", () => {
      const result = setup();
      const el = document.createElement("div");
      const handlers = captureHandlers(el);
      const elRef = ref<HTMLElement | undefined>(el);
      result.setupDragListeners(elRef);

      const event = makeDragEvent("dragover");
      handlers.dragover(event);

      expect(event.dataTransfer!.dropEffect).toBe("copy");
    });
  });

  // ─── Listener cleanup ──────────────────────────────────────────

  describe("setupDragListeners cleanup", () => {
    it("removes listeners when ref becomes undefined", async () => {
      const result = setup();
      const el = document.createElement("div");
      const removeSpy = vi.spyOn(el, "removeEventListener");
      const elRef = ref<HTMLElement | undefined>(el);
      result.setupDragListeners(elRef);

      elRef.value = undefined;
      await nextTick();

      expect(removeSpy).toHaveBeenCalledWith("dragenter", expect.any(Function));
      expect(removeSpy).toHaveBeenCalledWith("dragover", expect.any(Function));
      expect(removeSpy).toHaveBeenCalledWith("dragleave", expect.any(Function));
      expect(removeSpy).toHaveBeenCalledWith("drop", expect.any(Function));
    });

    it("reattaches listeners when ref changes to a new element", async () => {
      const result = setup();
      const el1 = document.createElement("div");
      const el2 = document.createElement("div");
      const removeSpy1 = vi.spyOn(el1, "removeEventListener");
      const addSpy2 = vi.spyOn(el2, "addEventListener");
      const elRef = ref<HTMLElement | undefined>(el1);
      result.setupDragListeners(elRef);

      elRef.value = el2;
      await nextTick();

      expect(removeSpy1).toHaveBeenCalledWith("dragenter", expect.any(Function));
      expect(addSpy2).toHaveBeenCalledWith("dragenter", expect.any(Function));
    });
  });
});
