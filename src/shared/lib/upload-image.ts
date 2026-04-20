const UPLOAD_URL = "https://pocketnet.app:8092/up";
const IMAGE_BASE_URL = "https://pocketnet.app:8092/i/";
const API_KEY = "c61540b5ceecd05092799f936e277552";
const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5 MB

/** Max dimension on first compression attempt (longest side in px). */
const COMPRESS_MAX_SIDE_PRIMARY = 2048;
/** Fallback max dimension if quality=0.5 still exceeds limit. */
const COMPRESS_MAX_SIDE_FALLBACK = 1536;
/** JPEG quality steps tried in order. */
const COMPRESS_QUALITY_STEPS = [0.85, 0.75, 0.65, 0.5];

export class ImageUploadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImageUploadError";
  }
}

function loadImage(src: string): Promise<{ w: number; h: number; img: HTMLImageElement }> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight, img });
    img.onerror = () => reject(new ImageUploadError("Failed to decode image"));
    img.src = src;
  });
}

function drawToBlob(
  img: HTMLImageElement,
  w: number,
  h: number,
  quality: number,
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      reject(new ImageUploadError("Canvas 2D context unavailable"));
      return;
    }
    ctx.drawImage(img, 0, 0, w, h);
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          reject(new ImageUploadError("Canvas produced empty blob"));
          return;
        }
        resolve(blob);
      },
      "image/jpeg",
      quality,
    );
  });
}

function fitWithinMaxSide(origW: number, origH: number, maxSide: number): { w: number; h: number } {
  const longest = Math.max(origW, origH);
  if (longest <= maxSide) return { w: origW, h: origH };
  const scale = maxSide / longest;
  return { w: Math.round(origW * scale), h: Math.round(origH * scale) };
}

/** Auto-compress a too-large image to fit within `maxBytes`.
 *  Tries canvas resize to 2048px longest side with decreasing JPEG quality,
 *  then falls back to 1536px if still oversized. If the file is already small
 *  enough, returns it unchanged (mobile cameras on realme/Samsung routinely
 *  produce 8-10MB JPEGs that would otherwise be rejected outright). */
export async function compressImageToLimit(
  file: File | Blob,
  maxBytes: number = MAX_FILE_SIZE,
): Promise<File> {
  const originalName = file instanceof File ? file.name : "photo.jpg";

  // Fast path: already under the limit.
  if (file.size <= maxBytes) {
    if (file instanceof File) return file;
    return new File([file], originalName, { type: file.type || "image/jpeg" });
  }

  const src = URL.createObjectURL(file);
  try {
    const { img, w: origW, h: origH } = await loadImage(src);

    for (const maxSide of [COMPRESS_MAX_SIDE_PRIMARY, COMPRESS_MAX_SIDE_FALLBACK]) {
      const dims = fitWithinMaxSide(origW, origH, maxSide);
      for (const q of COMPRESS_QUALITY_STEPS) {
        const blob = await drawToBlob(img, dims.w, dims.h, q);
        if (blob.size <= maxBytes) {
          return new File([blob], originalName.replace(/\.\w+$/, "") + ".jpg", {
            type: "image/jpeg",
          });
        }
      }
    }

    // As last resort return the smallest result we produced (1536px, q=0.5)
    const dims = fitWithinMaxSide(origW, origH, COMPRESS_MAX_SIDE_FALLBACK);
    const last = await drawToBlob(img, dims.w, dims.h, 0.5);
    return new File([last], originalName.replace(/\.\w+$/, "") + ".jpg", {
      type: "image/jpeg",
    });
  } finally {
    URL.revokeObjectURL(src);
  }
}

/** Convert a File to a base64 data URL string. Oversized images are auto-
 *  compressed via `compressImageToLimit` instead of being rejected. */
export async function fileToBase64(file: File): Promise<string> {
  if (!file.type.startsWith("image/")) {
    throw new ImageUploadError("File is not an image");
  }

  const processed = file.size > MAX_FILE_SIZE
    ? await compressImageToLimit(file, MAX_FILE_SIZE)
    : file;

  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new ImageUploadError("Failed to read file"));
    reader.readAsDataURL(processed);
  });
}

/** Upload a base64 data URL to Bastyon's image server (up1 endpoint).
 *  Matches the SDK's ImageUploader 'up1' path:
 *  - sends `file` = raw base64 (without data:image prefix)
 *  - sends `api_key`
 *  - response: `{ success: true, data: { ident: "..." } }`
 *  Returns the full image URL. */
export async function uploadImage(base64DataUrl: string): Promise<string> {
  // Strip the data URL prefix — server expects raw base64 in 'file' field
  const rawBase64 = base64DataUrl.includes(",")
    ? base64DataUrl.split(",")[1]
    : base64DataUrl;

  const body = new URLSearchParams({
    file: rawBase64,
    api_key: API_KEY,
  });

  const res = await fetch(UPLOAD_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!res.ok) {
    throw new ImageUploadError(`Upload failed: ${res.status}`);
  }

  const json = await res.json();
  if (!json.success) {
    throw new ImageUploadError(json.error || "Upload failed");
  }

  // SDK reads: deep(data, 'data.ident') → json.data.ident
  const ident = json.data?.ident;
  if (ident) {
    return IMAGE_BASE_URL + ident;
  }

  throw new ImageUploadError("No image identifier in upload response");
}
