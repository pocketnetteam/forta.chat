import { computed } from "vue";
import { en } from "./locales/en";
import { ru } from "./locales/ru";
import { useLocaleStore } from "@/entities/locale";
import type { TranslationKey } from "./locales/en";

const messages = { en, ru } as const;

function interpolate(text: string, params?: Record<string, string | number>): string {
  if (!params) return text;
  let result = text;
  for (const [k, v] of Object.entries(params)) {
    result = result.replace(new RegExp(`\\{${k}\\}`, "g"), String(v));
  }
  return result;
}

export function useI18n() {
  const localeStore = useLocaleStore();

  const locale = computed(() => localeStore.locale);

  function t(key: TranslationKey, params?: Record<string, string | number>): string {
    const dict = messages[locale.value] ?? messages.en;
    const text = dict[key] ?? messages.en[key] ?? key;
    return interpolate(text, params);
  }

  return { t, locale };
}

/**
 * Standalone translation function for non-Vue contexts (services, workers).
 * Reads locale from localStorage directly — no Pinia dependency.
 */
export function tRaw(key: TranslationKey, params?: Record<string, string | number>): string {
  let locale: string = "en";
  try {
    const raw = localStorage.getItem("forta-chat:locale");
    if (raw) {
      try { locale = JSON.parse(raw); } catch { locale = raw; }
    }
  } catch { /* fallback to en */ }
  const dict = messages[locale as keyof typeof messages] ?? messages.en;
  const text = dict[key] ?? messages.en[key] ?? key;
  return interpolate(text, params);
}

export type { TranslationKey };
