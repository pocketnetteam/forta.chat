import type { FileInfo } from "@/entities/chat/model/types";

export interface ExternalShareSendDeps {
  readBlob: (uri: string, mimeType: string) => Promise<Blob>;
  sendImage: (file: File, options?: { caption?: string }) => Promise<boolean>;
  sendFile: (file: File) => Promise<boolean>;
  sendText: (text: string) => Promise<boolean>;
}

export interface ExternalShareSendResult {
  sent: number;
  /** Files that didn't go out — kept on the share so Send can retry just them. */
  failedFiles: FileInfo[];
}

/** Upload the files of an external share into the active room.
 *
 *  Files go one at a time — keeps their order and avoids N parallel
 *  reads/encrypts on low-RAM devices. A single image carries the typed
 *  caption inline like a normal photo send; otherwise the caption follows
 *  the files as its own message (only if at least one file went out). */
export async function sendExternalShareFiles(
  files: FileInfo[],
  caption: string,
  deps: ExternalShareSendDeps,
): Promise<ExternalShareSendResult> {
  const trimmed = caption.trim();
  const isImage = (f: FileInfo): boolean => f.type.startsWith("image/");
  const inlineCaption = files.length === 1 && isImage(files[0]) ? trimmed : "";

  let sent = 0;
  const failedFiles: FileInfo[] = [];
  for (const info of files) {
    try {
      const mime = info.type || "application/octet-stream";
      const blob = await deps.readBlob(info.url, mime);
      const file = new File([blob], info.name || "shared_file", { type: mime });
      const ok = isImage(info)
        ? await deps.sendImage(file, inlineCaption ? { caption: inlineCaption } : {})
        : await deps.sendFile(file);
      if (ok) sent++;
      else failedFiles.push(info);
    } catch (e) {
      console.error("[external-share] failed to send shared file:", e);
      failedFiles.push(info);
    }
  }

  if (trimmed && !inlineCaption && sent > 0) {
    await deps.sendText(trimmed);
  }
  return { sent, failedFiles };
}
