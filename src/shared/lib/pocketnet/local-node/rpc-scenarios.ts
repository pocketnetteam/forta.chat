import type { LocalNodePeertube } from "./peertube";

const USER_METHODS = new Set([
  "gethierarchicalstrip",
  "getsubscribesfeed",
  "getprofilefeed",
  "getmostcommentedfeed",
]);

const FEED_ALIASES = new Set([
  "gethierarchicalstrip",
  "getrecommendedcontentbyaddress",
  "getprofilefeed",
  "getsubscribesfeed",
  "gethotposts",
  "getmostcommentedfeed",
]);

export function hasRpcScenario(method: string): boolean {
  return FEED_ALIASES.has(method);
}

type RpcFn = (
  method: string,
  parameters: unknown[],
  options?: Record<string, unknown>,
) => Promise<unknown>;

function collectAddresses(contents: unknown[]): string[] {
  const addrs = new Set<string>();
  for (const item of contents) {
    if (!item || typeof item !== "object") continue;
    const post = item as Record<string, unknown>;
    const address = post.address;
    if (typeof address === "string") addrs.add(address);
    const lastComment = post.lastComment as { address?: string } | undefined;
    if (lastComment?.address) addrs.add(lastComment.address);
  }
  return [...addrs];
}

function collectVideoUrls(contents: unknown[]): string[] {
  const urls: string[] = [];
  for (const item of contents) {
    if (!item || typeof item !== "object") continue;
    const post = item as Record<string, unknown>;
    const u = post.u ?? post.url;
    if (typeof u === "string" && (u.includes("/api/v1/videos/") || u.includes("peertube"))) {
      urls.push(u);
    }
  }
  return urls;
}

/**
 * Port of proxy16 gethierarchicalstrip enrichment for rpc-ex:
 * { contents, users?, videos? }.
 */
export async function runFeedScenario(
  method: string,
  args: {
    parameters: unknown[];
    options?: Record<string, unknown>;
    rpc: RpcFn;
    peertube?: LocalNodePeertube | null;
  },
): Promise<{ contents: unknown; users?: unknown[]; videos?: Record<string, unknown> }> {
  const opts = { ...(args.options ?? {}), ex: false };
  const raw = await args.rpc(method, args.parameters, opts);

  let contents: unknown[] = [];
  if (Array.isArray(raw)) contents = raw;
  else if (raw && typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    if (Array.isArray(obj.contents)) contents = obj.contents;
    else if (Array.isArray(obj.data)) contents = obj.data;
    else contents = [raw];
  }

  const result: {
    contents: unknown;
    users?: unknown[];
    videos?: Record<string, unknown>;
  } = { contents };

  if (USER_METHODS.has(method) || method === "getrecommendedcontentbyaddress") {
    const addresses = collectAddresses(contents);
    if (addresses.length > 0) {
      try {
        const users = await args.rpc("getuserprofile", [addresses, "yes"], opts);
        if (Array.isArray(users)) result.users = users;
      } catch {
        /* enrichment best-effort */
      }
    }
  }

  const videoUrls = collectVideoUrls(contents);
  if (videoUrls.length > 0 && args.peertube) {
    try {
      result.videos = await args.peertube.fetchVideosByUrls(videoUrls);
    } catch {
      /* enrichment best-effort */
    }
  }

  return result;
}
