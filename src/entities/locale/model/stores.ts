import type { Locale } from "@/entities/locale/model/types";
import { useLocalStorage } from "@/shared/lib/browser";
import { isNative } from "@/shared/lib/platform";
import { Capacitor, registerPlugin } from "@capacitor/core";
import { defineStore } from "pinia";
import { ref } from "vue";

const NAMESPACE = "locale";

interface AppLocalePlugin {
  setLocale(options: { locale: string }): Promise<void>;
}

const AppLocale = isNative
  ? registerPlugin<AppLocalePlugin>("AppLocale")
  : null;

function detectBrowserLocale(): Locale {
  const lang = navigator.language?.slice(0, 2);
  return lang === "ru" ? "ru" : "en";
}

export const useLocaleStore = defineStore(NAMESPACE, () => {
  const { setLSValue: setLSLocale, value: lsLocale } =
    useLocalStorage<Locale>(NAMESPACE);

  const locale = ref<Locale>(lsLocale ?? detectBrowserLocale());

  const setLocale = (_locale: Locale) => {
    locale.value = _locale;
    setLSLocale(_locale);
    document.documentElement.lang = _locale;
    // Sync locale to Android native layer
    AppLocale?.setLocale({ locale: _locale }).catch(() => {});
  };

  // Set initial lang attribute
  document.documentElement.lang = locale.value;

  // Sync initial locale to native on first load
  AppLocale?.setLocale({ locale: locale.value }).catch(() => {});

  return { locale, setLocale };
});
