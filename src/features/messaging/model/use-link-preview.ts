import { ref, computed, watch, onScopeDispose, type Ref } from "vue";
import { getMatrixClientService } from "@/entities/matrix";
import type { LinkPreview } from "@/entities/chat";
import { LRUCache } from "@/shared/lib/lru-cache";

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

  watch(text, () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(async () => {
      const url = detectUrl(text.value);

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
