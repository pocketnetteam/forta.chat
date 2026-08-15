import { ref, computed, onMounted, type Ref, type ComputedRef } from "vue";
import {
  detectClientOs,
  clientOsToDownloadPlatform,
  sortPlatformsByDetection,
  type ClientOs,
  type DownloadPlatform,
} from "./detect-client-os";
import {
  fetchLatestRelease,
  resolvePlatformDownloadUrl,
} from "./fetch-latest-release";
import type { MatchedAssets } from "./match-release-assets";
import { downloadLinks } from "@/shared/config/download-links";

export type UseLatestReleaseDownloads = {
  loading: Ref<boolean>;
  version: Ref<string>;
  urls: Ref<MatchedAssets>;
  fromApi: Ref<boolean>;
  clientOs: Ref<ClientOs>;
  recommendedPlatform: ComputedRef<DownloadPlatform | null>;
  sortedPlatforms: ComputedRef<DownloadPlatform[]>;
  urlFor: (platform: DownloadPlatform) => string;
  playStoreUrl: string;
  releasesPageUrl: string;
};

/**
 * Load latest GitHub release assets once on mount and expose OS-aware helpers.
 */
export function useLatestReleaseDownloads(): UseLatestReleaseDownloads {
  const loading = ref(true);
  const version = ref("");
  const urls = ref<MatchedAssets>({});
  const fromApi = ref(false);
  const ua =
    typeof navigator !== "undefined" ? navigator.userAgent : "";
  const clientOs = ref<ClientOs>(detectClientOs(ua));

  const recommendedPlatform = computed(() =>
    clientOsToDownloadPlatform(clientOs.value),
  );

  const sortedPlatforms = computed(() =>
    sortPlatformsByDetection(recommendedPlatform.value),
  );

  function urlFor(platform: DownloadPlatform): string {
    return resolvePlatformDownloadUrl(urls.value, platform);
  }

  onMounted(async () => {
    loading.value = true;
    try {
      const result = await fetchLatestRelease(ua);
      version.value = result.version;
      urls.value = result.urls;
      fromApi.value = result.fromApi;
    } finally {
      loading.value = false;
    }
  });

  return {
    loading,
    version,
    urls,
    fromApi,
    clientOs,
    recommendedPlatform,
    sortedPlatforms,
    urlFor,
    playStoreUrl: downloadLinks.androidPlayStore,
    releasesPageUrl: downloadLinks.githubReleasesLatest,
  };
}
