export interface VideoInfo {
  type: "youtube" | "vimeo" | "peertube";
  id: string;
  embedUrl: string;
  thumbUrl: string;
  apiUrl?: string;
}

const YT_RE = /(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/;
const VIMEO_RE = /vimeo\.com\/(\d+)/;
const PEERTUBE_RE = /peertube:\/\/([^/]+)\/([a-f0-9-]+)/;

export function parseVideoUrl(url: string): VideoInfo | null {
  if (!url) return null;

  const yt = url.match(YT_RE);
  if (yt) {
    return {
      type: "youtube",
      id: yt[1],
      embedUrl: `https://www.youtube.com/embed/${yt[1]}`,
      thumbUrl: `https://img.youtube.com/vi/${yt[1]}/hqdefault.jpg`,
    };
  }

  const vim = url.match(VIMEO_RE);
  if (vim) {
    return {
      type: "vimeo",
      id: vim[1],
      embedUrl: `https://player.vimeo.com/video/${vim[1]}`,
      thumbUrl: "",
    };
  }

  const pt = url.match(PEERTUBE_RE);
  if (pt) {
    const host = pt[1];
    const id = pt[2];
    return {
      type: "peertube",
      id,
      embedUrl: `https://${host}/videos/embed/${id}`,
      thumbUrl: "",
      apiUrl: `https://${host}/api/v1/videos/${id}`,
    };
  }

  return null;
}

/** Fetch PeerTube thumbnail via API (the preview UUID differs from the video UUID) */
export async function fetchPeerTubeThumb(apiUrl: string): Promise<string> {
  try {
    const resp = await fetch(apiUrl, { signal: AbortSignal.timeout(5000) });
    if (!resp.ok) return "";
    const data = await resp.json();
    const path = data.previewPath || data.thumbnailPath;
    if (!path) return "";
    const origin = new URL(apiUrl).origin;
    return `${origin}${path}`;
  } catch {
    return "";
  }
}
