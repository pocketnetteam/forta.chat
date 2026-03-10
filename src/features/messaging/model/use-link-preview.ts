import { ref, computed, watch, onScopeDispose, type Ref } from "vue";
import { getMatrixClientService } from "@/entities/matrix";
import type { LinkPreview } from "@/entities/chat";

/** Simple LRU cache for URL previews */
class LRUCache<K, V> {
  private map = new Map<K, V>();
  constructor(private maxSize: number) {}

  get(key: K): V | undefined {
    const val = this.map.get(key);
    if (val !== undefined) {
      this.map.delete(key);
      this.map.set(key, val);
    }
    return val;
  }

  set(key: K, val: V): void {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, val);
    if (this.map.size > this.maxSize) {
      const first = this.map.keys().next().value!;
      this.map.delete(first);
    }
  }

  has(key: K): boolean {
    return this.map.has(key);
  }
}

const cache = new LRUCache<string, LinkPreview | null>(200);
const inflight = new Map<string, Promise<LinkPreview | null>>();

const URL_RE = /https?:\/\/[^\s<>]+/;

/** Extract the first URL from text */
export function detectUrl(text: string): string | null {
  const m = text.match(URL_RE);
  return m ? m[0] : null;
}

/** Fetch preview for a URL (cached, deduplicated) */
export async function fetchPreview(url: string): Promise<LinkPreview | null> {
  if (cache.has(url)) return cache.get(url)!;

  if (inflight.has(url)) return inflight.get(url)!;

  const promise = (async () => {
    const service = getMatrixClientService();
    const data = await service.getUrlPreview(url);
    if (!data || (!data.title && !data.description && !data.siteName)) {
      cache.set(url, null);
      return null;
    }
    const preview: LinkPreview = {
      url,
      siteName: data.siteName,
      title: data.title,
      description: data.description?.slice(0, 200),
      imageUrl: data.imageUrl,
      imageWidth: data.imageWidth,
      imageHeight: data.imageHeight,
    };
    cache.set(url, preview);
    return preview;
  })();

  inflight.set(url, promise);
  try {
    return await promise;
  } finally {
    inflight.delete(url);
  }
}

/**
 * Composable for input link preview.
 * Watches a text ref, detects URLs with debounce, fetches preview.
 */
export function useLinkPreview(text: Ref<string>) {
  const preview = ref<LinkPreview | null>(null);
  const loading = ref(false);
  const dismissed = ref(false);
  const lastUrl = ref<string | null>(null);

  let debounceTimer: ReturnType<typeof setTimeout> | undefined;

  watch(text, (val) => {
    clearTimeout(debounceTimer);
    const url = detectUrl(val);

    if (!url) {
      preview.value = null;
      loading.value = false;
      lastUrl.value = null;
      dismissed.value = false;
      return;
    }

    if (url === lastUrl.value) return;

    dismissed.value = false;
    lastUrl.value = url;
    loading.value = true;

    debounceTimer = setTimeout(async () => {
      try {
        preview.value = await fetchPreview(url);
      } catch {
        preview.value = null;
      } finally {
        loading.value = false;
      }
    }, 500);
  });

  onScopeDispose(() => clearTimeout(debounceTimer));

  const dismiss = () => {
    dismissed.value = true;
  };

  const activePreview = computed(() => {
    if (dismissed.value) return null;
    return preview.value;
  });

  return {
    preview,
    activePreview,
    loading,
    dismissed,
    dismiss,
    lastUrl,
  };
}
