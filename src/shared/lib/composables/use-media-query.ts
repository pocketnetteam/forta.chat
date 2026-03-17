import { ref, onMounted, onUnmounted } from "vue";

export function useMediaQuery(query: string) {
  const mql =
    typeof window !== "undefined" ? window.matchMedia(query) : null;
  const matches = ref(mql ? mql.matches : false);

  function update(e: MediaQueryListEvent) {
    matches.value = e.matches;
  }

  onMounted(() => {
    mql?.addEventListener("change", update);
  });

  onUnmounted(() => {
    mql?.removeEventListener("change", update);
  });

  return matches;
}

/** Mobile: < 768px (Tailwind md breakpoint) */
export const useMobile = () => useMediaQuery("(max-width: 767px)");

/** Tablet: 768–1023px */
export const useTablet = () =>
  useMediaQuery("(min-width: 768px) and (max-width: 1023px)");

/** Desktop: ≥ 1024px */
export const useDesktop = () => useMediaQuery("(min-width: 1024px)");
