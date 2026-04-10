# Архитектура: Путаница продуктов (Bastyon vs Forta)

## Связь с проблемой

Пользователи сообщают: «Bastyon и Forta — это одно или нет?», «зачем отдельное приложение?».

## Связь Bastyon и Forta Chat

### Bastyon — экосистема

- Децентрализованная социальная сеть (посты, каналы, контент)
- Блокчейн Pocketnet для хранения профилей и транзакций
- Собственный десктоп-клиент и мобильное приложение
- Встроенный legacy-чат (bastyon-chat)

### Forta Chat — мессенджер

- Отдельное приложение для обмена сообщениями
- Использует **тот же блокчейн** Pocketnet для идентичности и ключей
- Использует **Matrix homeserver** для чатов (на инфраструктуре `pocketnet.app`)
- **Порт шифрования** из bastyon-chat (Pcrypto)

## Технические зависимости от Bastyon

### Блокчейн (идентичность)

```
Регистрация:
  → Bastyon blockchain (UserInfo tx)
  → Публикация 12 E2E ключей
  → PKOIN для транзакций (через прокси-ноды)

Профиль:
  → Имя, аватар, about хранятся в блокчейне
  → Один источник правды для обоих приложений
```

### SDK и API

`src/app/providers/initializers/app-initializer.ts`:
- `Api` — RPC к Pocketnet нодам
- `Actions` — broadcast транзакций
- `pSDK` — Pocketnet SDK для профилей

### Bastyon SDK скрипты

Загружаются при старте (`setupChatScripts` в providers):
```
public/js/
  ├── pocketnet SDK
  ├── crypto libraries
  └── API utilities
```

### Каналы

`src/features/channels/` — лента подписок Bastyon:
- `getSubscribesChannels()` — подписки из Bastyon
- `getProfileFeed()` — посты из Bastyon
- i18n: *«подпишитесь на каналы в Bastyon»*

## Смешанный брендинг в коде

### «Forta» в UI

| Место | Текст |
|-------|-------|
| `welcome.title` | «Forta Chat» |
| `titleBar.appName` | «Forta Chat» |
| Boot messages | «Forta Chat» |
| App name | `Forta Chat` (capacitor.config.ts) |
| Package | `com.forta.chat` |

### «Bastyon» в коде и UI

| Место | Текст/Код | Файл |
|-------|-----------|------|
| localStorage keys | `bastyon-chat-*` (sessions, users, referral) | Разные |
| Каналы hint | «подпишитесь на каналы в Bastyon» | `en.ts` / `ru.ts` |
| Deep links | `bastyon://user?...` | `ChatInfoPanel.vue` |
| Справка по ключу | «Bastyon Private Key» | `how-to-get-private-key.html` |
| Matrix SDK | `matrix-js-sdk-bastyon` | `package.json` |
| IndexedDB names | `bastyon-chat-users` | `user-store.ts` |
| Pcrypto комментарии | «port from bastyon-chat» | `matrix-crypto.ts` |
| Config file | `pocketnetinstance.ts` | `chat-scripts/config/` |

### Пример неоднозначности

```typescript
// i18n en.ts
"post.openInBastyon": "Open in Forta"  // ключ говорит Bastyon, значение — Forta
```

## Общий приватный ключ

### Совместимость

- Один ключ работает в Bastyon и Forta
- BIP39 мнемоника из Forta: деривация `m/44'/0'/0'/0'`
- WIF из Bastyon: прямое использование
- **Могут быть расхождения** в деривации (см. 13-account-sync)

### E2E ключи

- Деривация: `m/33'/0'/0'/{1..12}'` — одинаковая в обоих
- Публикация в блокчейн: UserInfo transaction
- При входе в Forta: `verifyAndRepublishKeys()` если не хватает

## Что общего, что различается

| Аспект | Bastyon | Forta Chat |
|--------|---------|------------|
| Блокчейн identity | Да | Да (тот же) |
| Matrix homeserver | Да (legacy chat) | Да (новый клиент) |
| E2E Pcrypto | Да (оригинал) | Да (порт) |
| Посты/каналы | Основная функция | Только просмотр |
| Чаты | Встроенные | Основная функция |
| Видеозвонки | ? | Да |
| Приложение | Отдельное | Отдельное |
| Домен | bastyon.com | forta.chat |
| Инфраструктура | pocketnet.app | pocketnet.app (тот же) |

## Отсутствие объяснения в приложении

В приложении **нет:**
- Экрана «О приложении» с описанием связи
- FAQ «Bastyon vs Forta»
- Onboarding с объяснением
- Текста на Welcome page про отношение к Bastyon
- Landing page с описанием продукта

## Ключевые файлы

| Файл | Назначение |
|------|------------|
| `src/shared/config/constants.ts` | APP_PUBLIC_URL, MATRIX_SERVER |
| `src/app/providers/initializers/app-initializer.ts` | Bastyon SDK integration |
| `src/app/providers/chat-scripts/config/pocketnetinstance.ts` | Legacy Pocketnet config |
| `src/entities/matrix/model/matrix-crypto.ts` | Pcrypto (port from bastyon-chat) |
| `src/shared/lib/i18n/locales/en.ts` | Смешанный брендинг в текстах |
| `src/entities/channel/model/channel-store.ts` | Каналы Bastyon |
| `src/features/chat-info/ui/ChatInfoPanel.vue` | bastyon:// deep links |
| `src/entities/auth/model/session-manager.ts` | bastyon-chat-* keys |
| `public/help/how-to-get-private-key.html` | «Bastyon Private Key» |
| `capacitor.config.ts` | com.forta.chat (Forta branding) |
| `package.json` | matrix-js-sdk-bastyon |
