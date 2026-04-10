# Архитектура: Локализация (i18n)

## Связь с проблемой

Пользователи сообщают: «всё на английском — непонятно», «нужно переводить со словарём», «нет переключения на русский».

## Общая архитектура

**vue-i18n НЕ используется.** Реализован собственный тонкий слой:

```
src/shared/lib/i18n/
  ├── index.ts          — useI18n(), tRaw(), interpolate()
  └── locales/
      ├── en.ts         — English (источник ключей + тип TranslationKey)
      └── ru.ts         — Russian (Record<TranslationKey, string>)
```

## API

### `useI18n()` — для Vue-компонентов

```typescript
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
```

### `tRaw()` — для non-Vue контекстов

```typescript
export function tRaw(key: TranslationKey, params?: Record<string, string | number>): string {
  let locale: string = "en";
  try {
    const raw = localStorage.getItem("forta-chat:locale");
    if (raw) {
      try { locale = JSON.parse(raw); } catch { locale = raw; }
    }
  } catch { /* fallback to en */ }
  // ...
}
```

Используется в: `push-service.ts`, `event-writer.ts`, `AppLoading`, `format-preview`.

### Интерполяция

Плейсхолдеры `{name}` → `String(value)`:
```typescript
function interpolate(text: string, params?: Record<string, string | number>): string {
  for (const [k, v] of Object.entries(params)) {
    result = result.replace(new RegExp(`\\{${k}\\}`, "g"), String(v));
  }
}
```

## Поддерживаемые языки

```typescript
// src/entities/locale/model/types.ts
export type Locale = "en" | "ru";
```

Ровно **два языка**: английский и русский.

## Определение языка по умолчанию

```typescript
// src/entities/locale/model/stores.ts
function detectBrowserLocale(): Locale {
  const lang = navigator.language?.slice(0, 2);
  return lang === "ru" ? "ru" : "en";
}
```

Приоритет:
1. `localStorage("forta-chat:locale")` — если есть
2. `navigator.language` — первые 2 символа === "ru" → русский
3. Иначе → английский

## Переключение языка

### Store

```typescript
// src/entities/locale/model/stores.ts
const setLocale = (_locale: Locale) => {
  locale.value = _locale;
  setLSLocale(_locale);                                    // localStorage
  document.documentElement.lang = _locale;                 // HTML lang
  AppLocale?.setLocale({ locale: _locale }).catch(() => {}); // Нативный Android
};
```

### UI точки переключения

| Место | Файл | Механизм |
|-------|------|----------|
| Welcome экран | `WelcomePage.vue` | Кнопки "English" / "Русский" (хардкод) |
| Обёртка авторизации | `AuthLayout.vue` | Кнопки "English" / "Русский" (хардкод) |
| Редактирование профиля | `UserEditForm.vue` | `<select>` с `t("locale.en")` / `t("locale.ru")` |

**Отдельного пункта «Язык» в SettingsPage — нет.**

## Что переведено

### Полностью переведено (через `useI18n()` + `t()`)

- Сайдбар, список чатов, контакты
- Настройки, внешний вид
- Сообщения, ввод, статусы
- Звонки
- Каналы, посты
- Поиск, инвайты
- Загрузочный экран (через `tRaw`)
- Системные сообщения (`system.*`)
- Push-превью (`push-service.ts`)

### Не переведено / смешано

| Область | Проблема | Файл |
|---------|----------|------|
| Профиль (просмотр) | "About", "Website", "Language", "Anonymous", "Not set" — хардкод EN | `UserProfileInfo.vue` |
| Welcome/Auth layout | Текст кнопок "English" / "Русский" — хардкод | `WelcomePage.vue`, `AuthLayout.vue` |
| Tor toast | "Secure connection unavailable..." — хардкод EN | `src/app/providers/index.ts` |
| Пресеты градиентов | "Ocean", "Sunset" и т.д. — хардкод EN | `AppearancePage.vue` |
| Справка по ключу | HTML-страница с заголовком "Bastyon Private Key" | `public/help/how-to-get-private-key.html` |
| Компоненты `shared/ui/` | Видимый текст без `useI18n()` | Разные файлы |

## Профильное поле `language`

При регистрации в профиль записывается `localeStore.locale` как `language`, но при входе **UI-локаль НЕ подтягивается** из `userInfo.language` — она управляется только через `localStorage`.

## Тесты

`src/shared/lib/i18n/tRaw.test.ts` — тесты поведения `tRaw` и формата значения в `localStorage`.

## Ключевые файлы

| Файл | Назначение |
|------|------------|
| `src/shared/lib/i18n/index.ts` | useI18n, tRaw, interpolate |
| `src/shared/lib/i18n/locales/en.ts` | Английские переводы + тип ключей |
| `src/shared/lib/i18n/locales/ru.ts` | Русские переводы |
| `src/entities/locale/model/stores.ts` | Locale store, detectBrowserLocale |
| `src/entities/locale/model/types.ts` | Тип Locale |
| `src/pages/welcome/WelcomePage.vue` | Переключатель на welcome |
| `src/widgets/layouts/AuthLayout.vue` | Переключатель в auth |
| `src/features/user-management/ui/UserEditForm.vue` | Переключатель в профиле |
| `src/app/providers/index.ts` | Инициализация locale store |
