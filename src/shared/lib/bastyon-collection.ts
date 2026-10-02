/**
 * Bastyon collection preview data.
 *
 * The vendor SDK (`psdk.collection`, public/js/lib/client/sdk.js + kit.js
 * pCollection) already cleans the node payload: tags are stripped, the
 * description lives in `settings.m` (the node has no message field for
 * collections), `contentIds` are validated txids. Stripping leaves escaped
 * entities (`&lt;`, `&amp;`) — decode them here because Vue renders text, not HTML.
 */

export interface BastyonCollectionData {
  txid: string;
  address: string;
  caption: string;
  description: string;
  image: string;
  contentCount: number;
  deleted: boolean;
}

/** Shape of a pCollection object from the vendor SDK (only the fields we read). */
export interface BastyonCollectionRaw {
  txid?: string;
  address?: string;
  caption?: string;
  image?: string;
  settings?: { m?: unknown } | null;
  contentIds?: unknown;
  deleted?: boolean;
}

const HTML_ENTITY_MAP: Record<string, string> = {
  "&nbsp;": " ",
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
};

function decodeEntities(text: string): string {
  return text.replace(/&(?:nbsp|amp|lt|gt|quot|#39|apos);/g, (m) => HTML_ENTITY_MAP[m] ?? m);
}

function asText(value: unknown): string {
  return typeof value === "string" ? decodeEntities(value).trim() : "";
}

export function toBastyonCollectionData(
  txid: string,
  raw: BastyonCollectionRaw,
): BastyonCollectionData {
  return {
    txid: raw.txid || txid,
    address: typeof raw.address === "string" ? raw.address : "",
    caption: asText(raw.caption),
    description: asText(raw.settings?.m),
    image: typeof raw.image === "string" ? raw.image : "",
    contentCount: Array.isArray(raw.contentIds) ? raw.contentIds.length : 0,
    deleted: !!raw.deleted,
  };
}
