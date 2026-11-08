import { LOCAL_NODE_CONSTANTS } from "./constants";

interface PeertubeHost {
  host: string;
  offline?: boolean;
}

/**
 * Minimal PeerTube helper for rpc-ex feed enrichment: load swarm list once,
 * fetch video metadata by URL host.
 */
export class LocalNodePeertube {
  private hosts: PeertubeHost[] = [];
  private listLoaded = false;
  private readonly videoCache = new Map<string, { at: number; data: unknown }>();
  private readonly fetchImpl: typeof fetch;

  constructor(opts?: { fetchImpl?: typeof fetch }) {
    this.fetchImpl = opts?.fetchImpl ?? fetch;
  }

  async ensureList(): Promise<void> {
    if (this.listLoaded) return;
    try {
      const res = await this.fetchImpl(LOCAL_NODE_CONSTANTS.PEERTUBE_LIST_URL, {
        method: "GET",
      });
      if (!res.ok) {
        this.listLoaded = true;
        return;
      }
      const json = (await res.json()) as {
        swarms?: Record<string, { list?: Array<string | { host: string }> }>;
        archive?: Record<string, { host?: string }>;
      };
      const hosts: PeertubeHost[] = [];
      const seen = new Set<string>();
      const push = (host: string | undefined) => {
        if (!host || seen.has(host)) return;
        seen.add(host);
        hosts.push({ host });
      };
      for (const swarm of Object.values(json.swarms ?? {})) {
        for (const item of swarm.list ?? []) {
          push(typeof item === "string" ? item : item?.host);
        }
      }
      for (const arch of Object.values(json.archive ?? {})) {
        push(arch?.host);
      }
      this.hosts = hosts;
    } catch {
      /* offline — leave empty trust list */
    }
    this.listLoaded = true;
  }

  getSwarms(): PeertubeHost[][] {
    return this.hosts.length ? [this.hosts] : [];
  }

  getArchivedHosts(): PeertubeHost[] {
    return [];
  }

  async fetchVideosByUrls(urls: string[]): Promise<Record<string, unknown>> {
    await this.ensureList();
    const out: Record<string, unknown> = {};
    const trust = new Set(this.hosts.map((h) => h.host));
    const now = Date.now();

    await Promise.all(
      urls.map(async (url) => {
        if (!url) return;
        const trusted = [...trust].some((h) => url.includes(h));
        if (trust.size > 0 && !trusted) return;

        const cached = this.videoCache.get(url);
        if (
          cached &&
          now - cached.at < LOCAL_NODE_CONSTANTS.PEERTUBE_VIDEO_CACHE_TTL_MS
        ) {
          out[url] = cached.data;
          return;
        }

        try {
          const controller =
            typeof AbortController !== "undefined" ? new AbortController() : null;
          const timer = setTimeout(
            () => controller?.abort(),
            LOCAL_NODE_CONSTANTS.PEERTUBE_VIDEO_HTTP_TIMEOUT_MS,
          );
          const res = await this.fetchImpl(url, {
            method: "GET",
            signal: controller?.signal,
          });
          clearTimeout(timer);
          if (!res.ok) return;
          const data = await res.json();
          this.videoCache.set(url, { at: now, data });
          out[url] = data;
        } catch {
          /* skip */
        }
      }),
    );

    return out;
  }

  destroy(): void {
    this.videoCache.clear();
    this.hosts = [];
    this.listLoaded = false;
  }
}
