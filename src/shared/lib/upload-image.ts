const UPLOAD_URL = "https://pocketnet.app:8092/up";
const IMAGE_BASE_URL = "https://pocketnet.app:8092/i/";
const API_KEY = "c61540b5ceecd05092799f936e277552";
const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5 MB

export class ImageUploadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImageUploadError";
  }
}

/** Convert a File to a base64 data URL string */
export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!file.type.startsWith("image/")) {
      reject(new ImageUploadError("File is not an image"));
      return;
    }
    if (file.size > MAX_FILE_SIZE) {
      reject(new ImageUploadError("Image exceeds 5 MB limit"));
      return;
    }
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new ImageUploadError("Failed to read file"));
    reader.readAsDataURL(file);
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
