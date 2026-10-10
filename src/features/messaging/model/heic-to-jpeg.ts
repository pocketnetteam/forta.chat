/** Whether a file is HEIC/HEIF (iPhone camera default), by type or name. */
export function isHeicFile(file: File): boolean {
  return /image\/(heic|heif)/i.test(file.type) || /\.(heic|heif)$/i.test(file.name);
}

/** Convert HEIC/HEIF File to JPEG so Android WebView (Chromium) can render it.
 *  iPhone cameras default to HEIC; Chromium does not support HEIC in <img>,
 *  resulting in a broken image on the receiver side. heic2any is loaded
 *  dynamically (~340 KB gzipped chunk) only on the first HEIC encounter.
 *  Returns the original file when the input is not HEIC/HEIF, or when
 *  conversion fails (fail-open: better to send the original than nothing). */
export async function convertHeicToJpeg(file: File): Promise<File> {
  if (!isHeicFile(file)) return file;

  try {
    const heic2any = (await import("heic2any")).default;
    const result = await heic2any({
      blob: file,
      toType: "image/jpeg",
      quality: 0.85,
    });
    const jpegBlob = Array.isArray(result) ? result[0] : (result as Blob);
    const newName = file.name.replace(/\.(heic|heif)$/i, ".jpg");
    return new File([jpegBlob], newName, { type: "image/jpeg" });
  } catch (e) {
    console.warn("[convertHeicToJpeg] conversion failed, sending original:", e);
    return file; // fail-open
  }
}
