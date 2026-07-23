import type { Locale } from "@/entities/locale/model/types";
import { useLocalStorage } from "@/shared/lib/browser";
import { isNative, isIOS } from "@/shared/lib/platform";
import { registerPlugin } from "@capacitor/core";
import { defineStore } from "pinia";
import { ref } from "vue";

const NAMESPACE = "locale";

interface AppLocalePlugin {
  setLocale(options: { locale: string }): Promise<void>;
}

// iOS resolves the app language from Bundle.main.preferredLocalizations, which
// reflects the system Settings → General → Language & Region. We do not ship
// an AppLocale plugin on iOS; in-app language changes take effect after a
// relaunch. See docs/plans/ios/2026-05-12-ios-simple-tasks.md Task 5.
const AppLocale = isNative && !isIOS
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
    // Sync locale to Android native layer. On iOS this is null and the
    // optional chain short-circuits — the WebView still updates immediately
    // via the persisted locale; the iOS native layer follows system settings.
    AppLocale?.setLocale({ locale: _locale }).catch(() => {});
  };

  // Set initial lang attribute
  document.documentElement.lang = locale.value;

  // Sync initial locale to native on first load
  AppLocale?.setLocale({ locale: locale.value }).catch(() => {});

  return { locale, setLocale };
});
