import { tRaw, type TranslationKey } from "@/shared/lib/i18n";
import { en } from "@/shared/lib/i18n/locales/en";
import { ru } from "@/shared/lib/i18n/locales/ru";

const dicts = { en, ru } as const;
type SupportedLocale = keyof typeof dicts;

function isSupportedLocale(locale?: string): locale is SupportedLocale {
  return locale === "en" || locale === "ru";
}

/**
 * Resolve a date label for the given locale. When `locale` is provided the
 * lookup is reactive — callers that read a reactive `locale.value` and pass it
 * in re-render on language switches (WEE-67 / forta-bugs#903). When omitted
 * (non-Vue contexts: services, workers) it falls back to `tRaw()`, which reads
 * the persisted locale from localStorage.
 */
function dateLabel(key: TranslationKey, locale?: string): string {
  if (isSupportedLocale(locale)) {
    return dicts[locale][key] ?? dicts.en[key] ?? tRaw(key);
  }
  return tRaw(key);
}

/** BCP-47 locale tag for Intl APIs, or `undefined` to use the runtime default. */
function intlLocale(locale?: string): string | undefined {
  return isSupportedLocale(locale) ? locale : undefined;
}

export function formatTime(date: Date): string {
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function formatDate(date: Date, locale?: string): string {
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);

  if (isSameDay(date, today)) return dateLabel("date.today", locale);
  if (isSameDay(date, yesterday)) return dateLabel("date.yesterday", locale);

  return date.toLocaleDateString(intlLocale(locale), {
    day: "numeric",
    month: "short",
    year: date.getFullYear() !== today.getFullYear() ? "numeric" : undefined
  });
}

function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getDate() === b.getDate() &&
    a.getMonth() === b.getMonth() &&
    a.getFullYear() === b.getFullYear()
  );
}

export function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/** Telegram-style relative time for sidebar: "12:34", "Mon", "Jan 5" etc. */
export function formatRelativeTime(date: Date, locale?: string): string {
  const now = new Date();
  if (isSameDay(date, now)) {
    return formatTime(date);
  }

  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (isSameDay(date, yesterday)) return dateLabel("date.yesterday", locale);

  // Within same week: day name
  const diffMs = now.getTime() - date.getTime();
  if (diffMs < 7 * 24 * 60 * 60 * 1000) {
    return date.toLocaleDateString(intlLocale(locale), { weekday: "short" });
  }

  // Older: date
  return date.toLocaleDateString(intlLocale(locale), {
    day: "numeric",
    month: "short",
    year: date.getFullYear() !== now.getFullYear() ? "numeric" : undefined,
  });
}
