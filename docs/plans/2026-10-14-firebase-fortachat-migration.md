# Переход пушей на Firebase-проект `fortachat` — план — 2026-10-14

> **Для новой сессии.** Вставить в первое сообщение:
>
> > Работаем по `docs/plans/2026-10-14-firebase-fortachat-migration.md`. Начни с раздела «Как
> > включить». Перед правкой сверь предпосылки с кодом — ориентируйся на имена функций.
>
> Правила сборки, тестов и ревью — в `AGENTS.md`. Этот план их не повторяет.

## Статус (2026-10-14)

Код перехода есть (`7c99fe38`, ветка `0910-version`), но **выключен**: промежуточный релиз
выходит на старом проекте `forta-chat`. Откат — только app_id в `push-service.ts` и нативные
конфиги; защита от дублей осталась в коде и при одном проекте ничего не делает.

| Что | Сейчас (старый) | После перехода (новый) |
|---|---|---|
| Firebase-проект | `forta-chat`, sender 606208981751 | `fortachat`, sender 792979239739 |
| `PUSHER_APP_ID_ANDROID` | `fortaandroid` | `fortaandroid2` |
| `PUSHER_APP_ID_IOS` | `fortaios` | `fortaios2` |
| VoIP (`fortaios.voip*`) | PushKit, Firebase не касается | без изменений |

## Где лежат конфиги

Конфиги в `.gitignore`, в репозитории их нет — только на машине сборки:

- в сборке: `android/app/google-services.json`, `ios/App/App/GoogleService-Info.plist`
  (сейчас старый проект);
- новый проект: `firebase-fortachat/google-services.json`,
  `firebase-fortachat/GoogleService-Info.plist`;
- старый проект: `google-services.json`, `GoogleService-Info.plist` в корне.

app_id и конфиги меняются **только вместе**: токен выдаёт проект из конфига, а Sygnal шлёт
по app_id через ключ своего проекта. Расхождение — FCM отклоняет отправителя, пуши не доходят.

## Как включить

1. В `src/shared/lib/push/push-service.ts`: `PUSHER_APP_ID_ANDROID = 'fortaandroid2'`,
   `PUSHER_APP_ID_IOS = 'fortaios2'`; поправить комментарий над константами.
2. Тесты под новые app_id: `push-service.test.ts` (`buildPusherPayload`),
   `push-service-logout.test.ts`; в `push-service-retry.test.ts` старый pusher снова
   `fortaandroid`, новый `fortaandroid2` (как в `7c99fe38`).
3. Скопировать конфиги из `firebase-fortachat/` в `android/app/` и `ios/App/App/`, затем
   `npx cap sync`.
4. До релиза подтвердить на сервере (владелец Sygnal на matrix.pocketnet.app): pushkins
   `fortaandroid2` и `fortaios2` настроены на ключи `fortachat`; `fortaandroid`/`fortaios`
   остаются для необновлённых установок. В проект `fortachat` загружен APNs-ключ для
   `com.forta.chat`.
5. Проверка на устройстве — запись «Переход на Firebase `fortachat`» в
   `docs/manual-verification.md` (обновление поверх релиза на старом проекте, один звук на
   сообщение, удаление старого pusher'а этого устройства).

## Что уже в коде и работает при любом проекте

- `PushSenderPolicy` / `PushTokenStore` (`android/.../plugins/push/PushSender.kt`): Android
  отбрасывает пуш другого Firebase-проекта, когда свой pusher уже зарегистрирован. «Свой» —
  проект из конфига сборки, поэтому при одном проекте ничего не отбрасывается.
- `isLegacyPusherEntry` + `onPusherRegistered`/`clearLegacyFcmToken`: после смены FCM-токена
  удаляется pusher этого устройства со старым токеном под любым app_id. При откате это же
  убирает `fortaandroid2` тестовых установок `0910-version`.

## Открыто

- iOS на старом проекте не выпускается (решение владельца, 2026-10-14): следующий iOS-релиз
  выходит только вместе с переходом. Аналога `PushSenderPolicy` на iOS нет, и старый `fortaios`
  pusher обновлённого устройства удаляется, только если сборка до перехода успела запомнить его
  токен в `push_own_pushkey`; владелец считает это допустимым.
- ~~`isStalePusherEntry` удалял pusher'ы своего app_id с чужим токеном, то есть и других
  Android-устройств того же аккаунта.~~ Исправлено 2026-10-22: устройство помнит свой последний
  pushkey (`push_own_pushkey`, `push_own_voip_pushkey`) и удаляет только pusher'ы своих прежних
  токенов.
