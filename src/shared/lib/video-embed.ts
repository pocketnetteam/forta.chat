export interface VideoInfo {
  type: "youtube" | "vimeo" | "peertube";
  id: string;
  embedUrl: string;
  thumbUrl: string;
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
    return {
      type: "peertube",
      id: pt[2],
      embedUrl: `https://${pt[1]}/videos/embed/${pt[2]}`,
      thumbUrl: `https://${pt[1]}/lazy-static/previews/${pt[2]}.jpg`,
    };
  }

  return null;
}
