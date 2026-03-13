const TENOR_API_KEY =
  import.meta.env.VITE_TENOR_API_KEY ||
  "AIzaSyBqRGYRPBaPP3gwBPkaOY0eHFEPxqjgd9c";
const TENOR_BASE = "https://tenor.googleapis.com/v2";

export interface TenorGif {
  id: string;
  title: string;
  previewUrl: string;
  gifUrl: string;
  width: number;
  height: number;
}

interface TenorMediaFormat {
  url: string;
  dims: [number, number];
  size: number;
}

interface TenorResult {
  id: string;
  title: string;
  media_formats: {
    tinygif?: TenorMediaFormat;
    mediumgif?: TenorMediaFormat;
    gif?: TenorMediaFormat;
  };
}

interface TenorResponse {
  results: TenorResult[];
  next: string;
}

function mapResult(r: TenorResult): TenorGif {
  const preview = r.media_formats.tinygif ?? r.media_formats.mediumgif ?? r.media_formats.gif;
  const full = r.media_formats.mediumgif ?? r.media_formats.gif ?? r.media_formats.tinygif;

  return {
    id: r.id,
    title: r.title,
    previewUrl: preview?.url ?? "",
    gifUrl: full?.url ?? "",
    width: full?.dims[0] ?? 220,
    height: full?.dims[1] ?? 220,
  };
}

async function tenorFetch(endpoint: string, params: Record<string, string>): Promise<TenorResponse> {
  const url = new URL(`${TENOR_BASE}/${endpoint}`);
  url.searchParams.set("key", TENOR_API_KEY);
  url.searchParams.set("client_key", "bastyon_chat");
  url.searchParams.set("media_filter", "tinygif,mediumgif,gif");
  url.searchParams.set("contentfilter", "medium");
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }

  const res = await fetch(url.toString());
  if (!res.ok) {
    throw new Error(`Tenor API error: ${res.status} ${res.statusText}`);
  }
  return res.json();
}

export async function searchGifs(
  query: string,
  limit = 20,
  next?: string,
): Promise<{ gifs: TenorGif[]; next: string }> {
  const params: Record<string, string> = {
    q: query,
    limit: String(limit),
  };
  if (next) params.pos = next;

  const data = await tenorFetch("search", params);
  return {
    gifs: data.results.map(mapResult),
    next: data.next,
  };
}

export async function getTrending(
  limit = 20,
  next?: string,
): Promise<{ gifs: TenorGif[]; next: string }> {
  const params: Record<string, string> = {
    limit: String(limit),
  };
  if (next) params.pos = next;

  const data = await tenorFetch("featured", params);
  return {
    gifs: data.results.map(mapResult),
    next: data.next,
  };
}

export async function fetchGifBlob(url: string): Promise<Blob> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to fetch GIF: ${res.status} ${res.statusText}`);
  }
  return res.blob();
}
