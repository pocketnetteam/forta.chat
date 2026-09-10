import type { ExternalShareData } from "@/shared/lib/share-target";
import { MessageType, type FileInfo, type ForwardingMessage } from "../model/types";

function typeForFiles(files: FileInfo[]): MessageType {
  if (files.length === 0) return MessageType.text;
  if (files.every((f) => f.type.startsWith("image/"))) return MessageType.image;
  if (files.length === 1 && files[0].type.startsWith("video/")) return MessageType.video;
  return MessageType.file;
}

/** The same external share reduced to `files` — after a partial send, so the
 *  next Send retries only what failed. */
export function narrowExternalShareForward(fwd: ForwardingMessage, files: FileInfo[]): ForwardingMessage {
  return {
    ...fwd,
    type: typeForFiles(files),
    fileInfo: files[0],
    externalFiles: files.length > 0 ? files : undefined,
  };
}

/** Synthetic ForwardingMessage for content arriving from the system Share
 *  Sheet. Every shared file is carried in `externalFiles`; `fileInfo` mirrors
 *  the first one for UI that only understands single-message forwards. */
export function buildExternalShareForward(
  data: ExternalShareData,
  now: number = Date.now(),
): ForwardingMessage {
  const files: FileInfo[] = (data.files ?? []).map((f) => ({
    url: f.uri,
    name: f.name || "shared_file",
    type: f.mimeType || "application/octet-stream",
    size: 0,
  }));
  const first = files[0];

  return {
    id: `__external_share_${now}`,
    roomId: "__external_share__",
    senderId: "",
    content: data.text || first?.name || "",
    type: typeForFiles(files),
    fileInfo: first,
    externalFiles: files.length > 0 ? files : undefined,
    withSenderInfo: false,
    isExternalShare: true,
  };
}
