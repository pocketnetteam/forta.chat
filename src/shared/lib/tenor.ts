/**
 * GIF search client (KLIPY API v1).
 *
 * Kept as tenor.ts to avoid renaming imports across the codebase.
 * The exported interface names (TenorGif, etc.) are kept for compatibility.
 *
 * Free, no rate limits.
 */

const KLIPY_API_KEY = import.meta.env.VITE_KLIPY_API_KEY || "";
const KLIPY_BASE = `https://api.klipy.com/api/v1/${KLIPY_API_KEY}/gifs`;

export interface TenorGif {
  id: string;
  title: string;
  previewUrl: string;
  gifUrl: string;
  width: number;
  height: number;
}

interface KlipyMediaFile {
  url: string;
  width: number;
  height: number;
  size: number;
}

interface KlipyMediaSet {
  gif?: KlipyMediaFile;
  webp?: KlipyMediaFile;
  jpg?: KlipyMediaFile;
  mp4?: KlipyMediaFile;
}

interface KlipyResult {
  id: number;
  slug: string;
  title: string;
  file: {
    hd?: KlipyMediaSet;
    md?: KlipyMediaSet;
    sm?: KlipyMediaSet;
    xs?: KlipyMediaSet;
  };
}

interface KlipyResponse {
  result: boolean;
  data: {
    data: KlipyResult[];
    current_page: number;
    per_page: number;
    has_next: boolean;
  };
}

function mapResult(r: KlipyResult): TenorGif {
  const preview = r.file.sm?.gif ?? r.file.xs?.gif ?? r.file.md?.gif;
  const full = r.file.md?.gif ?? r.file.hd?.gif ?? r.file.sm?.gif;

  return {
    id: String(r.id),
    title: r.title,
    previewUrl: preview?.url ?? "",
    gifUrl: full?.url ?? "",
    width: full?.width ?? 220,
    height: full?.height ?? 220,
  };
}

async function klipyFetch(
  endpoint: string,
  params: Record<string, string>,
): Promise<KlipyResponse> {
  const url = new URL(`${KLIPY_BASE}/${endpoint}`);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }

  const res = await fetch(url.toString());
  if (!res.ok) {
    throw new Error(`KLIPY API error: ${res.status} ${res.statusText}`);
  }
  return res.json();
}

export async function searchGifs(
  query: string,
  limit = 24,
  next?: string,
): Promise<{ gifs: TenorGif[]; next: string }> {
  const page = next ? parseInt(next, 10) : 1;
  const data = await klipyFetch("search", {
    q: query,
    per_page: String(limit),
    page: String(page),
    rating: "pg-13",
  });

  return {
    gifs: data.data.data.map(mapResult),
    next: data.data.has_next ? String(page + 1) : "",
  };
}

export async function getTrending(
  limit = 24,
  next?: string,
): Promise<{ gifs: TenorGif[]; next: string }> {
  const page = next ? parseInt(next, 10) : 1;
  const data = await klipyFetch("trending", {
    per_page: String(limit),
    page: String(page),
  });

  return {
    gifs: data.data.data.map(mapResult),
    next: data.data.has_next ? String(page + 1) : "",
  };
}

export async function fetchGifBlob(url: string): Promise<Blob> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to fetch GIF: ${res.status} ${res.statusText}`);
  }
  return res.blob();
}
