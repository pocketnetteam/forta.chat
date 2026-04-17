import { nextTick, onMounted, onUnmounted, ref, watch, type Ref } from "vue";

/**
 * IntersectionObserver-based visibility. Retries on nextTick + when `targetRef` is bound
 * so we never miss the first paint (onMounted often runs before the template ref exists).
 */
export function useLazyLoad(targetRef: Ref<HTMLElement | undefined>, rootMargin = "200px") {
  const isVisible = ref(false);
  let observer: IntersectionObserver | undefined;

  const stop = () => {
    observer?.disconnect();
    observer = undefined;
  };

  const start = () => {
    if (isVisible.value) return;
    const el = targetRef.value;
    if (!el || observer) return;
    observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          isVisible.value = true;
          stop();
        }
      },
      { rootMargin, threshold: 0 },
    );
    observer.observe(el);
  };

  watch(
    () => targetRef.value,
    (el) => {
      if (!el || isVisible.value) return;
      stop();
      nextTick(start);
    },
    { flush: "post" },
  );

  onMounted(() => {
    nextTick(start);
  });

  onUnmounted(() => stop());

  return { isVisible };
}
