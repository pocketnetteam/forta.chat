# Архитектура: UX и онбординг

## Связь с проблемой

Пользователи сообщают: «не понимаю что делать дальше», «непонятно как установить», «где взять ключ?», «как войти?», «нужна видео-инструкция», «что выбрать из вариантов?», «это отдельное приложение или через браузер?».

## Путь нового пользователя

### Маршруты (FSD)

```
src/app/providers/router/routes/
  ├── welcome.ts   → /welcome (requiresGuest)
  ├── login.ts     → /login   (requiresGuest)
  ├── register.ts  → /register (requiresGuest)
  ├── chat.ts      → /chat    (requiresAuth)
  ├── invite.ts    → /invite  → localStorage + redirect → /welcome
  └── join.ts      → /join    → localStorage + redirect → /welcome
```

### Стандартный поток

```
/welcome → /register (или /login) → /chat
```

### Welcome экран (`WelcomePage.vue`)

- Логотип Forta Chat
- Заголовок `welcome.title`, описание `welcome.description`
- Кнопка **«Get Started»** → `/login`
- Кнопка **«Create account»** → `/register`
- Переключатель языка: «English» / «Русский» (хардкод)

**Нет:**
- Описания что это за приложение и чем отличается от Bastyon
- Инструкции как установить (PWA, APK)
- Пояснения про типы входа (ключ vs создание аккаунта)

### Регистрация (3 шага)

**Шаг 1 — Профиль** (`ProfileStep.vue`):
- Имя (валидация через RPC)
- Аватар (опционально)
- Согласие с Terms/Privacy (ссылки на HTML)
- При сабмите: генерация ключей + поиск прокси — **может зависнуть**

**Шаг 2 — Капча** (`CaptchaStep.vue`):
- SVG-изображение
- Текстовый ввод

**Шаг 3 — Мнемоника** (`SaveMnemonicStep.vue`):
- Показ 12 слов
- Предупреждение: `register.saveMnemonicWarning` — «записать, единственный способ восстановления»
- Чекбокс подтверждения
- Кнопка завершения → `authStore.register()` → `/chat`

**После отправки:** `RegistrationStepper.vue` (оверлей в `App.vue`) — прогресс блокчейн-подтверждения.

### Вход (`LoginForm.vue`)

- Одно поле: мнемоника ИЛИ приватный ключ (hex/WIF)
- Подсказка: `auth.keyNeverLeaves`
- Кнопка **«?»** → `public/help/how-to-get-private-key.html`
- Маскировка: `PrivateKeyInput.vue` с toggle show/hide

## Справочные материалы

### В приложении

| Материал | Формат | Где |
|----------|--------|-----|
| Справка по ключу | HTML-страница | `public/help/how-to-get-private-key.html` — открывается из LoginForm |
| Terms of Service | HTML | `public/terms.html` — из шага регистрации |
| Privacy Policy | HTML | `public/privacy.html` — из шага регистрации |

### Чего нет

- **Onboarding tour / walkthrough** — нет spotlight, coach marks, пошагового тура
- **Видео-инструкции** — нет
- **FAQ внутри приложения** — нет (SettingsPage без help-раздела)
- **Интерактивные подсказки** — нет
- **Объяснение «Bastyon vs Forta»** — нет

## Invite-ссылки

### Персональное приглашение (1:1)

`InviteModal.vue` в features/invite:

```
Ссылка: {APP_PUBLIC_URL}/#/invite?ref={address}
```

- Копирование, нативный Share, соцсети (web)
- При переходе: `localStorage("bastyon-chat-referral")` → redirect → welcome

**После авторизации:** `App.vue` → `processReferral()`:
- `getOrCreateRoom(ref)` → создание чата с пригласившим
- Переход в этот чат

### Приглашение в группу (join link)

`ChatInfoPanel.vue`:
```
Ссылка: {APP_PUBLIC_URL}/#/join?room={encodeURIComponent(roomId)}
```

При переходе:
- `localStorage("bastyon-chat-join-room")` → redirect → welcome
- После авторизации: `processJoinRoom()` → `chatStore.joinRoomById(roomId)`

### Ограничение

Если пользователь **не залогинен**, ссылка только «запоминается» до входа. Нет промежуточного экрана «Вас пригласили в комнату X».

## Matrix invites (внутренние)

Отдельный поток — приглашения через Matrix membership:
- Комнаты с `membership === "invite"` в списке
- `acceptInvite()` / `declineInvite()` в `chat-store.ts`
- UI: `ChatWindow.vue` (баннер принятия/отклонения)

## Контекст Bastyon в приложении

### Смешанный брендинг

- UI: «Forta Chat» (welcome.title, titleBar.appName)
- Некоторые строки: «подпишитесь на каналы в Bastyon»
- `post.openInBastyon` → переведено как «Open in Forta»
- Технический legacy: `bastyon-chat-*` в localStorage, ссылки `bastyon://user?...`

### Справка по ключу

`how-to-get-private-key.html`:
- Заголовок: «Bastyon Private Key»
- Содержимое ориентировано на Bastyon, не Forta
- Переключение языка через `?lang=`

## Auth Guard

`src/app/providers/router/handlers/auth-guard.ts`:

- `requiresAuth` без сессии → `/welcome?redirect={originalPath}`
- `requiresGuest` с сессией → `/chat`

## Ключевые файлы

| Файл | Назначение |
|------|------------|
| `src/pages/welcome/WelcomePage.vue` | Экран приветствия |
| `src/pages/login/LoginPage.vue` | Страница входа |
| `src/pages/register/RegisterPage.vue` | Страница регистрации |
| `src/features/auth/ui/login-form/LoginForm.vue` | Форма входа |
| `src/features/auth/ui/register-form/RegisterForm.vue` | Форма регистрации (3 шага) |
| `src/features/auth/ui/register-form/ProfileStep.vue` | Шаг 1 |
| `src/features/auth/ui/register-form/CaptchaStep.vue` | Шаг 2 |
| `src/features/auth/ui/register-form/SaveMnemonicStep.vue` | Шаг 3 |
| `src/features/auth/ui/RegistrationStepper.vue` | Оверлей ожидания |
| `src/features/auth/ui/login-form/PrivateKeyInput.vue` | Маскированный ввод ключа |
| `src/features/invite/ui/InviteModal.vue` | Модалка приглашения |
| `src/features/chat-info/ui/ChatInfoPanel.vue` | Ссылка в группу |
| `src/app/App.vue` | processReferral, processJoinRoom |
| `src/app/providers/router/handlers/auth-guard.ts` | Guard маршрутов |
| `public/help/how-to-get-private-key.html` | Справка по ключу |
| `public/terms.html` | Terms of Service |
| `public/privacy.html` | Privacy Policy |
