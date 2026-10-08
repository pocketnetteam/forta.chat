# Звонки: следующая сессия после чистки кода (2026-10-08)

Промпт для новой сессии — вставить целиком:

> Продолжаем работу по звонкам Forta Chat. Ветка `refactor/calls-cleanup-2026-10` (14 коммитов чистки поверх
> upstream master + ветки багханта, ничего не запушено). Прочитай `docs/plans/2026-10-08-calls-next-session.md`
> и память `forta-chat-calls-cleanup-2026-10`, `forta-chat-release-regression-2026-10`,
> `forta-chat-tor-findings-reminder`. Делай задачи по порядку из раздела «Задачи»; после каждой — короткий итог мне.

## Где мы

- Чистка по плану `~/.claude/plans/delightful-puzzling-fern.md` (Phase B) сделана: `call-service.ts` 2327 → 26 строк
  (фасад над `call-*.ts`), `CallConnection` в своём файле, исправления ревью 2026-10-04 C01–C05, C09 с тестами, один
  владелец 30-секундного дедлайна, документация. JS 5025 тестов, Kotlin 640, lint без новых ошибок.
- Релизная проверка (тестовый APK 1.13.9 `dbf8c20`) пройдена ранее: 18/20, регрессий нет.
- На Samsung SM-A528B (`R5CT316HB2T`) сейчас стоит релизная 1.13.9 (подпись `CN=Forta Chat`), вход TEST2. SIM MegaFon
  с мобильными данными. Веб-профили стенда: `.bench/web/profiles/test1-prod` (TEST1), `test2-prod` (TEST2),
  `test3-dev` (TEST3, дев-сервер `forta-dev`).
- Скрипты стенда в `.bench/` (git-ignored): `tools/ui.sh`, `samsung-call.sh`, `post-call-gate.sh`, `mv-append.py`,
  `app-conns.sh`; `web/call-run.mjs`, `answer-run.mjs`; `runs/rel/items.sh`, `series.sh`, `lte.sh`, `airpods.sh`,
  `freeze.sh`. Нажатия только по id/тексту и только когда сверху экран Forta; `ui.sh` отказывается жать под панелью
  навигации. Владелец ночью трогает телефон (настройки звука) — не жать по координатам вслепую.

## Задачи

Состояние на 2026-10-08 15:15: сделаны 1, 2, C02 и C05 из п. 3. Дальше — C09, затем C03 (нужен владелец), п. 4–7.
На Samsung отладочная сборка ветки, вход TEST2 (владелец входил заново после стирания Local Storage).

1. ✅ **Сделано 2026-10-08:** на Samsung стоит отладочная сборка ветки (`324053c2`), вход TEST2, CDP работает.
   ~~**Отладочная сборка ветки на Samsung.** `npm run build` → `npx cap sync android` → `cd android &&
   ./gradlew :app:assembleSideloadDebug`. Релизную 1.13.9 удалить (`adb uninstall com.forta.chat`; подписи разные),
   поставить отладочную, попросить владельца войти как TEST2. Проверить CDP к WebView
   (`adb forward tcp:9223 localabstract:webview_devtools_remote_<pid>`, `.bench/tools/cdp-eval.mjs`).~~ Если в ветке
   появятся новые коммиты с кодом — пересобрать и поставить `adb install -r` (подпись та же, вход сохранится).
2. ✅ **Сделано 2026-10-08 (`9c29766a`):** звонок 98 с пережил Wi-Fi → LTE → Wi-Fi, в консоли оба
   `[call-service] network …, restartIce`. ~~**Wi-Fi → LTE на сборке ветки.** `.bench/runs/rel/lte.sh lte-branch`: звонок веб → Samsung, на 15-й секунде
   `svc wifi disable`, через ~35 с `svc wifi enable`. Ожидается: звонок остаётся `connected`, после выключения через
   ~10 с новая пара `srflx/srflx`, после включения — `host/host`, гейт зелёный. Перенос кода смены сети
   (`call-engine-setup.ts`) — главный риск чистки для этого сценария. Записать статус в записи `9d1f1036`,
   `c2ed5f98`, `6b1b88cc` в `docs/manual-verification.md`.~~
3. **Новые записи «Ожидают проверки»** в `manual-verification.md` (по шагам в записях):
   - C02 — ✅ проверено 2026-10-08 (`59b64237`, задержка 30 с через `Capacitor.nativePromise`, `.bench/runs/rel/c02.sh`);
   - C03 «Микрофон отпускается, если звонок кончился, пока шёл запрос микрофона» — нужен отозванный доступ к микрофону
     (системная настройка — делает владелец);
   - C05 — ✅ проверено 2026-10-08 (`7b1f57de`); настройка возвращена во «включено»;
   - C09 «Поздний отбой прошлого звонка…» — TEST1 кладёт трубку, TEST3 звонит в ту же секунду; наблюдать.
4. **Находки по Tor** (напомнить владельцу, память `forta-chat-tor-findings-reminder`) — на отладочной сборке с CDP:
   отчёт о баге не уходит при Tor «Всегда»; длительность 164 с вместо 37 с после включения Tor; Tor из настроек без
   перезапуска идёт напрямую. Плюс решение владельца по правилу «Всегда напрямую до готовности Tor» (`ca30651c`).
5. **Ревью ветки:** `/code-review high` по `af29998d..HEAD` (по шагам не запускался).
6. **iOS:** собрать под XR (C05 добавил `getIncomingCallsEnabled` в `IOSPushIntentPlugin`), ловушка
   `npx cap sync ios` → `LlamaCppPro` в `ios/App/CapApp-SPM/Package.swift` откатить перед `xcodebuild`.
7. **По желанию:** разрезать `call-service.test.ts` (2957 строк) по модулям; удаление переключателя движка WebRTC —
   только после статистики отчётов и решения владельца.

## Проверки перед каждым коммитом

`npm run build`, `npm run test` (полный, в фоне), Kotlin `cd android && ./gradlew :app:testSideloadDebugUnitTest
--rerun-tasks` и `./gradlew :app:lintSideloadDebug` при изменениях в `android/`. Пуш — только по просьбе владельца.
