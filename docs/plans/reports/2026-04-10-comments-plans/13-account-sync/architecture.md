# Архитектура: Аккаунт и синхронизация

## Связь с проблемой

Пользователи сообщают: «имя не сохраняется (остаётся "Аноним")», «не синхронизируется с Bastyon», «ключи не подходят между сервисами».

## Идентичность пользователя

### Bastyon Address (основа)

Один приватный ключ → Bastyon address → Matrix username:

```
privateKey (hex/WIF/mnemonic)
  → ECPair / BIP39 derivation (m/44'/0'/0'/0')
  → publicKey → getAddressFromPubKey → address

Matrix:
  username = hexEncode(address).toLowerCase()
  password = SHA256(SHA256(Buffer.from(privateKey)))
```

### Хранение сессии

`SessionManager` (`src/entities/auth/model/session-manager.ts`):

```typescript
localStorage("forta-chat:sessions"):
  [
    {
      address: string,
      privateKey: string,        // hex
      accessToken?: string,      // Matrix
      homeserverUrl?: string,
      syncToken?: string         // для background sync
    },
    // до 5 аккаунтов
  ]

localStorage("forta-chat:activeAccount"): address
```

## Синхронизация профиля с Bastyon

### При входе

`fetchUserInfo()` → `appInitializer.initializeAndFetchUserData(address, callback)`:

```
1. initApi → waitForApiReady
2. actions.addAccount(address)
3. psdk.userInfo.load → userInfo (имя, аватар, about, language, ключи)
4. Callback → обновление userInfo в authStore, useUserStore
```

### При редактировании профиля

`UserEditForm.vue` → `authStore.editUserData(...)`:

1. Подготовка данных + `syncNodeTime()`
2. Broadcast в блокчейн (UserInfo transaction)
3. `userStore.setUser` — мгновенное обновление UI

### Проблема «имя не сохраняется»

Возможные причины:
1. **Нет PKOIN на адресе** — транзакция UserInfo требует средства
2. **Блокчейн не подтвердил** — поллинг завершился по таймауту
3. **Ключи не опубликованы** → `pendingRegProfile` + polling
4. **Legacy аккаунт** — старый формат UserInfo

### verifyAndRepublishKeys()

Вызывается при каждом входе:

```
Если в профиле (из блокчейна) < 12 ключей:
  → generateEncryptionKeys(privateKeyHex)  // 12 ключей BIP32
  → registerUserProfile / повторная публикация
  → Или pendingRegProfile + поллинг (если нет PKOIN)
```

## Синхронизация между Bastyon и Forta

### Общая крипто-идентичность

- Один приватный ключ работает в обоих приложениях
- Bastyon address = Forta address
- E2E ключи — одинаковая деривация (BIP32 m/33'/0'/0'/{1..12}')

### Что синхронизируется

| Данные | Источник | Направление |
|--------|----------|-------------|
| Имя, аватар, about | Bastyon blockchain | Двустороннее (через UserInfo tx) |
| E2E ключи (12 pubkeys) | Bastyon blockchain | Forta → blockchain при регистрации/входе |
| Подписки на каналы | Bastyon API | Bastyon → Forta (только чтение) |
| Чаты / сообщения | Matrix homeserver | Только через Matrix |
| Контакты | Matrix (DM rooms) | Только через Matrix |

### Чего НЕ синхронизируется

- **Список чатов** не передаётся между Bastyon Chat и Forta Chat
- **Сообщения из Bastyon Chat** — нет миграции (legacy bastyon-chat → forta.chat)
- **Настройки UI** — localStorage, привязано к устройству
- **Язык UI** — НЕ подтягивается из `userInfo.language` при входе

## Проблема «ключи не подходят между сервисами»

### Совместимость ключей

1. **BIP39 мнемоника из Forta** → работает в Forta, может НЕ работать в Bastyon
   - Forta: деривация `m/44'/0'/0'/0'`
   - Bastyon: может использовать другой путь или прямой WIF

2. **Приватный ключ из Bastyon (WIF)** → должен работать в Forta
   - `createKeyPair` поддерживает WIF и hex

3. **Seed phrase из Bastyon** → может НЕ работать если формат отличается
   - Bastyon может использовать другой BIP39-стандарт или другую деривацию

### Миграция из старого хранилища

В коде есть `storage-migration` (упоминается в тестах) — миграция localStorage из legacy bastyon-chat формата.

## Мультиаккаунт

### Хранение

- До 5 аккаунтов в `SessionManager`
- Активный: `forta-chat:activeAccount`

### Background Sync

`BackgroundSyncManager` (`src/entities/auth/model/background-sync.ts`):

```
Для неактивных аккаунтов:
  fetch(/_matrix/client/v3/sync?timeout=0&since={syncToken}&filter={SYNC_FILTER})
  → headers: { Authorization: Bearer {accessToken} }
  → При 401/403: stop
  → При success: обновление syncToken
```

### Переключение

```
switchAccount(address):
  → Демоция текущего в background
  → Активация нового
  → initMatrix заново
```

## Профили других пользователей

### Загрузка для E2E

В `initMatrix` для Pcrypto:
- `loadUsersInfo` (light) — из кэша SDK
- `loadUsersInfoRaw` (`getuserprofile`) — полный профиль с ключами

### Кэширование

`useUserStore` (`src/entities/user/model/user-store.ts`):
- Кэш: `localStorage("bastyon-chat-users")`
- Аватары, имена для UI

## Ключевые файлы

| Файл | Назначение |
|------|------------|
| `src/entities/auth/model/stores.ts` | Login, register, fetchUserInfo, verifyKeys |
| `src/entities/auth/model/session-manager.ts` | Multi-account localStorage |
| `src/entities/auth/model/key-pair.ts` | createKeyPair: mnemonic vs WIF vs hex |
| `src/entities/auth/model/background-sync.ts` | Background polling |
| `src/app/providers/initializers/app-initializer.ts` | Bastyon API calls |
| `src/entities/user/model/user-store.ts` | User profile cache |
| `src/features/user-management/ui/UserEditForm.vue` | Редактирование профиля |
| `src/entities/matrix/model/matrix-crypto.ts` | Pcrypto, ключи для E2E |
