# Чеклист проверки фиксов звонков

Дата: 2026-09-07. Ветка: 33 незапушенных коммита поверх `origin/master` (`66ae28ce`, релиз 1.12.1). Отчётов о звонках в трекере на эту дату: 91 открытых (кластеры: нет звука 43, застрял после звонка 37, видео 11, двойной звонок 11, динамик 10, не соединяется 8, кнопка приёма 6, нет рингтона 4, качество 3, фон 2, прочее 4; пересекаются).

Два списка: **1** — что исправлено на ветке, с шагами воспроизведения на старой сборке и проверки на новой; **2** — что ещё открыто. Дальше план. Состояние чекбоксов сохраняет страница: https://claude.ai/code/artifact/7bbf3a5b-2db0-474c-a305-ace0ae23f09d (приватная, статусы и заметки читаются оттуда напрямую). Здесь можно ставить `[x]`.

## Стенд и сборки

**Что есть:** Samsung (модель впишите на странице), Pixel, два эмулятора Pixel API 35 с Maestro, аккаунты `TEST1`/`TEST2` в `.env`, веб-клиент Forta как третья сторона.

### Две сборки

Старая = `origin/master` (`66ae28ce`, релиз 1.12.1). Новая = HEAD ветки, 33 коммита сверху. `applicationId` один, поэтому ставим по очереди: старую → воспроизвели → новую поверх (`adb install -r`). Аккаунт и данные сохраняются. Шесть пунктов (F18, F19, F06, F03, F05, F14) проверяются именно как обновление поверх старой установки.

**Вариант А, рекомендую.** Сборка через CI «Android Test APK». Только она содержит `google-services.json` и токен отправки отчётов, то есть push и кнопка «Сообщить о проблеме» работают только в ней.

1. Запушить ветку под отдельным именем, не в `master`:
   ```bash
   git push origin master:calls-stabilization
   ```
2. GitHub → Actions → Android Test APK → Run workflow → ветка `master`. После сборки скачать `https://forta.chat/apktests/latest.apk` и сохранить как `forta-old.apk`.
3. Run workflow ещё раз → ветка `calls-stabilization` → скачать как `forta-new.apk`. `versionCode` у неё выше, ставится поверх старой.

**Вариант Б, локально.** Без push и без отправки отчётов, если не положить `android/app/google-services.json` (скачивается из Firebase console проекта) и `VITE_BUG_REPORT_TOKEN` в `.env`.

```bash
git worktree add ../forta-old origin/master
cd ../forta-old && npm ci --legacy-peer-deps && npm run cap:build && cd android && ./gradlew assembleSideloadDebug
cp app/build/outputs/apk/sideload/debug/app-sideload-debug.apk ~/forta-old.apk
```
```bash
npm run cap:build && cd android && ./gradlew assembleSideloadDebug && cd ..
cp android/app/build/outputs/apk/sideload/debug/app-sideload-debug.apk ~/forta-new.apk
```

Пометка «нужна CI-сборка» в пункте означает сценарий с push, убитым процессом, шторкой уведомлений или отправкой отчёта.

### Команды под рукой

| Что | Команда | На что смотреть |
|---|---|---|
| Режим аудио | `adb shell dumpsys audio \| grep -i mode` | В покое `MODE_NORMAL`. `MODE_RINGTONE` или `MODE_IN_COMMUNICATION` без звонка = застряло |
| Лог звонков | `adb logcat -s CallPlugin CallConnectionService CallForegroundService AudioRouter AudioLifecycle NativeWebRTCManager WebRTCPlugin IncomingCallActivity CallActivity FortaPush` | Строки из пунктов ниже |
| Telecom | `adb shell dumpsys telecom` | Наличие живого `Connection` после завершения звонка |
| Версия WebView | `adb shell dumpsys package com.google.android.webview \| grep versionName` | 73% отчётов с 148–152 |
| Два телефона | `adb devices`, затем `adb -s <serial> …` | |
| Maestro на телефонах | `DEVICE_A=<serial Samsung> DEVICE_B=<serial Pixel> scripts/e2e-call.sh` | Сквозной звонок между двумя реальными аппаратами |

### Как отмечать

Страница с чекбоксами сохраняет статусы и заметки сама. В этом файле можно ставить `[x]`. Для «не исправлен» приложите то, что перечислено в пункте, и отправьте отчёт из приложения с выбранным симптомом (нужна CI-сборка): в него попадёт таймлайн аудио.


## Список 1. Исправлено на ветке, ждёт проверки

Обозначения: **Где** — на чём проверять; **Можно ли** — выполнимо ли на вашем стенде; «нужна CI-сборка» см. выше.


### Завершение звонка и аудиорежим


- [ ] **F01. Микрофон остаётся занятым после смахивания приложения из недавних; протёкшая дорожка ломает следующий звонок (#997)**
  - Коммиты: `00ddc636` · Отчёты: [#997](https://github.com/greenShirtMystery/forta-bugs/issues/997) · Кластер: call-teardown-resource-leak
  - Где: Samsung и Pixel · Можно ли: можно проверить · Нужно: Pixel real device или Samsung real device (аппарат с mic-индикатором на Android 12+); Две тестовые учётные записи TEST1/TEST2 в .env; Locally built debug APK (или CI test APK если требуется функция с FLAG — но для этого теста базовая установка достаточна); adb подключение к устройству или эмулятору
  - Ограничения: Жест свайпа-из-недавних (Recents) требует ручного выполнения на реальном устройстве; Maestro не может симулировать системный жест ОС и поэтому не может быть использован для автоматизации этого шага. Микрофонный индикатор (точка в статус-баре) существует только на Android 12+; на Android 11 и ниже визуальная проверка индикатора пропускается, полагаемся на logcat и функциональность второго звонка. Все остальные шаги (установка APK, запуск звонка, проверка logcat, второй звонок, проверка звука) полностью автоматизируемы или прямолинейно верифицируемы на имеющемся оборудовании.
  - Симптом: Пользователь свайпит приложение из недавних во время видеозвонка. Микрофон остаётся занятым (системный индикатор доступа на Android 12+ не погасает). Следующий входящий звонок соединяется, но звука нет — другая сторона слышит, но к этому аппарату звук не приходит.
  - Причина: CallForegroundService.onTaskRemoved/onDestroy вызывали AudioRouter.forceStop() для сброса аудиорежима, но никогда не вызывали closeAllPeerConnections() для закрытия WebRTC захвата. Это оставляло AudioRecord процесса занятым. В следующем звонке startLocalAudio() (NativeWebRTCManager.kt:1138) видел, что localAudioTrack != null, и возвращалась с ранний выход, переиспользуя мёртвую дорожку из предыдущего соединения. Путь: CallForegroundService.kt:204–272 (baseline), NativeWebRTCManager.kt:1137–1149 (ранний выход).
  - Воспроизвести на старой сборке:
    1. Установить baseline debug APK: adb install android/app/build/outputs/apk/sideload/debug/app-sideload-debug.apk
    2. На первом аппарате (звонящий): позвонить на TEST2 аккаунт
    3. На втором аппарате (принимающий TEST2): ответить; дождаться соединения
    4. На втором аппарате: свайпнуть приложение снизу вверх из Recent Apps (во время активного звонка) — это РУЧНАЯ ОПЕРАЦИЯ, не может быть автоматизирована
    5. На Android 12+: проверить статус-бар — mic-индикатор (точка) должен остаться видимым; Settings > Apps & notifications > Permissions > Microphone должен значить Forta Chat как using
    6. На первом аппарате: нажать красную кнопку или дождаться timeout (~30 сек)
    7. На втором аппарате: позвонить на TEST1 сразу же (в течение 2–3 сек, с запасом на завершение teardown первого вызова)
    8. На первом аппарате: answer; проверить звук — обе стороны должны слышать друг друга
    Признак бага: На Android 12+: mic-индикатор в статус-баре остаётся видимым (точка в углу экрана); Settings показывает Forta Chat как using microphone; второй звонок — audio только в одну сторону (вторая сторона слышит первого, но первого не слышит второй).
  - Проверить на новой сборке:
    1. Установить HEAD debug APK (тот же подпись, данные сохранятся): adb install -r android/app/build/outputs/apk/sideload/debug/app-sideload-debug.apk
    2. На первом аппарате: позвонить на TEST2
    3. На втором аппарате: answer, дождаться соединения
    4. На втором аппарате: свайпнуть приложение из Recent Apps во время звонка (РУЧНАЯ ОПЕРАЦИЯ; Maestro не может симулировать жест ОС)
    5. На Android 12+: mic-индикатор в статус-баре должен исчезнуть в течение 1 сек. На Android 11 и ниже: нет системного индикатора, пропустить эту проверку.
    6. Проверить logcat (пока второй аппарат выполняет шаги ниже): adb logcat -s CallForegroundService NativeWebRTCManager 2>&1 | grep -E 'onTaskRemoved|All PeerConnections closed' — ожидать 'All PeerConnections closed' в течение 2 сек после свайпа
    7. На первом аппарате: end call или дождаться timeout
    8. На втором аппарате: позвонить на TEST1 в течение 2–3 сек (дать старому сервису время на завершение если ещё не завершился)
    9. На первом аппарате: answer; проверить звук — обе стороны слышат друг друга (звук в обе стороны подтверждает что протёкшая дорожка не отравила новый вызов)
    Ожидаемо: mic-индикатор исчезает в течение 1 сек (Android 12+); logcat показывает 'All PeerConnections closed' в течение 2 сек после свайпа; второй звонок имеет работающее аудио в обе стороны (обе стороны друг друга слышат).
    Лог: adb logcat -s CallForegroundService NativeWebRTCManager 2>&1 | grep -E 'onTaskRemoved|All PeerConnections closed|track already exists, reusing' Ожидаемый порядок событий (в течение 2 сек после свайпа): 1. 'onTaskRemoved on a superseded instance' (опционально, если есть гонка) ИЛИ 'onTaskRemoved' (если это первый вызов) 2. 'All PeerConnections closed' (доказывает closeAllPeerConnections) На втором звонке: 3. (опционально) 'track already exists, reusing' (нормально на HEAD, старый трек disposed)
    adb: После свайпа: adb logcat -s CallForegroundService NativeWebRTCManager 2>&1 | grep -E 'onTaskRemoved|All PeerConnections closed' — должна появиться 'All PeerConnections closed' в течение 2 сек (доказывает что closeAllPeerConnections() вызвался и выполнился)
    adb: На втором звонке: adb logcat -s NativeWebRTCManager 2>&1 | grep 'track already exists, reusing' — если эта строка появляется, старый трек был переиспользован (это OK на HEAD, он уже disposed; на baseline это был бы баг). На HEAD звук должен работать несмотря на переиспользование, потому что старая дорожка properly disposed.
    adb: (Опционально, если есть Android 12+) Mic indicator check: Settings > Apps & notifications > Permissions > Microphone (Pixel) или Settings > Apps > Permissions > Microphone (Samsung) — после свайпа Forta Chat должен исчезнуть из списка использующих приложений
  - Если не исправлен, приложить: Полный logcat после свайпа и до конца второго звонка: adb logcat > /tmp/f01-logcat.txt, потом adb bugreport /tmp/f01-bugreport.zip (включает все системные логи и audio HAL events); На видео второго звонка на 30+ сек: камера вторая сторона должна показывать движение чтобы проверить что это действительно call, не frozen или crashed UI; Версия WebView: adb shell dumpsys webview | grep 'Current WebView package' (важно что это не старая версия с broken audio capture)
  - Автотесты: CallForegroundServiceDestroyContractTest.kt:167–189 — onDestroy_releasesTheCapturePath, onTaskRemoved_releasesTheCapturePath (доказывает что closeAllPeerConnections вызывается на обоих путях завершения); CallForegroundServiceDestroyContractTest.kt:191–206 — captureTeardownIsDispatchedOffTheLifecycleThread (доказывает что releaseMediaAsync использует mediaReleaseExecutor, не блокирует main thread на stopCapture); CallForegroundServiceDestroyContractTest.kt:227–247 — teardown_skipsGlobalCleanupWhenANewerInstanceHasTakenOver, supersededCheck_comparesIdentity_notMereNullness (доказывает что старый экземпляр не убивает новый звонок; гонка защищена)
  - Запись в `docs/manual-verification.md`: «Микрофон освобождается после смахивания приложения из «недавних»; второй звонок имеет двусторонний звук»


- [ ] **F02. Отложенный onDestroy старого экземпляра сервиса глушит новый звонок, начатый сразу после предыдущего**
  - Коммиты: `00ddc636` · Кластер: phone-stuck-after-call-audio-mode-leak
  - Где: Samsung · Можно ли: можно проверить · Нужно: две учётные записи (TEST1/TEST2 из .env); веб-клиент как третья сторона (опционально); adb на реальном аппарате (Samsung предпочтителен из-за отложенного onDestroy)
  - Ограничения: Гонца воспроизводится только на реальном планировщике ОС; на эмуляторе Maestro timing отличается из-за синхронного main-looper'а и отсутствия Doze-подобного отложения. Samsung охотнее откладывает onDestroy на 30–60 сек, Pixel обычно завершает быстрее. Baseline и new build должны быть установлены последовательно (old→new) с одинаковой подписью для сохранения данных пользователя.
  - Симптом: При завершении звонка и немедленном начале нового (в течение 1–2 секунд) второй звонок либо вообще не передаёт звук, либо теряет соединение в первые 5 секунд, потому что отложенный onDestroy() старого экземпляра сервиса сбрасывает глобальный аудиорежим и закрывает WebRTC соединения уже работающего разговора.
  - Причина: android/app/src/main/java/com/forta/chat/plugins/calls/CallForegroundService.kt, line ~110–130: оба пути завершения сервиса (onDestroy и onTaskRemoved) выполняют процессно-глобальный teardown (AudioRouter.forceStop(), closeAllPeerConnections) без проверки, была ли власть над сервисом передана новому экземпляру. stopSelf() → onDestroy() асинхронен, и на OEM ROM'ах откладывается на минуты — старый экземпляр может выполнить teardown после того, как новый уже начал разговор. Фикс: isSuperseded() проверяет, был ли текущий экземпляр заменён (instance !== this), и пропускает процессно-глобальную очистку.
  - Воспроизвести на старой сборке:
    1. Установить baseline (OLD) APK: `adb install -r build/outputs/apk/debug/app-debug.apk` (или скопировать из CI outputs)
    2. TEST1 звонит TEST2 (или веб-клиенту), дожидаются соединения и подтверждают звук в обе стороны (≥3 сек соединённой линии)
    3. Смахнуть приложение из Recents прямо во время разговора — это запускает onTaskRemoved + отложенный onDestroy
    4. **Сразу же** (в течение 1–2 сек, пока старый сервис ещё жив) позвонить снова
    5. Ответить на второй звонок
    Признак бага: Второй звонок не передаёт звук (обе стороны молчат) или теряет соединение в течение 5 сек. В logcat видны строки `AudioRouter.forceStop()` или `closeAllPeerConnections` уже после того, как новый сервис запустился. Микрофон в статус-баре может остаться активным, аудиорежим зависнуть в MODE_IN_COMMUNICATION.
  - Проверить на новой сборке:
    1. Установить new build (HEAD) поверх old: `adb install -r build/outputs/apk/debug/app-debug.apk` (applicationId com.forta.chat, debug signature, данные сохранены)
    2. Повторить ровно те же шаги: звонок → завершение → новый звонок в течение 1–2 сек
    3. Второй звонок обязан передавать звук в обе стороны в течение 2 сек после соединения
    4. В logcat найти `on a superseded instance - skipping global teardown` (в logline из onDestroy или onTaskRemoved) — это доказывает, что старый экземпляр пропустил глобальный teardown
    5. Повторить 5–10 раз (гонца не гарантируется на каждом прогоне)
    6. Проверить: `adb shell dumpsys audio | grep 'MODE_IN_COMMUNICATION'` — должно быть MODE_IN_COMMUNICATION (установленное новым сервисом)
    Ожидаемо: Logcat содержит `on a superseded instance - skipping global teardown`; второй звонок соединяется без задержек, звук работает в обе стороны, соединение устойчиво. После 5–10 повторов все прогоны успешны. Старый экземпляр явно пропускает глобальную очистку, новый сервис полностью управляет аудиосистемой.
    Лог: adb logcat CallForegroundService:W AudioRouter:W CallConnectionService:W | grep -E 'on a superseded instance|forceStop|onDestroy|onTaskRemoved' — ищите `on a superseded instance - skipping global teardown` в выводе; временные метки в logcat должны показать, что эта строка появляется ПОСЛЕ того, как новый сервис запустился (по меткам времени и логам Init или onCreate из нового экземпляра).
    adb: adb shell dumpsys audio | grep 'MODE_IN_COMMUNICATION\|MODE_NORMAL' — после соединения второго звонка должно быть MODE_IN_COMMUNICATION (установленное новым сервисом), не MODE_NORMAL
    adb: adb shell dumpsys telecom | grep -E 'CallState|ACTIVE|DIALING' — проверить, что активное соединение находится в состоянии ACTIVE или DIALING (не DISCONNECTED)
  - Если не исправлен, приложить: Full logcat buffer (adb logcat -G 32M) за 10 полных циклов звонков (от инициализации старого до полного завершения следующего цикла); команда: `adb logcat -b main -b events > /tmp/logcat-f02.txt` параллельно с воспроизведением; Точные временные метки из logcat: когда первый звонок закончился, когда второй начался, когда произошло соединение, когда потерялся звук (если потерялся) — используйте `grep -n 'TIME_PATTERN\|superseded\|forceStop\|soConnection' /tmp/logcat-f02.txt`; Состояние аудиосистемы после сбоя: `adb shell dumpsys audio > /tmp/audio-dump.txt` и `adb shell dumpsys telecom > /tmp/telecom-dump.txt`, `adb shell dumpsys media_router > /tmp/router-dump.txt` — может быть подсказка о зависшем маршруте или оставленных фокусах; Информация об аппарате: `adb shell getprop ro.build.fingerprint` (прошивка), `getprop ro.version.release` (версия Android), `getprop ro.product.manufacturer` (производитель) — разные OEM'ы по-разному откладывают onDestroy; На каких условиях повторяется: реальный аппарат vs эмулятор, только при смахивании vs другие пути завершения, первый повтор или каждый раз, Samsung vs Pixel vs другой vendor
  - Автотесты: android/app/src/test/java/com/forta/chat/plugins/calls/CallForegroundServiceDestroyContractTest.kt — unit assertions проверяют, что isSuperseded() guard существует и стоит перед forceStop(); тесты `teardown_skipsGlobalCleanupWhenANewerInstanceHasTakenOver`, `destroyOnSupersededInstance_doesNotModifyGlobalAudioMode`; android/app/src/test/java/com/forta/chat/plugins/calls/AudioRouterStrandedModeTest.kt — проверяет логику усыновления зависшего режима (shouldAdoptStrandedMode)
  - Запись в `docs/manual-verification.md`: «Разговор переживает завершение предыдущего звонка»


- [ ] **F03. Зависший звонок отпускается при возврате в приложение**
  - Коммиты: `00ddc636` · Отчёты: [#928](https://github.com/greenShirtMystery/forta-bugs/issues/928), [#958](https://github.com/greenShirtMystery/forta-bugs/issues/958) · Кластер: Stuck in MODE_RINGTONE after stale incoming call
  - Где: Samsung и Pixel · Можно ли: можно проверить · Нужно: Реальное устройство с Doze (предпочтительно Pixel или Samsung); Аккаунт TEST2 для входящего вызова (веб-клиент или другое устройство); adb доступ
  - Ограничения: На эмуляторе поведение Doze и Telecom отличается от реальных устройств. Требует точной синхронизации входящего вызова с действиями (тайминг критичен — нужно смахнуть ДО 45-секундного дедлайна соединения). Может потребоваться несколько попыток для воспроизводства.
  - Симптом: После входящего звонка, который долго гремел без ответа, устройство застревает в режиме MODE_RINGTONE; регулятор громкости медиа-потока перестаёт работать, ползунок остаётся заблокирован в режиме звонка.
  - Причина: CallConnection.armRingTimeout — таймер на основном потоке (45 сек) для автоматического сброса звонка; Doze или замороженный процесс может отложить его срабатывание. Соединение остаётся в RINGING, Telecom продолжает держать MODE_RINGTONE. Фикс: app-resume watchdog вызывает CallConnectionService.releaseStaleRingingConnection() для соединения, которое перешло дедлайн в 45 секунд (android/app/src/main/java/com/forta/chat/plugins/calls/StaleCallPolicy.kt:46).
  - Воспроизвести на старой сборке:
    1. Дождаться входящего звонка (от TEST2 на веб-клиента или другого устройства)
    2. Оставить звонок гремящим БЕЗ ответа и БЕЗ отклонения (на 45+ секунд)
    3. Пока звонок ещё в RINGING (не дождаться, пока звонящий положит трубку): смахнуть приложение из 'Недавних' (или закрыть через диспетчер задач)
    4. Убедиться, что приложение закрыто. Дождаться ≥45 секунд в фоне (или дождаться, пока звонящий положит трубку — что произойдёт раньше)
    5. Вернуться в приложение (тап иконки Forta)
    Признак бага: После возврата в приложение: регулятор громкости (физические кнопки) не управляет медиа-громкостью (ползунок остаётся заблокирован на громкости звонка); приложение не закрашивает экран входящего, звонка нет, но режим остался.
  - Проверить на новой сборке:
    1. Сразу после возврата в приложение открыть: adb logcat -s CallConnectionService
    2. Найти строку вида: 'Releasing a connection stuck RINGING past its deadline: <callId>'
    3. Проверить режим аудио через регулятор громкости (физические кнопки громкости медиа) — должен управляться нормально (ползунок в медиа-громкости, а не в громкости звонка)
    4. (Опционально) Проверить `adb shell dumpsys audio | grep -i mode` — режим должен вернуться в нормальный (формат зависит от версии Android и производителя)
    5. Сразу же позвонить снова (от того же TEST2) → звук должен быть в обе стороны
    Ожидаемо: Logcat содержит ровно одну строку про 'Releasing a connection stuck RINGING past its deadline'; регулятор громкости медиа управляется нормально; новый вызов подключается с двусторонним звуком.
    Лог: adb logcat -s CallConnectionService — ищем 'Releasing a connection stuck RINGING past its deadline' (проверить наличие строки, не более одной за цикл репродукции)
    adb: adb shell getprop ro.model.name — модель для классификации в отчёт
    adb: adb shell getprop ro.build.version.release — версия Android для отчёта
    adb: adb shell dumpsys audio 2>/dev/null | grep -i 'mode\|ringer' — попытка проверить режим (формат и наличие поля зависит от OEM и Android версии)
  - Если не исправлен, приложить: adb logcat -b all > logcat-stale-ring.txt — полный лог с момента входящего до 10 сек после возврата; искать CallConnectionService, AudioRouter; adb shell dumpsys audio > audio-state.txt — весь аудио-стек; adb shell getprop ro.model.name && adb shell getprop ro.build.version.release — девайс и Android для классификации; Сколько времени приложение было в фоне; Положил ли звонящий трубку сам или истёк таймаут
  - Автотесты: android/app/src/test/java/com/forta/chat/plugins/calls/StaleCallPolicyTest.kt — unit-тесты для StaleCallPolicy: 'a connection that outlived the ring timeout is stale', 'a connection still inside the ring window is not stale', guard на RING_TIMEOUT_MS > 30s; android/app/src/test/java/com/forta/chat/plugins/calls/CallForegroundServiceDestroyContractTest.kt — lifecycle проверка closeAllPeerConnections и onDestroy контракта; android/app/src/test/java/com/forta/chat/plugins/calls/IncomingCallAcceptGuardTest.kt — 'does NOT crash if accept lands milliseconds before ring timeout', защита от race condition на boundary 45 сек; src/features/video-calls/model/audio-watchdog.test.ts — watchdog тесты: вызов releaseStaleRingingCall и verify вызовов; src/features/video-calls/model/call-service.test.ts — call lifecycle тесты с аудио-вотчдогом
  - Запись в `docs/manual-verification.md`: «Зависший звонок отпускается при возврате в приложение»


- [ ] **F04. Гонка авто-сброса и ручного освобождения соединения (atomic release latch)**
  - Коммиты: `00ddc636` · Отчёты: [#997](https://github.com/greenShirtMystery/forta-bugs/issues/997), [#958](https://github.com/greenShirtMystery/forta-bugs/issues/958), [#928](https://github.com/greenShirtMystery/forta-bugs/issues/928), [#1183](https://github.com/greenShirtMystery/forta-bugs/issues/1183) · Кластер: release-latch
  - Где: Samsung и Pixel · Можно ли: можно проверить · Нужно: локально собранный debug APK (без FCM, без отправки отчётов)
  - Ограничения: Без google-services.json локально не работает FCM и отправка отчётов; для фаз с процесс-киллом или notif-shade нужен CI test APK. На этом Mac нет Samsung/Pixel физических — используются реальные устройства владельца + два Pixel API-35 эмулятора (Maestro flows).
  - Симптом: Микрофон после смахивания приложения — индикатор в статус-баре не гаснет, следующий звонок безмолвен (AudioRecord held). Новый звонок сразу после старого теряет звук (service race). Входящий звонок зависает на 45+ сек с отключённым FSI, громкость медиа не работает. Accept на границе таймаута может crash/ANR. Вместе — самый большой кластер «телефон зависает».
  - Причина: AudioRouter.stop() не вызывает closeAllPeerConnections(), оставляя AudioRecord held после swipe-to-remove. 2. stopSelf()→onDestroy() асинхронно; OEM ROM может отложить старый экземпляр, он перепишет аудиорежим нового. 3. Backstop 45-сек Runnable может быть отложен Doze; check-then-set в released AtomicBoolean без CAS atomicity. 4. onAnswer/onReject/onDisconnect не охраняют Telecom transition; выброс из main looper Runnable убивает процесс. Fix: shouldAdoptStrandedMode condition + forceStop action, isDestroyingOldInstance check, releaseStaleRingingConnection + StaleCallPolicy.isStaleRinging, try/catch на callbacks.
  - Воспроизвести на старой сборке:
    1. AudioRecord: позвонить, дождаться соединения, смахнуть приложение из недавних (свайп вверх) во время разговора → индикатор микрофона в статус-баре НЕ гаснет → позвонить снова → второй звонок безмолвен.
    2. Service race: завершить звонок, сразу начать новый 10 раз подряд → гонка срабатывает 1–2 раза, звук пропадает.
    3. MODE_RINGTONE: Настройки→Приложения→Forta Chat→Уведомления→входящие звонки → отключить Full-Screen Intent → дождаться входящего звонка → НЕ трогать уведомление → 45+ сек → звонящий кладет трубку → свернуть на 1 минуту (свайп вверх из gesture bar) → открыть приложение.
    4. Accept deadline: позвонить, на 44–46-й секунде нажать зелёную кнопку 5 раз подряд → может быть crash, ANR или зависание.
    Признак бага: 1: индикатор микрофона не гаснет, второй зв. безмолвен (AudioRecord held). 2: гонка на 1–2 повторах, звук пропадает. 3: после resume в logcat НЕТ 'Releasing', dumpsys audio показывает MODE_RINGTONE. 4: crash, ANR или зависание приложения.
  - Проверить на новой сборке:
    1. AudioRecord: позвонить, дождаться соединения (двусторонний звук), смахнуть приложение (свайп вверх) → индикатор гаснет за ≤1 сек → позвонить снова → звук в обе стороны (дорожка не отравлена).
    2. Service race: завершить звонок, сразу начать новый 10 раз подряд → все соединяются успешно, двусторонний звук на каждом, ни один старый экземпляр НЕ сбросил аудиорежим.
    3. MODE_RINGTONE: отключить Full-Screen Intent, дождаться входящего, 45+ сек, звонящий кладет, свернуть на 1 минуту, открыть → `adb logcat -s CallConnectionService | grep Releasing` показывает 'Releasing a connection stuck RINGING past its deadline' → громкость медиа работает.
    4. Accept: позвонить, на 44–46-й сек нажать 5 раз → НЕ crashes, НЕ ANR, все попытки graceful; logcat может показать 'onAnswer: connection already released' (guard сработал).
    Ожидаемо: 1: индикатор гаснет за ≤1 сек, второй зв. имеет звук. 2: все 10 успешны, двусторонний звук на каждом. 3: logcat содержит 'Releasing a connection stuck RINGING...', громкость работает, dumpsys audio показывает mode=NORMAL. 4: zero crashes/ANR, graceful transitions, разрешены benign logs вроде 'already released'.
    Лог: adb logcat -s 'AudioRouter|CallConnection|CallForegroundService|CallConnectionService' — ищите 'releaseMediaAsync', 'closeAllPeerConnections called', 'Releasing a connection stuck RINGING past its deadline', 'onAnswer: connection already released', 'onReject: already released', 'onDisconnect: already released'; никаких Exception или FATAL в контексте Telecom.
    adb: adb shell dumpsys audio | grep -E 'mode|MODE' — MODE_NORMAL между/после звонков, не IN_COMMUNICATION и не RINGTONE.
    adb: adb logcat -s 'CallConnectionService' | grep -E 'onAnswer|onReject|onDisconnect|Releasing' — graceful transitions, БЕЗ Exception/FATAL; оба направления (incoming/outgoing) должны завершаться cleanly.
  - Если не исправлен, приложить: adb logcat > crash.txt (если crash на шаге 4) — полный лог для post-mortem.; adb logcat -s AudioRouter > audio-router.txt (сценарий 1: 10 сек до + 5 сек после смахивания) — ищите stop() calls и closeAllPeerConnections.; adb logcat -s CallForegroundService > service-race.txt (сценарий 2: 20 сек) — конфликтующие setAudioMode от разных экземпляров.; adb logcat -s 'CallConnectionService|StaleCallPolicy' > stale-ring.txt (сценарий 3: 60 сек) — убедиться sweep вызывается, Releasing логи есть.; adb shell dumpsys audio > audio-modes.txt (сцен. 3) — доказать MODE_RINGTONE still held или уже MODE_NORMAL.; adb shell dumpsys telecom > telecom-dump.txt — посмотреть Connection states и их очистку.
  - Автотесты: android/app/src/test/java/com/forta/chat/plugins/calls/CallForegroundServiceDestroyContractTest.kt:159 — onDestroy_releasesTheCapturePath_soTheMicrophoneIsFreed (WebRTC closeAllPeerConnections).; android/app/src/test/java/com/forta/chat/plugins/calls/CallForegroundServiceDestroyContractTest.kt:169 — onDestroy_clearsAudioRouteWhileBothInstancesExist (service race guard, версия-check).; android/app/src/test/java/com/forta/chat/plugins/calls/CallForegroundServiceDestroyContractTest.kt:229 — shouldAdoptStrandedMode_falseWhenThisInstanceIsNewer (новый экземпляр не усыновляет).; android/app/src/test/java/com/forta/chat/plugins/calls/CallForegroundServiceDestroyContractTest.kt:251 — onDestroy_adoptsStrandedModeIfOlderInstance (forceStop для старого).; src/features/video-calls/model/call-service.test.ts — incoming-call dedup, single call slot (#1183), expired invite (#958/#928).
  - Запись в `docs/manual-verification.md`: «Микрофон освобождается; Разговор переживает завершение; Зависший звонок отпускается; Кнопка приёма не роняет»


- [ ] **F05. Слот соединения обнулялся чужим потоком при завершении звонка**
  - Коммиты: `00ddc636` · Кластер: resource-not-released-on-teardown
  - Где: Samsung и Pixel · Можно ли: частично · Нужно: adb доступ к реальному Samsung и Pixel; два тестовых аккаунта (TEST1, TEST2); сборка baseline (origin/master) и HEAD сборка для сравнения; умение запускать входящие звонки между аккаунтами
  - Ограничения: Гонка непредсказуема и редка, особенно на быстрых эмуляторах. На Samsung может быть стабильнее, чем на Pixel API-35. Может не воспроизводиться при каждой попытке (ожидаются срабатывания в 30–70% случаев при повторе 5–10 раз подряд).
  - Симптом: Завершу звонок, сразу поступит входящий звонок — экран входящего появится, но кнопка ответа не работает. Connection в слоте currentConnection = null, хотя Telecom уже создал объект и вызвал onCreateIncomingConnection.
  - Причина: FortaFirebaseMessagingService.kt:180 (baseline origin/master) — Firebase thread в onDisconnect() безусловно устанавливал currentConnection = null. Telecom параллельно на главном потоке присваивал новое соединение в тот же слот. Ноль от Firebase стирал только что назначенное соединение, оставляя новый звонок без Connection.
  - Воспроизвести на старой сборке:
    1. Завершить текущий звонок нажатием на экране (в конце говорить не нужно)
    2. Сразу же (1–2 сек) поступит входящий звонок от TEST-аккаунта (TEST1 вызывает TEST2 или наоборот)
    3. Если гонца совпадает: экран входящего появится, рингтон звучит, но кнопка ответа не реагирует на тап (Connection = null)
    4. Повторить 5–10 раз подряд; гонка непредсказуема, может срабатывать не всегда
    Признак бага: На baseline: экран входящего виден, рингтон звучит, но кнопка ответа (зелёная) не реагирует. В logcat отсутствует 'onCreateIncomingConnection' для новой ячейки или не видны 'onDisconnect' / 'Displacing' перед попыткой ответа (потому что логирования защиты нет в baseline).
  - Проверить на новой сборке:
    1. На новой сборке: повторить цикл конец-звонка → входящий-звонок 5–10 раз подряд
    2. Каждый новый звонок обязан зазвонить (рингтон слышен, экран обновляется). Кнопка ответа работает — одиночный тап принимает звонок
    3. После ответа: звук работает в обе стороны, нет заиканий, звонок длится нормально
    4. В logcat (adb logcat -s CallConnectionService CallConnection) проверить: если гонка совпадет (редко), должна быть строка 'Displacing a live connection — disconnecting it first'; её наличие хорошо, отсутствие тоже нормально (гонца может не совпасть)
    Ожидаемо: Каждый входящий звонок надёжно ответается. Ни одного null pointer exception, ни одного BUSY вместо нормального входящего, ни одного timeout. Строка 'Displacing' может не появиться на всех 10 попытках — это значит, что гонца не совпала в этом сеансе, но код готов её ловить.
    Лог: adb logcat -s CallConnectionService CallConnection | grep -E 'onCreateIncomingConnection|Displacing|onDisconnect|already released|NullPointerException' — ищем: (1) 'onCreateIncomingConnection: callId=XXX' для новой ячейки; (2) если гонца: 'Displacing a live connection'; (3) 'onDisconnect' с 'already released'; (4) НЕ должно быть NPE или 'Connection is null' error.
    adb: adb shell dumpsys audio | grep -E 'mode|modeOwner' — после завершения первого звонка режим должен вернуться из MODE_IN_COMMUNICATION в NORMAL. На быстрых стартах второго звонка режим может оставаться IN_COMMUNICATION несколько миллисекунд, но обязан вернуться после конца второго звонка
    adb: adb shell dumpsys telecom | grep -A 10 'active\|ringing' — при совпадении гонцы может быть два Connection одновременно в списке; это нормально; важно, что старый безопасно освобождается и не остаётся зависшим
  - Если не исправлен, приложить: adb logcat > logcat-race.txt с отметкой времени гонки (при обнаружении ошибки); adb shell dumpsys telecom | grep -A 20 'Phone\|Connection' > telecom-state.txt на момент, когда кнопка ответа не работает; adb shell getprop ro.build.fingerprint — вендор и версия OS (важно для воспроизводимости); Скриншот экрана входящего со статусом кнопки ответа; Статистика: из 10 циклов, в скольких гонца совпадает (< 30% может указывать на проблему тестового окружения)
  - Автотесты: src/entities/call/model/call-store.test.ts: 'hasLiveCall' suite — тесты 'returns true while an SDK call exists with no CallInfo yet', 'keeps reporting a live call until told the SDK object changed', 'ignores an SDK call the SDK has already ended' (покрывают логику слота Pinia); src/features/video-calls/model/call-service.test.ts: 'single call slot during a native ring (#1183)' — тесты 'refuses to dial while a call is ringing but not yet answered', 'rejects a second incoming call' (покрывают зачем слот нужен); Kotlin: CallConnection.released atomic boolean и identity-guard (this ===) в onDisconnect и onReject (структурно защищены от двойного вызова)
  - Запись в `docs/manual-verification.md`: «Разговор переживает завершение предыдущего звонка»


- [ ] **F06. MODE_IN_COMMUNICATION, выставленный до старта роутера, оставался без владельца при неудачном старте**
  - Коммиты: `00ddc636` · Отчёты: [#997](https://github.com/greenShirtMystery/forta-bugs/issues/997), [#1183](https://github.com/greenShirtMystery/forta-bugs/issues/1183) · Кластер: stuck-after-call
  - Где: эмулятор · Можно ли: можно проверить · Нужно: Pixel API-35 эмулятор (Maestro flows, logcat, dumpsys); реальное устройство Samsung или Google Pixel (logcat, dumpsys, физическая кнопка Volume Down); две тестовые учётные записи TEST1/TEST2 из .env; для E2E: локально собранный debug APK (google-services.json отсутствует, FCM не требуется)
  - Ограничения: Баг требует конкретного сценария (стартап AudioRouter не выполнен), который редко воспроизводится вручную. E2E flow (scripts/e2e-call.sh) надёжнее, чем попытка timing-а. На практике фикс валидируется JVM-тестами при сборке; логи показывают, что режим либо нормально сбросился, либо фикс обнаружил и восстановил зависший режим.
  - Симптом: После завершения звонка устройство остаётся в режиме VoIP (MODE_IN_COMMUNICATION): ползунок громкости медиа не отвечает (обычно требует перезагрузки приложения), следующий звонок имеет проблемы со звуком или полное отсутствие звука.
  - Причина: NativeWebRTCManager.startLocalAudio устанавливает MODE_IN_COMMUNICATION явно (NativeWebRTCManager.kt:506 baseline) ДО старта AudioRouter. Если стартап роутера не выполнен, AudioRouter.stop() на неактивном роутере возвращал результат на стражнике без сброса режима (AudioRouter.kt:484–493 baseline). Режим оставался глобально, ломала медиа-громкость.
  - Воспроизвести на старой сборке:
    1. Установить старую сборку (коммит 00ddc636^, до фикса)
    2. Запустить E2E flow: scripts/e2e-call.sh между Pixel API-35 и другим эмулятором или аппаратом (TEST1 звонит TEST2)
    3. Проверить logcat: adb logcat -s AudioLifecycle | grep -E 'start|stop' — при успешном старте должна быть цепочка: start(...): set mode=MODE_IN_COMMUNICATION → stop(): set mode=MODE_NORMAL, cleared comm device
    4. Важно: На практике баг воспроизводится только если стартап AudioRouter не выполнен (AudioSource creation failed). Это редко и зависит от условий прошивки. Старая сборка не имеет защиты — если режим зависнет, cleanup молча происходит без логов.
    5. Если стартап успешен (ожидаемый случай): adb shell dumpsys audio | grep -i mode → MODE_NORMAL; нажать Volume Down → ползунок двигается; позвонить снова → звук в обе стороны
    Признак бага: Logcat содержит либо нормальную цепочку start→stop() с сбросом режима, либо молчаливое оставление режима (старая сборка не логирует это).
  - Проверить на новой сборке:
    1. Установить новую сборку (коммит 00ddc636, с фиксом)
    2. Запустить один раз: scripts/e2e-call.sh
    3. Проверить logcat: adb logcat -s AudioLifecycle | tail -50 — должно содержать либо: (a) start(...): set mode=MODE_IN_COMMUNICATION → stop(): set mode=MODE_NORMAL, cleared comm device (нормальный path, ~99% запусков), либо (b) start(...) → stop() — inactive but device left in MODE_IN_COMMUNICATION, brute-resetting (фикс обнаружил и восстановил зависший режим)
    4. Проверить dumpsys: adb shell dumpsys audio | grep -i mode → всегда MODE_NORMAL, никогда MODE_IN_COMMUNICATION после завершения
    5. Проверить громкость: нажать Volume Down → ползунок двигается
    6. Позвонить снова → звук в обе стороны
    7. (опционально) Запустить 5–10 раз scripts/e2e-call.sh и проверить каждый раз: grep 'stop' в логах показывает либо нормальный path, либо recovery; Mode всегда MODE_NORMAL; Volume работает; звук есть
    Ожидаемо: При нормальном пути: logcat показывает stop(): set mode=MODE_NORMAL, cleared comm device. При редком стартапе-failure: logcat показывает brute-resetting (фикс сработал). Во всех случаях: dumpsys audio показывает MODE_NORMAL, Volume Down работает, следующий вызов имеет звук в обе стороны. Индикатор микрофона (Android 12+) исчезает за 1–2 сек после завершения (или мигает при recovery, потом исчезает).
    Лог: adb logcat -s AudioLifecycle | grep -E 'start|stop|brute-resetting|mode' — ожидание: либо нормальная цепочка (start → ... → stop(): set mode=MODE_NORMAL), либо recovery (stop(): inactive but device left in MODE_IN_COMMUNICATION, brute-resetting). Обе цепочки правильные; наличие brute-resetting означает, что фикс обнаружил редкий случай и восстановил.
    adb: adb logcat -s AudioLifecycle | grep -E 'stop.*MODE|brute-resetting' — ожидание: HEAD показывает либо 'stop(): set mode=MODE_NORMAL, cleared comm device', либо 'brute-resetting'. Baseline не показывает 'brute-resetting'.
    adb: adb shell dumpsys audio | grep -i mode — ожидание: MODE_NORMAL (никогда MODE_IN_COMMUNICATION или MODE_RINGTONE после завершения вызова).
    adb: adb logcat -s AudioLifecycle | grep -E 'start|stop|force' | tail -30 — ожидание: либо start → ... → stop(): set mode=MODE_NORMAL (нормальный путь), либо start → ... → stop() with brute-resetting → forceStop() complete (восстановление).
  - Если не исправлен, приложить: adb logcat -s AudioLifecycle | grep -E 'stop|mode|brute' — полный лог до/после завершения вызова; adb shell dumpsys audio | grep -i mode — текущий audio mode (собрать несколько раз: до вызова, после завершения, перед следующим вызовом); adb shell dumpsys media — детальное состояние audio subsystem (если MODE не сбросился); logcat с тегом 'AudioRouter' и 'NativeWebRTCManager' — трассировка lifecycle
  - Автотесты: android/app/src/test/java/com/forta/chat/plugins/calls/AudioRouterStrandedModeTest.kt — 5 JVM-тестов для shouldAdoptStrandedMode() (все режимы + boundaries); android/app/src/test/java/com/forta/chat/plugins/calls/CallForegroundServiceDestroyContractTest.kt — contract-тесты teardown (onDestroy + onTaskRemoved вызывают forceStop()); npm run test — при каждой сборке автоматически запускаются эти тесты
  - Запись в `docs/manual-verification.md`: «Зависший звонок отпускается при возврате в приложение»


- [ ] **F07. Нажатие Принять/Отклонить на границе 45-секундного таймаута не роняет приложение**
  - Коммиты: `00ddc636` · Кластер: accept-button-crash
  - Где: любой · Можно ли: частично · Нужно: Baseline: origin/master (66ae28ce) не содержит механизм 45-секундного таймаута — воспроизведение на baseline невозможно; HEAD: локально собранный debug APK или CI test APK (для проверки процесса kill в logcat); Реальный Samsung, Google Pixel, или эмулятор Pixel API 35 с Maestro; TEST1 и TEST2 для входящих звонков с разных аккаунтов
  - Ограничения: Baseline не имеет ring timeout, поэтому классическое воспроизведение (\"старое приложение вылетает\") невозможно. Проверка ограничена тестированием safeguards в новом коде (HEAD 00ddc636). На базовом APK можно только убедиться, что приложение не ломается от нажатия на граничных секундах (потому что timeout просто отсутствует). На старой сборке 45-секундного дедлайна Telecom нет (он добавлен в 00ddc636); там есть только 30-секундный авто-сброс экрана входящего, поэтому на старой сборке ловите границу 29–31 с, на новой — обе границы (30 и 45 с).
  - Симптом: На новом коде приложение может вылететь, если нажать зелёную кнопку Принять ровно в момент срабатывания 45-секундного авто-сброса входящего звонка. Должно остаться живо благодаря crash guard.
  - Причина: Commit 00ddc636 добавляет ring timeout механизм в CallConnectionService.kt (строки 380–400, ringTimeoutRunnable() и scheduleRingTimeout()). Без обёртки crash guard слушатель Accept в IncomingCallActivity могла бы упасть на main thread, если бы timeout одновременно перевёл connection в released state. Safeguard использует tryStep() wrap в CalleeCrashGuard (CallConnectionService:295) для перехвата исключения из Telecom при setActive() на освобождённом соединении.
  - Воспроизвести на старой сборке:
    1. Примечание: baseline (origin/master 66ae28ce) не содержит ring timeout механизма (CallConnectionService.kt имеет 345 строк без RING_TIMEOUT_MS, ringTimeoutHandler, ringTimeoutRunnable). Воспроизведение классического сбоя на baseline невозможно.
    2. Если требуется сравнить с baseline: установите старый APK, отправьте входящий звонок, нажимайте Принять на разных секундах (44–46). Приложение не упадёт, потому что timeout не срабатывает.
    3. Основная проверка ведётся на HEAD (commit 00ddc636), где timeout присутствует.
    Признак бага: На baseline (без timeout): приложение остаётся живо при нажатии на любой секунде, потому что механизм timeout отсутствует. На HEAD (с timeout + safeguard): приложение также остаётся живо благодаря crash guard; в logcat допустима строка connection already released, ignoring или [callee-crash-guard] step=connection.onAnswer failed.
  - Проверить на новой сборке:
    1. Установить HEAD APK (локально собранный debug или CI test APK с commit 00ddc636).
    2. Позвонить на аппарат с другого аккаунта (TEST1 позвонит на TEST2 или наоборот) — экран должен показать входящий звонок с обратным отсчётом от 30 до 0 секунд.
    3. НА 44-й, 45-й и 46-й секундах по отдельности нажимать зелёную кнопку Принять.
    4. После каждого нажатия: приложение должно остаться живо (не закрыться и не упасть). Допустимо кратковременное появление ошибки, которая тут же закроется.
    5. Проверить в logcat: adb logcat -s CallConnection | grep -E 'Ring timeout|released|onAnswer' — должны быть строки Ring timeout или onAnswer: connection already released без process kill.
    6. Позвонить снова и убедиться: звук работает в обе стороны, звонок устанавливается нормально.
    7. Повторить попытки нажатия на граничных секундах 5–10 раз для уверенности в стабильности.
    Ожидаемо: Приложение не закрывается и не падает ни при одном из нажатий на 44–46 секундах. В logcat допустимы: (a) Ring timeout — начало срабатывания timeout handler, (b) onAnswer: connection already released, ignoring — успешно перехвачено исключение, (c) [callee-crash-guard] step=connection.onAnswer failed — crash guard отработал и поймал ошибку. Главное: нет строк java.lang.IllegalStateException из Telecom и нет process kill в crash logcat (adb logcat -b crash).
    Лог: adb logcat -s CallConnection,CallConnectionService,IncomingCallActivity | grep -E 'Ring timeout|onAnswer|released|crash-guard' — ищите успешный перехват исключения (connection already released или crash-guard step=...) без process kill. Если нужен полный crash strace: adb logcat -b crash
    adb: adb shell dumpsys package com.forta.chat | grep versionName — убедитесь, что версия соответствует HEAD (или build timestamp соответствует текущему дню).
    adb: adb logcat -b crash — если приложение неожиданно упало, полный strace будет здесь.
    adb: adb shell dumpsys audio | grep -i mode — после теста проверить режим: должен быть IN_COMMUNICATION (во время звонка) или NORMAL (после завершения), не RINGTONE.
    adb: adb shell getprop | grep -i version — версия Android на устройстве для контекста.
  - Если не исправлен, приложить: Точное время нажатия кнопки во время таймаута (44-я, 45-я или 46-я секунда) и результат (приложение живо или упало).; Полный logcat за время теста: adb logcat -s CallConnection,CallConnectionService,IncomingCallActivity,callee-crash-guard > logcat-test.txt; Модель устройства (adb shell getprop ro.product.model) и версия Android (adb shell getprop ro.build.version.release).; WebView версия: adb shell dumpsys package com.android.webview | grep versionName; Скриншот экрана звонка в момент нажатия (если доступно).
  - Автотесты: android/app/src/test/java/com/forta/chat/plugins/calls/IncomingCallAcceptGuardTest.kt — 7 @Test методов (12+ ассертов) проверяют наличие tryStep() обёртки на слушателе Accept/Decline и корректное перехватывание исключений.; e2e/maestro/flows/06-call-answer-doubletap.yaml — E2E тест двойного тапа на кнопку Принять; запустить: CALLEE_FLOW=e2e/maestro/flows/06-call-answer-doubletap.yaml scripts/e2e-call.sh
  - Запись в `docs/manual-verification.md`: «### Кнопка приёма не роняет приложение на границе 45-секундного таймаута - Коммит: 00ddc636 - Важно: baseline (origin/master 66ae28ce) НЕ содержит механизм ring timeout, поэтому классическое воспроизведение (вылет на старом APK) невозможно. Проверка проводится только на HEAD, где timeout присутствует с safeguards. - На чём: реальный аппарат (Samsung, Pixel) или эмулятор API 35 - Шаги: 1. Установить HEAD APK (с commit 00ddc636). 2. Позвонить на аппарат с другой учётной записи (TEST1 → TEST2 или наоборот). 3. На 44–46-й секунде нажать зелёную кнопку Принять (повторить несколько раз с разным timing). 4. Приложение НЕ должно упасть или закрыться. 5. В logcat проверить: `adb logcat -s CallConnection | grep -E 'Ring timeout|released'` — должны видны успешный перехват (connection already released, ignoring или [callee-crash-guard] step=connection.onAnswer failed), без process kill. - Статус: ☐ не проверено»


- [ ] **F12. WakeLock/abandonAudioFocus в onDestroy/onTaskRemoved роняли приложение, плюс регрессия: гонка кнопок при завершении**
  - Коммиты: `56d5f354` · Кластер: Гонка во время завершения звонка (call-teardown-race)
  - Где: Samsung и Pixel · Можно ли: частично · Нужно: Реальное устройство Samsung или Pixel (или оба); Второй аккаунт для входящего звонка (TEST1/TEST2); adb и возможность установки APK
  - Ограничения: На baseline (origin/master) нельзя показать гонку кнопок с disposed track — медиа-освобождение выполняется на основном потоке, конкурирующего dispose'а нет. Регрессия кнопок введена в commit 00ddc636 (mediaReleaseExecutor на background executor). Только WakeLock timeout и abandonAudioFocus throw в onDestroy/onTaskRemoved существуют в baseline и тестируемы на старой сборке (свайп приложения из recents во время звонка). На HEAD оба бага зафиксированы; button-race можно показать между 00ddc636 и 56d5f354, но только на обеих версиях вместе.
  - Симптом: На baseline: свайп приложения из recents посередине звонка иногда приводит к краху в onTaskRemoved/onDestroy с RuntimeException про 'WakeLock under-locked' или Exception в abandonAudioFocusRequest. На HEAD: оба зафиксированы (runCatching обвязка); кроме того, 00ddc636 внёс регрессию гонки кнопок (nope на baseline, да на 00ddc636, нет на 56d5f354).
  - Причина: Два разных бага на разных уровнях: (1) BaselineWakeLock: android/app/src/main/java/com/forta/chat/plugins/calls/CallForegroundService.kt:527 — `if (it.isHeld) it.release()` может выбросить, т.к. WakeLock имеет 1-час таймаут, который может истечь между проверкой isHeld и вызовом release(). Аналогично abandonAudioFocus:489 может выбросить на abandonAudioFocusRequest. (2) Button-race (регрессия): Введена в 00ddc636 — mediaReleaseExecutor вызывает closeAllPeerConnections на background потоке, пока основной поток обрабатывает клики кнопок mute/camera/switch-camera, которые читают localAudioTrack/localVideoTrack из NativeWebRTCManager.kt без синхронизации. В 00ddc636 метод createPeerConnection:272-281 читает трэки unguarded до нашего 56d5f354.
  - Воспроизвести на старой сборке:
    1. Установить baseline APK (origin/master, коммит 66ae28ce)
    2. adb logcat --clear
    3. adb shell am start com.forta.chat/.MainActivity
    4. Инициировать входящий звонок (TEST2 звонит на TEST1), дождаться соединения (слышен звук, зелёная кнопка нажата)
    5. Посередине активного звонка: свернуть приложение (нажать Home) и немедленно смахнуть его из "Недавних" (свайп вверх). Повторить 5–10 раз, пока не упадёт или не убедитесь что живо.
    6. Проверить logcat для crashes: `adb logcat | grep -iE "RuntimeException|Exception" | head -20` или полный лог через `adb logcat > /tmp/baseline-crash.log`
    Признак бага: adb logcat должна показать RuntimeException с текстом 'WakeLock under-locked' или Exception с 'abandonAudioFocusRequest' при крахе в onTaskRemoved/onDestroy. Процесс упадёт (PID иссякнет в 'adb shell ps').
  - Проверить на новой сборке:
    1. Установить HEAD APK (56d5f354 или позже)
    2. adb logcat --clear && adb shell am start com.forta.chat/.MainActivity
    3. Сценарий WakeLock: инициировать звонок (TEST2 ↔ TEST1), дождаться соединения, смахнуть из recents 10 раз подряд. Приложение НЕ должно упасть.
    4. adb logcat -s CallForegroundService,WebRTCAudio | grep -iE 'wakelock release threw|abandonAudioFocusRequest threw' — может появиться (это логирование из runCatching), но приложение остаётся живо.
    5. Убедиться что после завершения звонка процесс всё ещё в памяти: `adb shell ps | grep com.forta.chat`
    6. Позвонить снова и повторить свайп (убедиться что это работает стабильно, не one-time fluke).
    7. (Опционально, если тестировать button-race на промежуточной сборке 00ddc636): поместить звонок в активное состояние, нажимать mute/video/switch-camera 3–5 раз, потом нажать красную кнопку. Не должно упасть.
    8. Финальная проверка: `adb shell am force-stop com.forta.chat && sleep 2 && adb shell am start com.forta.chat/.MainActivity` и убедиться что приложение нормально стартует после всех тестов.
    Ожидаемо: Приложение остаётся живо во всех сценариях. В logcat: ноль необработанных исключений (Exception/RuntimeException/Crash), только логирование из runCatching обвязок вида '[WebRTCAudio] wakelock release threw' на WARN уровне. Процесс не убивается ни в какой момент. Звонок можно завершить и позвонить снова без перезагрузки.
    Лог: adb logcat -s CallForegroundService,WebRTCAudio,NativeWebRTCManager | grep -iE '(wakelock release threw|abandonAudioFocusRequest threw|setAudioEnabled on a disposed|setVideoEnabled on a disposed|switchCamera on a disposed|RuntimeException|Exception)' Ожидаемые строки на HEAD: 'wakelock release threw: java.lang.RuntimeException(WakeLock under-locked)' и/или 'abandonAudioFocusRequest threw'. Но приложение не крашится — исключение обработано runCatching.
    adb: adb logcat --clear — очистить логи перед каждым тестом
    adb: adb shell am start com.forta.chat/.MainActivity — старт приложения
    adb: adb shell am force-stop com.forta.chat && sleep 2 && adb shell am start com.forta.chat/.MainActivity — перезапуск после предполагаемого краша
    adb: adb shell ps | grep com.forta.chat — проверить что процесс живой
    adb: adb shell dumpsys audio | grep -i mode — проверить audio mode (должна вернуться в MODE_NORMAL после звонка)
  - Если не исправлен, приложить: Полный logcat с момента старта приложения до крахма: `adb logcat > crash.log`; Точное действие которое рухнуло: какую кнопку нажали, в какой момент звонка, сколько раз повторяли перед крахом; Device vendor и модель: `adb shell getprop ro.product.manufacturer ro.product.model`; WebView версия: `adb shell dumpsys webview | grep Current`; Полный стэк-трейс: `adb shell logcat | grep -A 20 'AndroidRuntime' | head -40` (или из crash.log); Была ли кнопка завершения (красная) нажата до свайпа или после?
  - Автотесты: android/app/src/test/java/com/forta/chat/plugins/calls/CallForegroundServiceDestroyContractTest.kt — тестирует что onDestroy/onTaskRemoved не выбрасывают из lifecycle; Нет детерминированного unit теста для race condition (требует scheduler timing), но DestroyContractTest проверяет что cleanup не кидает


### Входящие, слот Telecom, сеть


- [ ] **F08. Входящий звонит через несколько минут после того, как звонящий уже положил трубку**
  - Коммиты: `00ddc636` · Отчёты: [#958](https://github.com/greenShirtMystery/forta-bugs/issues/958), [#928](https://github.com/greenShirtMystery/forta-bugs/issues/928) · Кластер: retained-invite-ringer
  - Где: любой · Можно ли: частично · Нужно: TEST1 и TEST2 в одном homeserver; TEST2 может звонить извне (вторая учётная запись); реальный аппарат Samsung или Pixel предпочтительнее эмулятора для воспроизведения (задержка invite на homeserver)
  - Ограничения: Синхронизировать задержку инвайта на реальном homeserver сложно; на Pixel API-35 эмуляторе повторяется с низкой вероятностью (10+ попыток). Реальный аппарат + реальный homeserver надёжнее. Требует двух аккаунтов (TEST1/TEST2) в одном homeserver с возможностью инициировать звонок с нативного клиента или web Forta.chat.
  - Симптом: Спустя несколько минут (5–7) после завершения входящего звонка на устройство приходит ложный звонок от того же аккаунта, хотя звонящий уже положил трубку. Звонок может быть в режиме ожидания или активным разговором.
  - Причина: Homeserver задерживает доставку инвайта (из-за congestion или FCM degradation), а когда /sync доставляет его на позднем этапе, его lifetime истекает за миллисекунды до Call.incoming — SDK сразу переводит call в state «ended». Старая версия (origin/master:src/features/video-calls/model/call-service.ts:1245) не проверяла это и вызывала ensureIncomingCallVisible для мёртвого call, поднимая нативный ringer. Новая версия (00ddc636:src/features/video-calls/model/call-service.ts:1291) добавила проверку isSdkCallEnded и если вызов завершён, вызывает unwireCallEvents для очистки слота dedup и finalizeCall с reason «sdk-ended», что остановит нативный ringer и вернёт аудиорежим в NORMAL.
  - Воспроизвести на старой сборке:
    1. На старой сборке (baseline) открыть приложение с двумя аккаунтами: TEST1 логирован, TEST2 готов звонить извне.
    2. Позвонить на TEST1 с TEST2 (вне устройства, через web Forta или другой клиент).
    3. TEST1 ответит на звонок, будет разговор 30–60 сек.
    4. TEST1 завершит звонок нажатием кнопки «Завершить».
    5. Заблокировать экран или развернуть другое приложение на 5–10 минут, чтобы инвайт успел задержаться на сервере.
    6. Вернуться в Forta Chat. В течение 10–30 сек после открытия приложения на устройство должен прийти ложный звонок (экран входящего или нотификация), хотя в веб-клиенте TEST2 никогда не звонил во второй раз.
    7. Проверить в adb logcat -s 'call-service' наличие [call-service] handleIncomingCall для того же callId спустя минуты после завершения реального звонка — если появился, то это retained invite.
    Признак бага: В adb logcat ищем [call-service] handleIncomingCall для того же callId спустя минуты после завершения вызова — это свидетельствует о задержке инвайта на homeserver.
  - Проверить на новой сборке:
    1. На новой сборке (HEAD с 00ddc636) повторить те же шаги старой проверки.
    2. После возврата в приложение (через 5–10 мин, когда инвайт гарантирован): нативный ringer НЕ должен звонить. На экране может появиться momentary flash сообщения в UI (Vue state), но нативного звука и вибрации быть не должно.
    3. В adb logcat -s 'call-service' поискать «incoming call already ended by the SDK» — признак срабатывания новой проверки isSdkCallEnded.
    4. В adb logcat -s 'CallConnectionService' проверить наличие логов unwireCallEvents (очистка dedup слота) — unwireCallEvents должна быть вызвана из finalizeCall.
    5. Проверить аудиорежим: adb shell dumpsys audio | grep -E 'mode=|MODE_' | head -3 — должен быть MODE_NORMAL или соответствующий режим для неактивного вызова, не MODE_RINGTONE.
    Ожидаемо: Ringer не звонит. В логах видна последовательность: (1) [call-service] incoming call already ended by the SDK для того же callId, (2) unwireCallEvents очищает dedup слот, (3) finalizeCall(«sdk-ended», callId) отпускает Telecom соединение на нативе. Аудиорежим возвращается в NORMAL при возврате в приложение.
    Лог: [call-service] incoming call already ended by the SDK — ровно одна строка на retained invite. CallConnectionService: ищем unwireCallEvents и finalizeCall. Дополнительно проверяем переход в MODE_NORMAL в dumpsys audio.
    adb: adb logcat -s 'call-service' | grep 'incoming call already ended by the SDK'
    adb: adb logcat -s 'CallConnectionService' | grep -E 'unwireCallEvents|finalizeCall'
    adb: adb shell dumpsys audio | grep -E 'mode=|MODE_' | head -3
  - Если не исправлен, приложить: adb logcat -s 'call-service' полностью во время теста (от момента, когда инвайт приходит, до завершения); adb logcat -s 'CallConnectionService' и 'Telecom' для наблюдения состояния соединения; adb shell dumpsys audio перед тестом (исходный режим), в момент входящего ложного звонка и после возврата в приложение; GitHub issue с точным временем воспроизведения, версией WebView на device и версией приложения — поможет корректировать time-related checks
  - Автотесты: src/features/video-calls/model/call-service.test.ts: «does not ring for a call the SDK already ended» — проверяет, что ensureIncomingCallVisible не вызывается на ended call и finalizeCall вызывается вместо этого; src/features/video-calls/model/call-service.test.ts: «vacates the call slot on SDK-ended» — проверяет, что clearIncomingCallSeen вызывается из unwireCallEvents, освобождая деdup слот; src/features/video-calls/model/call-service.test.ts: «still rings a call the SDK is holding in ringing state» — регрессионный тест, что живой call в state 'ringing' всё ещё звонит нормально
  - Запись в `docs/manual-verification.md`: «Четыре записи в docs/manual-verification.md для 00ddc636: (1) «Микрофон освобождается после смахивания приложения из „недавних"» (lines 27-42), (2) «Разговор переживает завершение предыдущего звонка» (lines 44-55), (3) «Зависший звонок отпускается при возврате в приложение» (lines 57-71), (4) «Кнопка приёма не роняет приложение на границе таймаута» (lines 73-86). Для F08 отдельной записи нет — фикс требует взаимодействия homeserver и не подлежит надёжной ручной проверке на локальном эмуляторе.»


- [ ] **F09. Исходящий звонок с экрана входящего перезаписывал единственный слот и терял звонящий вызов**
  - Коммиты: `00ddc636` · Отчёты: [#1183](https://github.com/greenShirtMystery/forta-bugs/issues/1183) · Кластер: incoming-overwritten-by-outgoing
  - Где: Samsung и Pixel · Можно ли: можно проверить · Нужно: web-клиент или эмулятор для входящего звонка (аккаунт B); adb на хосте для запуска старой сборки и проверки logcat; тестовые аккаунты TEST1/TEST2 в .env
  - Ограничения: На Android 7-8 может потребоваться включить опцию разработчика 'Stay awake' для стабильного поведения Telecom. Быстрое нажатие диала может не срабатывать на некоторых Android-версиях из-за дебаунса UI — используйте паузу 0.5s между нажатиями.
  - Симптом: Пользователь видит входящий звонок, пока звонок звонит. Нажимает кнопку диала в приложении, чтобы позвонить третьему. Исходящий звонок замещает входящий в единственном слоте MatrixCall. Когда пользователь нажимает зелёную кнопку на экране входящего, SDK не находит соединение и звонок не отвечает на Матрице.
  - Причина: На Android входящий звонок звонит через Telecom и не пишет CallInfo в Pinia до тех пор, пока пользователь не нажмёт приём. Пока звонок звонит, isInCall остаётся false. Охрана повторного входа в startCall() читала if (callStore.isInCall) — она пропускала диал, потому что слот был логически свободен, хотя Telecom уже держал соединение. Исходящий диал перезаписывал matrixCall в Pinia (src/features/video-calls/model/call-service.ts:928), и поступление входящего на приём уже ничего не находило. Аналогично, handleIncomingCall() не отклонял второй входящий звонок во время ringing первого (строка 1197).
  - Воспроизвести на старой сборке:
    1. На тестовом аккаунте A установить старую сборку (origin/master) на Pixel API-35 эмуляторе или реальном Pixel
    2. Дождаться входящего звонка: открыть web-клиент на другом устройстве/браузере (аккаунт B) и начать звонок в комнату A
    3. На аппарате A пока звонок звонит и показывает экран входящего — попытаться позвонить в другую комнату (нажать кнопку диала в приложении)
    4. Проверить logcat: adb logcat -s call-service | grep -i startcall — должна быть попытка startCall() БЕЗ блокировки охраной 'Already in a call'
    5. Вернуться на экран входящего (первого звонка) и нажать зелёную кнопку приёма
    6. Ожидаемый баг: звонок не соединяется, в logcat видна ошибка о отсутствии соединения на Matrix, или Telecom показал, что были попытки создать две разные CallConnection
    Признак бага: Попытка startCall() проходит охрану (нет строки 'Already in a call'), и logcat показывает вызов ensureCallPermissions и placeVoiceCall(), когда входящий звонок всё ещё звонит.
  - Проверить на новой сборке:
    1. На тестовом аккаунте A установить новую сборку (HEAD с коммитом 00ddc636) поверх старой установки
    2. Повторить сценарий: дождаться входящего звонка с аккаунта B
    3. Пока звонок звонит — попытаться позвонить в другую комнату
    4. Проверить logcat: adb logcat -s call-service | grep 'Already in a call' — ДОЛЖНА быть строка '[call-service] Already in a call' при попытке диала, затем попытка должна быть ЗАБЛОКИРОВАНА (ensureCallPermissions и placeVoiceCall НЕ должны быть вызваны)
    5. Вернуться на экран входящего и нажать зелёную кнопку приёма
    6. Ожидаемый результат: звонок успешно соединяется, разговор работает в обе стороны, Telecom видит одну CallConnection
    Ожидаемо: Охрана на startCall() блокирует исходящий вызов, пока входящий звонит (даже если CallInfo не написана). Logcat содержит '[call-service] Already in a call' при попытке диала. Приём входящего работает. Если отправить второй входящий звонок во время ringing первого, logcat содержит '[call-service] handleIncomingCall: already in call, rejecting' и второй звонок автоматически отклоняется.
    Лог: adb logcat -s call-service — ищите '[call-service] Already in a call' при попытке startCall() во время ringing входящего; ищите '[call-service] handleIncomingCall: already in call, rejecting' при втором входящем во время первого.
    adb: adb logcat -s call-service | grep 'handleIncomingCall: callId=' — проверить, что handleIncomingCall() вызывается при входящем звонке
    adb: adb logcat -s call-service | grep -E 'startCall|Already in a call' — проверить блокировку исходящего диала при входящем
    adb: adb logcat -s call-service | grep 'handleIncomingCall: already in call, rejecting' — проверить отклонение второго входящего
    adb: adb shell dumpsys telecom | grep -i connection — проверить, что Telecom видит одну CallConnection (не две)
  - Если не исправлен, приложить: adb logcat -s call-service | head -100 — полный лог call-service для анализа порядка событий; adb shell dumpsys telecom — полное состояние Telecom соединений и connections; adb logcat | grep -i 'AudioRecord\|stopCapture' — проверить, что audioRecord остановлен при отказе диала
  - Автотесты: src/features/video-calls/model/call-service.test.ts: тест 'refuses to dial while a call is ringing but not yet answered' — проверяет, что startCall() не вызывает ensureCallPermissions и placeVoiceCall когда hasLiveCall=true и isInCall=false; src/features/video-calls/model/call-service.test.ts: тест 'rejects a second incoming call that arrives during that same window' — проверяет, что handleIncomingCall() отклоняет второй входящий и не пишет setMatrixCall когда hasLiveCall=true; src/entities/call/model/call-store.test.ts: describe('hasLiveCall') — набор тестов проверяет возврат true для SDK-вызова в состоянии ringing без CallInfo и необходимость touchMatrixCall() при изменении SDK состояния
  - Запись в `docs/manual-verification.md`: «Фикс изменяет ДВЕ охраны: startCall (строка 928: if (callStore.hasLiveCall)) и handleIncomingCall (строка 1197: if (callStore.hasLiveCall)). Обе были if (callStore.isInCall) в baseline (origin/master). Критично также наличие вызова touchMatrixCall() в onState обработчике (строка 437 в wireCallEvents): без него hasLiveCall остаётся в кэше после изменения SDK-состояния и охрана не переоценивается. Все три компонента необходимы для корректности фикса.»


- [ ] **F10. Второй входящий во время разговора клал трубку идущему разговору**
  - Коммиты: `e3079e09` · Кластер: call-state-displacement
  - Где: любой · Можно ли: можно проверить · Нужно: три аккаунта (A на целевом устройстве, B и C звонящие) или два реальных устройства + веб-клиент, либо два эмулятора (каждый с одним аккаунтом) + веб-клиент для третьей стороны; реальный Pixel или Samsung для точности Telecom-поведения, либо эмулятор Pixel API 35 с Maestro; adb для чтения logcat и dumpsys
  - Ограничения: Debug builds (собранные локально) не имеют google-services.json и FCM — экран входящего от C может не появиться через уведомление, но вызов всё равно будет обработан в onCreateIncomingConnection. CI Test APK (из GitHub Actions) имеет FCM и может показывать экран входящего. Для проверки, включено ли в Настройках → Приложения → Разрешения → Телефон для Forta Chat, нужен реальный аппарат.
  - Симптом: Когда во время активного разговора поступает второй входящий звонок, соединение текущего разговора вытесняется из единственного глобального слота CallConnectionService.currentConnection и вызывается onDisconnect(), разъединяя пользователя, который находился в разговоре.
  - Причина: В CallConnectionService.onCreateIncomingConnection отсутствует проверка наличия установленного соединения. Код безусловно выполняет currentConnection = connection, вытесняя предыдущее соединение из единственного слота. Поскольку все потребители читают слот без проверки callId (reportCallEnded, reportCallConnected, IncomingCallActivity.decline), вытесненное соединение становится недостижимым и Telecom удерживает устройство в режиме вызова до перезагрузки. android/app/src/main/java/com/forta/chat/plugins/calls/CallConnectionService.kt:92–117 baseline.
  - Воспроизвести на старой сборке:
    1. На аппарате A (реальный Pixel или Samsung, либо эмулятор) авторизоваться под аккаунтом A
    2. С другого устройства (B: эмулятор, реальный телефон или веб-клиент) авторизоваться под аккаунтом B и позвонить на A
    3. На A ответить на звонок (зелёная кнопка) — идёт активный разговор (Connection.STATE_ACTIVE)
    4. Пока разговор идёт: с третьего устройства (C: эмулятор, реальный телефон или веб-клиент) авторизоваться под аккаунтом C и позвонить на A
    5. На A наблюдать: разговор с B обязан продолжиться без перерыва. Звук должен остаться в наушниках/динамике, микрофон активен
    6. Если на A появился экран входящего от C (может произойти на эмуляторе с FCM или если уведомление не была отклонено): нажать «Отклонить» — разговор с B должен продолжиться
    7. Завершить разговор с B нормально (красный крест) и проверить аудиорежим: нажать кнопку громкости и убедиться, что регулятор показывает STREAM_MUSIC, а не STREAM_VOICE_CALL
    Признак бага: Разговор с B прерывается, звук обрывается, на экране остаётся «Вызов завершён» либо пустой экран. Второй звонок может остаться в статусе «ringing» или не появиться вообще.
  - Проверить на новой сборке:
    1. Собрать новый APK из HEAD: git show HEAD — должен содержать DisplacedConnectionPolicy.kt и check в onCreateIncomingConnection
    2. Установить APK поверх базовой версии на реальный аппарат: adb install -r path/to/app-debug.apk (данные и аккаунты сохранятся)
    3. Авторизоваться под аккаунтом A на целевом аппарате
    4. С аккаунта B позвонить на A и дождаться ответа (разговор должен быть в STATE_ACTIVE)
    5. Открыть logcat в отдельном терминале: adb logcat -s CallConnectionService IncomingCallActivity
    6. С аккаунта C позвонить на A
    7. **Ключевая проверка:** разговор с B обязан продолжиться без перерыва. В logcat в течение 1 сек должна появиться строка: 'Incoming call while a call is established — reporting busy'
    8. Если экран входящего от C появился: нажать «Отклонить». В logcat должна быть строка: 'decline ignored: slot holds an established call, not this ringer'
    9. Завершить разговор с B обычной кнопкой (красный крест) и сразу нажать кнопку громкости медиа — регулятор обязан показать STREAM_MUSIC (обычный медиа-поток), не STREAM_VOICE_CALL
    10. Финальная проверка (для реального аппарата): adb shell dumpsys audio | grep -i 'mode' — должен содержать MODE_NORMAL (0), не MODE_IN_CALL (2)
    Ожидаемо: Разговор с B продолжается без перерывов до конца. Logcat показывает 'Incoming call while a call is established — reporting busy' в момент второго звонка. Звук, микрофон, динамик остаются активны. После завершения разговора регулятор громкости показывает STREAM_MUSIC, а не STREAM_VOICE_CALL. На реальном аппарате adb dumpsys audio показывает MODE_NORMAL (0).
    Лог: adb logcat -s CallConnectionService IncomingCallActivity | grep -E 'Incoming call while|decline ignored'
    adb: adb shell dumpsys audio | grep -i 'mode' — проверить MODE_NORMAL (0) после завершения разговора, не MODE_IN_CALL (2)
    adb: adb shell dumpsys telecom | grep -E 'Connection|STATE_ACTIVE|STATE_DISCONNECTED' — все соединения должны быть в STATE_DISCONNECTED после hangUp, нет висячих STATE_ACTIVE
  - Если не исправлен, приложить: Полный logcat с фильтром -s CallConnectionService:* с временными метками момента второго звонка и его следствия; Logcat фильтр -s IncomingCallActivity:* для проверки onNewIntent и реакции UI; Вывод adb shell dumpsys audio до и после попытки второго звонка; Вывод adb shell dumpsys telecom с полным списком Connection и их состояний; Скриншот или видео экрана в момент второго звонка и спустя 5 сек после того как первый разговор должен был продолжиться; Точные номера/юзернеймы аккаунтов A, B, C; Модель телефона, версия Android и тип Telecom (Samsung, Google, MIUI и т. д.); Временная метка в логе в момент ошибки
  - Автотесты: DisplacedConnectionPolicyTest.kt — 5 unit-тестов покрывают логику DisplacedConnectionPolicy.mayRelease(): STATE_ACTIVE (вернёт false), STATE_HOLDING (false), STATE_RINGING (true), STATE_DIALING (true), и comprehensive list всех non-established состояний; Тесты запускаются как часть ./gradlew :app:testSideloadDebugUnitTest
  - Запись в `docs/manual-verification.md`: «Второй входящий не кладёт трубку идущему разговору; второй звонок перерисовывает экран входящего (либо обрабатывается тихо, если FCM отключён)»


- [ ] **F11. Экран входящего не перерисовывался при втором входящем звонке во время ринга первого**
  - Коммиты: `e3079e09` · Кластер: incoming-call-ui
  - Где: Samsung · Можно ли: частично · Нужно: Реальный аппарат (Samsung или Pixel с adb) ИЛИ эмулятор + web-клиент; Три одновременных источника звонков: целевой аппарат (callee) + два звонящих (TEST1 и TEST2, или TEST1 + web-клиент, или web + web в разных браузерах); Локально собранный baseline debug APK (git show origin/master можно использовать для диффа, но нужен рабочий APK на аппарате)
  - Ограничения: На двух эмуляторах одних (TEST1/TEST2) сценарий НЕВОЗМОЖЕН: нужна третья учётная запись или третий источник (web-клиент). Maestro e2e flows не настроены для трёхстороннего вызова. Автоматизированное покрытие: DisplacedConnectionPolicyTest закрывает BUSY-path (CallConnectionService), но НЕ покрывает UI rebind в onNewIntent (для этого нужна реальная IncomingCallActivity).
  - Симптом: Второй входящий звонок во время ринга первого НЕ перерисовывал имя, аватар и обратный отсчёт. setIntent() подменял звонок под капотом, но UI оставался за первым абонентом. Зелёная кнопка (Accept) ответит второму звонящему, в то время как на экране видна информация первого (визуальный мисматч).
  - Причина: IncomingCallActivity.onNewIntent() вызывал setIntent(Intent newIntent) (android/app/src/main/java/com/forta/chat/plugins/calls/IncomingCallActivity.kt:223 baseline), но не повторял привязку вьюх к новому intent'у. onCreate() на строках ~170–175 вызывал findViewById и bindCallerIdentity() один раз. В onNewIntent() была только setIntent() и обработка accept/decline действий, но привязка вьюх не повторялась. Фикс (commit e3079e09) добавил вызов bindCallerIdentity() в onNewIntent() и переменную shownCallId для отслеживания того, какой звонок видимо на экране в момент прихода нового входящего.
  - Воспроизвести на старой сборке:
    1. На реальном аппарате или эмуляторе: убедиться нет активных звонков
    2. Позвонить на целевой аппарат с аккаунта A (TEST1 или другой). На экране входящего видны: имя A, инициалы A, тип звонка (audio/video), обратный отсчёт 30 сек
    3. Через 10–15 сек позвонить с аккаунта B (TEST2, web-клиент или другой) на тот же целевой аппарат. Оба звонка издают звук (оба в RINGING), ничего не нажимать
    4. На BASELINE APK: проверить что экран входящего ОСТАЛСЯ с данными A (имя A, инициалы A, обратный отсчёт ~15 сек)
    5. На BASELINE APK: нажать Accept (зелёная кнопка) — мисматч: соединиться должно с B, но имя на экране A
    6. Завершить вызов и проверить logcat: должна быть запись onNewIntent() без повторной привязки вьюх
    Признак бага: На экране видны данные первого звонящего (A), но действие (Accept) соединяет со вторым (B). Это мисматч между видимым UI и действительным состоянием.
  - Проверить на новой сборке:
    1. На HEAD APK повторить шаги 1–3 (оба звонка в RINGING, ничего не делать)
    2. На HEAD APK: проверить что имя, инициалы, тип звонка ОБНОВИЛИСЬ: смениться с A на B в момент прихода второго входящего
    3. На HEAD APK: обратный отсчёт ПЕРЕЗАПУСТИЛСЯ с 30 сек (не продолжить от 15–20 сек)
    4. На HEAD APK: нажать Accept — соединиться с B; на экране стоит имя B (совпадение UI и действия)
    5. Завершить вызов
    6. Проверить logcat: должна быть запись о rebind второго вызова (onNewIntent: second call … displacing …)
    Ожидаемо: Второй входящий звонок перерисовывает экран: имя, аватар, тип звонка и таймер соответствуют B. Обратный отсчёт перезапускается. Нажатие Accept ответит B, и имя на экране совпадает с действием (нет мисматча). Logcat показывает запись о rebind'е.
    Лог: adb logcat | grep -E 'IncomingCallActivity.*onNewIntent: second call' Ожидаемая строка (HEAD, СЦЕНАРИЙ A — оба звонка RINGING): 'IncomingCallActivity: onNewIntent: second call [callId-B] displacing [callId-A] on screen' ДЛЯ ДРУГОГО СЦЕНАРИЯ (второй звонок ВО ВРЕМЯ ACTIVE первого): adb logcat | grep 'CallConnectionService.*Incoming call while' Ожидаемая: 'Incoming call while a call is established — reporting busy' Эта запись появляется ТОЛЬКО если первый вызов был ACTIVE/HOLDING (не в этом сценарии).
    adb: adb logcat -c && adb logcat -s IncomingCallActivity | grep 'onNewIntent: second call' — должна быть запись на HEAD
    adb: adb logcat -s IncomingCallActivity | grep 'Call type' — должно быть обновление типа звонка на B
    adb: adb logcat -s IncomingCallActivity | grep 'countdown_text' — должен перезапуститься таймер с 30
  - Если не исправлен, приложить: Полный logcat от момента прихода второго звонка: adb logcat | grep -E 'IncomingCallActivity|CallConnectionService' — 30 сек ДО и ПОСЛЕ звонка B; Скрин экрана в момент второго входящего (какие данные видны: имя, аватар, таймер); Проверить был ли вызван onNewIntent: grep 'onNewIntent' в logcat (должна быть запись 'onNewIntent: dispatching' или 'onNewIntent: second call'); Проверить intent extras: убедиться что callerName и hasVideo переданы от B (можно добавить лог в onNewIntent); Проверить значение IncomingCallActivity.shownCallId — он должен измениться со звонка A на B
  - Автотесты: android/app/src/test/java/com/forta/chat/plugins/calls/DisplacedConnectionPolicyTest.kt — юнит-тесты покрывают правило BUSY для CallConnectionService (СЦЕНАРИЙ B: второй звонок во время ACTIVE), но НЕ покрывают UI rebind в onNewIntent (для СЦЕНАРИЯ A); e2e/maestro/flows/05-call-answer.yaml и 06-call-answer-doubletap.yaml — существуют, но нет потока для сценария 'second call arrives during ringing' (нужна третья учётная запись)
  - Запись в `docs/manual-verification.md`: «F11. Второй звонок перерисовывает экран входящего (имя, аватар, таймер). Accept ответит правильному звонящему.»


- [ ] **F13. При движке WebView терялось восстановление звонка после перехода Wi-Fi → сотовая**
  - Коммиты: `b4a09916` · Кластер: F13
  - Где: Pixel · Можно ли: можно проверить · Нужно: эмулятор Pixel API 35 или реальный Pixel; TEST1/TEST2 в .env; baseline = 56d5f354
  - Ограничения: Баг проявляется только в WebView-режиме (registerNetworkChangeRestart был внутри if (isNativeWebRTCEngineEnabled())). Механизм WebView-режима как такой вообще не существует на origin/master (добавлен в этой ветке на d0261dc2). Старая сборка для воспроизведения = 56d5f354 (intermediate commit, не из origin/master).
  - Симптом: На аппаратах, переключивших WebRTC на WebView-режим (из-за проблем со звуком), разговор обрывался при переходе Wi-Fi↔сотовая вместо автоматического восстановления через ICE restart. Аудиоподключение падало в 'failed' или 'disconnected', соединение теряло лось через 5–10 секунд.
  - Причина: Функция registerNetworkChangeRestart (src/features/video-calls/model/call-service.ts) находилась внутри условия `if (isAndroid && isNativeWebRTCEngineEnabled())` на baseline 56d5f354. При включении WebView-режима (isNativeWebRTCEngineEnabled() = false) слушатель сетевых событий (onConnectivityChange) никогда не регистрировался, хотя ICE restart действует на matrixCall.peerConn (RTCPeerConnection SDK), существующий в обоих режимах. Фикс: вынести registerNetworkChangeRestart и onAudioError из этого условия, зарегистрировать их безусловно на Android (гейт только на платформу, не на engine). Строка 100–115 baseline (56d5f354).
  - Воспроизвести на старой сборке:
    1. Проверить baseline (56d5f354): git log --oneline | head -1
    2. На эмуляторе установить baseline, войти под TEST1
    3. Settings → Call Engine → 'Встроенный движок звонков' (Use native engine) = OFF (WebView режим)
    4. Позвонить на TEST2, дождаться 'iceconnectionstate: connected'
    5. Запустить Wi-Fi toggle (OFF, затем ON за 5 сек): Settings → Network → Wi-Fi
    6. Наблюдение: разговор обрывается через 5–10 сек; logcat НЕ содержит '[call-service] network.*restartIce'
    Признак бага: Отсутствие в logcat (baseline 56d5f354 в WebView режиме): `adb logcat -s call-service` не содержит '[call-service] network <type1>→<type2>, restartIce' и не содержит '[call-service] register.*onConnectivityChange'. Вместо этого видны строки вроде '[call-service] iceconnectionstate: disconnected' → 'failed' при переходе Wi-Fi↔сотовая. Это доказывает, что registerNetworkChangeRestart не была вызвана из-за гейта на isNativeWebRTCEngineEnabled().
  - Проверить на новой сборке:
    1. Установить HEAD (b4a09916): adb install -r app-debug.apk; Settings → WebView mode
    2. Позвонить на TEST2, дождаться 'iceconnectionstate: connected'
    3. Запустить Wi-Fi toggle (OFF → ON за 5 сек)
    4. Разговор ДОЛЖЕН продолжаться без разрывов, звук в обе стороны
    5. Проверить logcat: adb logcat -s call-service | grep 'network' — должна быть '[call-service] network wifi→cellular, restartIce'
    6. На ICE state: adb logcat | grep -i 'iceconnectionstate' покажет 'checking' → 'connected' (восстановление)
    7. Позвонить снова, повторить Wi-Fi toggle — разговор остаётся целым
    Ожидаемо: Разговор остаётся активным без разрывов при переходе Wi-Fi↔сотовая. Звук передаётся в обе стороны до и после переключения сети. В logcat появляется строка типа '[call-service] network <previousType>→<type>, restartIce' при каждом изменении типа сети во время активного звонка. Слушатель onConnectivityChange зарегистрирован в начале инициализации модуля (видно в logcat рядом с временем запуска приложения), независимо от того, включён WebView или родной движок. При наличии множественных звонков handlers корректно отсоединяются от правильного call object.
    Лог: Baseline (56d5f354, WebView режим): `adb logcat -s call-service | grep -E 'network.*restartIce|onConnectivityChange'` — пусто, звонок падает с '[call-service] iceconnectionstate: failed'. HEAD (b4a09916): `adb logcat -s call-service | grep 'network'` выдаёт '[call-service] network <type1>→<type2>, restartIce'. Дополнительно: `adb logcat -s call-service | grep -i 'iceconnectionstate'` на HEAD показывает 'checking' фазу ICE recovery, на baseline идёт прямо в 'failed'.
    adb: Перед и после Wi-Fi toggle (доказать, что сетевое переключение реальное): `adb shell dumpsys wifi | grep -i 'state\|ip'` должна показать state 'connected' → 'disconnected' → 'connected', IP-адрес остаётся или меняется.
    adb: Во время звонка, мониторить ICE state: `adb logcat | grep -i 'iceconnectionstate' | tail -20` — baseline (56d5f354) покажет 'disconnected' → 'failed' без 'checking' фазы, HEAD (b4a09916) покажет 'checking' → 'connected' за 1–2 секунды после toggle.
    adb: Подтвердить, что app не убита: `adb shell dumpsys audio | grep -i 'mode\|ringer'` должна показать audio mode, соответствующий активному звонку (не режим RINGER/NORMAL). На baseline режим может вернуться в NORMAL, на HEAD должен остаться на MODE_IN_COMMUNICATION или аналогичном.
  - Если не исправлен, приложить: Полный logcat фильтр 'call-service' от начала входящего звонка до конца (либо успеха с Wi-Fi toggle, либо падения звонка) — ищите строку '[call-service] network.*restartIce' (должна присутствовать на HEAD, отсутствовать на baseline 56d5f354 в WebView режиме).; dumpsys netpolicy перед отключением Wi-Fi и после включения (покажет, какой интерфейс активен).; Строка '[call-service] skip restartIce' (если присутствует — значит, registerNetworkChangeRestart была вызвана, но ICE restart заблокирован условием signalingState !== 'stable'; если отсутствует — registerNetworkChangeRestart вообще не вызвалась).; Убедиться, что WebView режим действительно включен: `adb shell getprop | grep -i webview` или проверить в app Settings → Call Engine.
  - Автотесты: src/features/video-calls/model/call-service-platform-gate.test.ts: 'still registers WiFi↔cellular recovery when the engine is set to webview' — проверяет, что onConnectivityChange зарегистрирована при WebView-режиме на Android (ключевое исправление).; src/features/video-calls/model/call-service-platform-gate.test.ts: 'does NOT register connectivity-based ICE restart off Android' — проверяет, что на iOS/web/Electron слушатель не регистрируется (специфично для Android).; src/features/video-calls/model/call-service.test.ts: 'detaches from the call the handlers were attached to' (строка ~600–621) — проверяет побочный фикс: unwireCallEvents() теперь вызывается без параметра, открепляет handlers от правильного call object, предотвращая забуривание обработчиков при наложении звонков.
  - Запись в `docs/manual-verification.md`: «Запись в docs/manual-verification.md, раздел F13: 'Звонок при переходе Wi-Fi↔сотовая в WebView-режиме' с базовыми шагами из verify_steps_ru, особенно п. 8–9 (проверка наличия 'network.*restartIce' в logcat и состояния ICE). Отметить, что ошибка проявляется только при WebView-режиме, включённом ДО звонка; переключение режима во время звонка не воспроизводит дефект (за подробностями см. manual-verification.md и call-bug-reproduction-matrix.md).»


### Чат и видео


- [ ] **F14. Один звонок отображался в чате двумя записями**
  - Коммиты: `2254c375` · Отчёты: [#1027](https://github.com/greenShirtMystery/forta-bugs/issues/1027) · Кластер: duplicate-call-entries
  - Где: Samsung и Pixel · Можно ли: можно проверить · Нужно: два устройства или эмулятора с авторизацией; adb для установки APK; TEST1/TEST2 аккаунты в .env; npm для сборки
  - Ограничения: Фикс чисто в Vue (дедупликация на рендеринге в MessageList.vue); для проверки Android-состояния звонка доступны логи CallActivity, но Matrix-события (m.call.hangup) видны только в JS консоли, не в Android logcat
  - Симптом: При завершении звонка обе стороны нажимают красную кнопку, Matrix создаёт два события m.call.hangup (по одному на участника), и одна запись о звонке появляется в таймлайне дважды. Пользователь сообщил: «Позвонил товарищу 2 раза, а уведомления об исходящем вызове 4шт» (#1027)
  - Причина: src/entities/chat/lib/dedupe-call-events.ts:1–40 (baseline не сохраняет callId из события Matrix; звонки идентифицируются только по event_id). Когда оба участника кладут трубку, в комнате лежат два hangup-события с разными event_id, но одним call_id; фикс дедупликирует при рендеринге в MessageList.vue, оставляя одно (более раннее) событие
  - Воспроизвести на старой сборке:
    1. Переключиться на baseline: git checkout origin/master && npm run build:android
    2. Установить на оба эмулятора: adb install -r android/app/build/outputs/apk/sideload/debug/app-sideload-debug.apk
    3. Запустить полный e2e: scripts/e2e-call.sh (автоматическая авторизация TEST1/TEST2, оба Maestro-потока)
    4. После завершения скрипта вручную нажать красную кнопку на обоих эмуляторах одновременно (<2 сек разница)
    5. Открыть чат комнаты на обоих эмуляторах → проверить таймлайн
    Признак бага: В таймлайне одна запись о звонке появляется дважды: две идентичные строки (например, «Исходящий звонок» или «Входящий») с одинаковым временем и длительностью
  - Проверить на новой сборке:
    1. Переключиться на HEAD: git checkout HEAD && npm run build:android
    2. Переустановить (данные базы сохранятся): adb install -r android/app/build/outputs/apk/sideload/debug/app-sideload-debug.apk на оба эмулятора
    3. Запустить e2e с пропуском логина: scripts/e2e-call.sh --skip-login (аккаунты уже авторизованы от baseline)
    4. После завершения вручную нажать красную кнопку на обоих эмуляторах одновременно
    5. Открыть чат комнаты на обоих эмуляторах → проверить таймлайн
    Ожидаемо: В таймлайне ровно одна запись о звонке (не две). Запись содержит один event_id и заполненный callId из события Matrix
    Лог: Не требуется — фикс чисто в Vue (src/entities/chat/lib/dedupe-call-events.ts, MessageList.vue). Если нужна отладка Android-состояния звонка: adb logcat -s CallActivity покажет Accept/Decline/Remote hangup переходы, но не Matrix-события (m.call.hangup видны только в JS консоли, в DevTools браузера или RemoteDebugger WebView)
    adb: adb install -r android/app/build/outputs/apk/sideload/debug/app-sideload-debug.apk — переустановка APK (данные сохраняются при совпадении сигнатуры)
    adb: adb logcat -s CallActivity — для проверки Android-состояния звонка (не показывает Matrix-события)
  - Если не исправлен, приложить: Скриншот таймлайна, показывающий две идентичные записи о звонке (если баг всё ещё воспроизводится); DevTools IndexedDB (браузер или RemoteDebugger WebView): bastyon-chat-{userId} → messages → два event_id и callId для обоих hangup-событий; JS консоль (DevTools браузера Web-клиента): logs Matrix SDK с m.call.hangup событиями и call_id из обоих событий; Проверка git log --oneline HEAD | head -20 — наличие коммита 2254c375 и 2d639194 в целевой сборке
  - Автотесты: src/entities/chat/lib/dedupe-call-events.test.ts — юнит-тесты дедупликации (группировка по callId, сохранение самого раннего события, разделение разных звонков); Существующие Maestro-flows e2e/maestro/flows/04-call-place.yaml и 05-call-answer.yaml используются для двусторонних звонков; можно расширить для автоматизированной проверки финального таймлайна (скриншот + счёт видимых записей)
  - Запись в `docs/manual-verification.md`: «F14: Два hangup-события на одного звонка (baseline не дедупирует). После фикса: одна запись в таймлайне. Проверить: (1) скриншот UI (одна запись, не две); (2) DevTools IndexedDB bastyon-chat-{userId} → messages (два event_id, один callId); (3) проверить наличие коммитов 2254c375 и 2d639194 в целевой сборке (второй исправляет побочный эффект с unread-баннером)»


- [ ] **F15. Баннер новых сообщений сохраняется при схлопывании записей о звонке**
  - Коммиты: `2d639194` · Кластер: unread-banner-collapse
  - Где: Samsung и Pixel · Можно ли: можно проверить · Нужно: git для сборки промежуточной версии (git checkout 2254c375 или git checkout 2d639194^); npm run build:android для сборки debug APK; эмулятор Pixel API-35 или реальный Pixel/Samsung; браузер с localhost:5173 (Vite dev server, npm run dev)
  - Ограничения: Требует синхронизации между браузером (web client) и эмулятором на одной учетке TEST1; невозможен на single-device setup без cross-client sync. Сборка baseline требует git checkout (используйте git checkout 2d639194^ для быстрого получения версии без фикса).
  - Симптом: Баннер «новые сообщения» не отображается в комнате, когда отметка прочтения (установленная с браузера) указывает на вторую запись о завершении звонка — именно ту, что удаляется при схлопывании дублей.
  - Причина: src/features/messaging/ui/MessageList.vue:329–333 (baseline 2d639194^): после вызова dedupeCallEvents вторая запись о завершении звонка удаляется из timeline для отображения. Водяной знак «последнее прочитанное» указывает именно на эту удаляемую запись. При поиске якоря баннера сначала по frozenLastReadId, а затем по отображаемому ID (после маппинга collapsed id через collapsedCallEventIds), якорь не находится, баннер не рендерится.
  - Воспроизвести на старой сборке:
    1. Собрать baseline: git checkout 2d639194^ && npm run build:android
    2. На эмуляторе Pixel API-35: войти под TEST1
    3. На браузере localhost:5173: войти под TEST1, открыть любую комнату для синхронизации
    4. На эмуляторе: позвонить в комнату, обеим сторонам нажать hang up (создаются две записи о завершении)
    5. На браузере: обновить комнату, убедиться что записи синхронизированы
    6. На эмуляторе: отправить 2–3 текстовых сообщения в комнату
    7. На эмуляторе: свернуть приложение (минимум 2 сек), потом открыть комнату заново
    8. Баннер «новые сообщения» НЕ появляется, хотя есть 2–3 непрочитанных сообщения
    Признак бага: Баннер отсутствует над первым непрочитанным сообщением; счётчик в сайдбаре может показывать число, но visually баннер не видна; в Chrome DevTools console можно наблюдать что поиск якоря по mapped id вернул -1 или undefined.
  - Проверить на новой сборке:
    1. Собрать HEAD: git checkout HEAD && npm run build:android
    2. Повторить шаги 2–7 (тот же сценарий с TEST1, браузер + эмулятор, hangup, сообщения)
    3. Баннер «новые сообщения» обязан ПОЯВИТЬСЯ над первым непрочитанным сообщением
    4. Свернуть/открыть приложение несколько раз — баннер обязан остаться на месте и не исчезать
    5. Нажать на любое сообщение после баннера — watermark обновится, баннер исчезнет, счётчик = 0
    Ожидаемо: Баннер корректно отображается и остаётся якорированным к первому непрочитанному сообщению, несмотря на то что это сообщение может быть расположено ниже удалённой из timeline записи hangup. После нажатия на сообщение watermark обновляется, баннер исчезает, счётчик = 0. Chrome DevTools должны показать успешный поиск якоря с переотображением (вместо ID collapsed hangup будет ID survivor).
    adb: adb logcat | grep -E 'MessageList|unread-banner' — трассировать жизненный цикл баннера в Vue (если в коде добавлены логи)
    adb: adb shell dumpsys audio | grep MODE_ — проверить, что режим audio не помешал тесту (опционально)
  - Если не исправлен, приложить: Снимок экрана: баннер видна или отсутствует после открытия комнаты на эмуляторе; Значение frozenLastReadId в MessageList.vue (до маппинга vs после маппинга) — совпадают ли с реальными id в timeline; Состояние Dexie (IndexedDB): какие id hangup событий хранятся, какой из них выжил после dedupeCallEvents; Логи Chrome DevTools: error при поиске якоря или успешное переотображение баннера
  - Автотесты: src/entities/chat/lib/dedupe-call-events.test.ts: 5 unit tests для collapsedCallEventIds (маппинг второй на первую, маппинг id и _key, маппинг при >2 hangups, отсутствие маппинга при разных callId, не маппируется выжившее id); src/features/messaging/ui/MessageList.test.ts: интеграционный тест для рендеринга баннера после dedupeCallEvents и маппинга collapsed id (использовать useLiveQuery mock + Dexie fake)
  - Запись в `docs/manual-verification.md`: «Баннер непрочитанного переживает схлопывание записей о звонке»


- [ ] **F16. Тыловая камера зеркалилась на Android**
  - Коммиты: `3ac40372` · Отчёты: [#939](https://github.com/greenShirtMystery/forta-bugs/issues/939) · Кластер: video
  - Где: Samsung и Pixel · Можно ли: можно проверить
  - Ограничения: Эмулятор не подходит: синтетическая камера не имеет реального label с 'facing back'. Требуется реальное устройство (Pixel или Samsung), что уже есть в наличии.
  - Симптом: При переключении на тыловую камеру в видеозвонке на Android локальная миниатюра (self-view) отображается зеркально: текст и объекты выглядят перевёрнутыми слева направо. Исходящий видеопоток при этом нормальный.
  - Причина: На Android native WebRTC engine (libwebrtc) не заполняет поле facingMode у MediaStreamTrack. В baseline функция isFrontFacingTrack() при отсутствии facingMode возвращает true (зеркалить). Фикс добавляет fallback через чтение device label (например, 'camera2 0, facing back') для определения ориентации камеры (src/features/video-calls/model/camera-facing.ts:39-67).
  - Воспроизвести на старой сборке:
    1. На аппарате с baseline APK (до 3ac40372) открыть приложение и позвонить со второго устройства (другой аппарат или браузер web-клиента).
    2. Дождаться соединения (будет зелёная кнопка 'Ответить' и состояние 'Connected').
    3. В низу экрана в секции 'Камера' (Camera) нажать на тыловую камеру — обычно вторая в списке (её label содержит 'back' или 'facing back').
    4. Убедиться, что локальная миниатюра (большое видео слева или сверху) зеркальна: текст на любом объекте позади появляется перевёрнутым, левое плечо выглядит правым.
    Признак бага: Локальная миниатюра при включённой тыловой камере отображается зеркально. Текст на экране позади или на теле пользователя выглядит справа налево.
  - Проверить на новой сборке:
    1. На том же аппарате установить новый APK (HEAD с 3ac40372 или позже) — установка поверх старой сборки, данные сохраняются.
    2. Открыть приложение и позвонить снова (со второго устройства).
    3. Дождаться соединения, в секции 'Камера' нажать на тыловую камеру (как в шаге 3 репродукции).
    4. Убедиться, что локальная миниатюра НЕ зеркальна: текст и объекты отображаются правильно (как они выглядят в зеркале в реальности, а не перевёрнутыми).
    5. Переключиться обратно на фронтальную камеру и убедиться, что она остаётся зеркальной (фронтальная камера всегда зеркалится по дизайну).
    Ожидаемо: Локальная миниатюра при включённой тыловой камере отображается нормально (не зеркально). Фронтальная камера остаётся зеркальной (это правильное поведение).
    Лог: Специальных логов зеркалирования нет; видна инициализация видеотрека при подключении (grep -i 'track\|mediastream' ≈ 30–60 сек после подключения).
    adb: adb logcat | grep -i 'track\|mediastream' — логирование инициализации видеотрека при подключении видеозвонка
  - Если не исправлен, приложить: Скриншот с зеркальной миниатюрой (включить тыловую камеру в видеозвонке и сделать снимок экрана).; Модель аппарата: adb shell getprop ro.product.model; Версия Android: adb shell getprop ro.build.version.release; Версия WebView: Настройки → О приложении → Информация о приложении → WebView; Лог инициализации видеотрека: adb logcat | grep -i 'track\|mediastream' (≈ 30–60 сек после подключения)
  - Автотесты: npm test -- src/features/video-calls/model/camera-facing.test.ts — 15 тестов, все passing:; - isFrontFacingTrack('camera2 0, facing back') → false (тыловая не зеркалится); - isFrontFacingTrack('camera2 1, facing front') → true (фронтальная зеркалится); - isFrontFacingByLabel() распознаёт паттерны: back/rear/environment → false, front/user/self/selfie → true; - Неинформативные labels (например, 'Integrated Camera') возвращают undefined (используется default зеркалирование); - Явный facingMode (если присутствует) всегда победит label


### Звук на вендорах вне списка


- [ ] **F17. Нет звука на устройствах вне vendor-списка сломанного AEC: рантайм-проба AcousticEchoCanceler**
  - Коммиты: `3cc4feee`, `5cd50126` · Отчёты: [#1337](https://github.com/greenShirtMystery/forta-bugs/issues/1337), [#1318](https://github.com/greenShirtMystery/forta-bugs/issues/1318), [#1292](https://github.com/greenShirtMystery/forta-bugs/issues/1292), [#1231](https://github.com/greenShirtMystery/forta-bugs/issues/1231), [#1226](https://github.com/greenShirtMystery/forta-bugs/issues/1226) · Кластер: F17 / no-audio
  - Где: Samsung и Pixel · Можно ли: можно проверить · Нужно: реальный Samsung/OnePlus вне BROKEN_HW_AEC_VENDORS; adb на хосте; TEST1/TEST2
  - Ограничения: Эмулятор Android 35 не имеет реального audio HAL, поэтому runtime probe для AcousticEchoCanceler вернёт null и будет использоваться только vendor list. Реальные audio проблемы можно проверить только на физических устройствах Samsung/OnePlus с поломанным HW AEC.
  - Симптом: На смартфонах вне списка BROKEN_HW_AEC_VENDORS (OnePlus, Samsung, Motorola, Vivo и прочие вендоры) с неработающим аппаратным эхоподавлением абонент не слышит микрофон. До фикса опирались только на vendor list, поэтому такие устройства с неработающим HW AEC не обнаруживались и не получали software fallback.
  - Причина: AudioRouter.kt (baseline) опирался только на VendorAudioPolicy.BROKEN_HW_AEC_VENDORS список (Xiaomi/MIUI, Realme/ColorOS, OPPO, Infinix/XOS, Tecno/HiOS, Huawei/EMUI, Honor/MagicOS, ZTE). Список трижды расширялся (WEE-76, WEE-87, WEE-103) и всё ещё пропускал устройства с поломанным HW AEC вне списка. Фикс добавляет runtime probe (canCreateHardwareAec с sessionId=0) как подстраховку: если аппарат не в списке, но AcousticEchoCanceler не создаётся, device получает software processing + mic unmute. android/app/src/main/java/com/forta/chat/plugins/calls/AudioRouter.kt:80-95 (canCreateHardwareAec), VendorAudioPolicy.kt:107-130 (requiresExplicitMicUnmuteOnStart).
  - Воспроизвести на старой сборке:
    1. На реальном Samsung/OnePlus вне BROKEN_HW_AEC_VENDORS: adb shell getprop ro.build.manufacturer
    2. Установить baseline без runtime probe: adb install -r app-debug.apk
    3. Позвонить на TEST2, дождаться соединения
    4. Абонент подтверждает: микрофон не передаётся
    5. Проверить logcat: adb logcat -s AudioLifecycle | grep -i 'vendor' — только vendor list, без probe
    6. Завершить звонок
    7. Вывод: на device вне списка с поломанным HW AEC нет звука
    Признак бага: На Samsung SM-G965F, SM-S918B, OnePlus CPH2745, LE2110, GM1900 и похожих устройствах вне BROKEN_HW_AEC_VENDORS но с поломанным HW AEC абонент не слышит микрофон во время baseline build. Логи AudioLifecycle не показывают probe, используется только vendor list.
  - Проверить на новой сборке:
    1. Установить HEAD (3cc4feee): adb install -r app-debug.apk
    2. Позвонить на TEST2, дождаться соединения
    3. Абонент ДОЛЖЕН слышать микрофон (звук в обе стороны)
    4. Проверить logcat: adb logcat -s AudioLifecycle | grep 'canCreateHardwareAec' — видна probe
    5. Позвонить снова, звук всё ещё работает
    6. На здоровых unlisted (Pixel): mic unmute НЕ применяется
    7. На listed vendors (Xiaomi): поведение не меняется
    8. Запустить тесты: ./gradlew :app:testSideloadDebugUnitTest — all pass
    Ожидаемо: На устройствах с broken HW AEC вне vendor list (OnePlus, Samsung, Motorola) звонки работают нормально, абонент слышит микрофон. На listed vendors (Xiaomi и т.д.) поведение не меняется (vendor list доминирует, probe не читается). На здоровых unlisted (Pixel, Samsung с рабочим AEC) mic unmute не применяется, audio и эхо в норме. Unit тесты проходят, включая проверку на то, что listed vendors не читают probe (5cd50126 оптимизация).
    Лог: adb logcat -s AudioLifecycle | grep -E 'explicit setMicrophoneMute|canCreateHardwareAec threw|vendor=' — ищите:; - На listed vendor (Xiaomi): '[vendor=XIAOMI] explicit setMicrophoneMute(false) on start' ← список решает, probe не запускается; - На unlisted с broken HW AEC (OnePlus/Samsung с hwAecCreatable=false): '[vendor=GENERIC] explicit setMicrophoneMute(false) on start' ← probe ответил false, mic unmute применена; - На unlisted с working HW AEC (Pixel, Samsung с hwAecCreatable=true): 'setMicrophoneMute(false) on start' НЕ должно быть, audio mode остаётся MODE_IN_COMMUNICATION"
    adb: adb shell getprop ro.build.manufacturer && adb shell getprop ro.build.brand — убедиться, что device unlisted
    adb: adb logcat -c && звонок && adb logcat -s AudioLifecycle | grep -E 'vendor|explicit setMicrophoneMute|canCreateHardwareAec' — полная последовательность решений
    adb: adb shell dumpsys audio | grep -i 'mode.*communication' — должен быть MODE_IN_COMMUNICATION во время звонка
    adb: На unlisted с broken AEC ожидаем: '[vendor=GENERIC] explicit setMicrophoneMute(false) on start'
    adb: На unlisted с working AEC ожидаем: отсутствие 'setMicrophoneMute(false) on start' (probe вернул true)
    adb: На listed (Xiaomi) ожидаем: '[vendor=XIAOMI] explicit setMicrophoneMute(false) on start', БЕЗ 'canCreateHardwareAec threw'
  - Если не исправлен, приложить: adb logcat -s AudioLifecycle | grep -E 'start|requiresMic|prefersSoftware|explicit|vendor|canCreateHardwareAec' — вся последовательность решений; adb shell getprop ro.build.manufacturer && adb shell getprop ro.build.brand — какой device; adb shell dumpsys audio | grep -i 'mode\|mute' — состояние audio HAL; adb logcat -s AudioLifecycle | grep 'threw' — какие API ломаются на device; На реальном аппарате: video vs audio во время звонка — работает ли видео? (указывает на mute specifically на capture); VERBOSE logcat AudioRouter lifecycle (start/stop/applyVendorStartTweaks) — полный path решений
  - Автотесты: android/app/src/test/java/com/forta/chat/plugins/calls/VendorAudioPolicyTest.kt::vendorListDominates_evenWhenHwAecAvailable() — listed vendor с available HW AEC всё равно использует software AEC (не регрессия); android/app/src/test/java/com/forta/chat/plugins/calls/VendorAudioPolicyTest.kt::unlistedDeviceWithBrokenHwAec_needsSoftwareProcessing() — unlisted (OnePlus) с broken HW AEC (hwAecCreatable=false) нужен software fallback; android/app/src/test/java/com/forta/chat/plugins/calls/VendorAudioPolicyTest.kt::unlistedDeviceWithBrokenHwAec_needsMicUnmute() — unlisted с broken HW AEC должна быть mic unmute; android/app/src/test/java/com/forta/chat/plugins/calls/VendorAudioPolicyTest.kt::unlistedHealthyDevice_staysHealthy() — unlisted (Samsung, Pixel) с working HW AEC (hwAecCreatable=true) остаются на hardware AEC (не false positive); android/app/src/test/java/com/forta/chat/plugins/calls/VendorAudioPolicyTest.kt::allMicUnmuteBoundariesMatchSoftwareAecBoundaries() — mic-unmute gate всегда матчит software-AEC gate для всех 4х комбинаций (listed/unlisted × working/broken); android/app/src/test/java/com/forta/chat/plugins/calls/VendorAudioPolicyTest.kt::unavailableHwAecSignal_fallsBackToVendorList() — когда probe недоступен (null/threw), fallback на vendor list (safe на ROMs с неправильными audio API); npm run test — выполняет './gradlew :app:testSideloadDebugUnitTest' и включает все новые VendorAudioPolicy тесты
  - Запись в `docs/manual-verification.md`: «Проба эхоподавителя не срабатывает ложно на здоровом аппарате — проверить что unlisted device с working HW AEC НЕ получает forced mic unmute.»


### Системная интеграция


- [ ] **F18. Пустые каналы уведомлений messages/calls возвращались после каждого запуска**
  - Коммиты: `fb0e6650` · Отчёты: [#75](https://github.com/greenShirtMystery/forta-bugs/issues/75), [#18](https://github.com/greenShirtMystery/forta-bugs/issues/18) · Кластер: notifications
  - Где: Samsung и Pixel · Можно ли: можно проверить · Нужно: Локальная сборка debug APK или CI test APK (для звонка требуется второе устройство или web client); adb с доступом; Два реальных аппарата (Pixel, Samsung) или Maestro-эмулятор + TEST1/TEST2 в .env
  - Ограничения: Локально собранный debug APK не имеет FCM (google-services.json отсутствует); звонок требует второго устройства (web client на одной сети или вторая real phone). Визуальная проверка Settings требует экрана аппарата или adb shell screencap.
  - Симптом: После каждого запуска приложения в настройках уведомлений (Settings → Apps → Forta Chat → Notifications) повторно появлялись два пустых канала: 'messages' и 'calls' (ID в системе: совпадают с названием) — они не использовались и только занимали место в списке, затуманивая современные каналы 'Messages' (messages_v2) и 'Incoming Calls' (incoming_call_v2).
  - Причина: push-service.ts:574-591 (baseline origin/master:66ae28ce) вызывал LocalNotifications.createChannel() с id='messages' и id='calls', но FortaFirebaseMessagingService.kt:51-56 и :89-92 (ensureChannels()) удалял эти же каналы как устаревшие при каждом onCreate() (WEE-75/WEE-18 миграция). Результат: цикл создания-удаления, при котором JS recreate всегда выигрывал, и пустые каналы оставались.
  - Воспроизвести на старой сборке:
    1. Установить базовую сборку (origin/master, 66ae28ce) локальной debug APK на реальный Pixel/Samsung или Maestro-эмулятор.
    2. Запустить приложение, авторизоваться, дойти до экрана чата; push-service.ts на инициализации вызывает LocalNotifications.createChannel({id: 'messages', ...}) и createChannel({id: 'calls', ...}).
    3. Свернуть приложение полностью (нажать Home или смахнуть из Recents).
    4. Выполнить в adb терминале: adb logcat -s FortaPush | grep delete (оставить запущенным).
    5. Переоткрыть приложение; FortaFirebaseMessagingService.onCreate() вызовет ensureChannels(), которая попытается удалить legacy каналы; посмотреть в logcat строки типа 'Failed to delete legacy message channel messages' или аналогичные.
    6. Свернуть и переоткрыть приложение ещё раз (имитировать несколько циклов инициализации).
    7. Открыть Settings → Apps → Forta Chat → Notifications → Все категории (или All categories, если локализация на английском); проскролить список каналов.
    Признак бага: В списке каналов видны две пустые записи: 'messages' (без описания, без звука) и 'calls' (без описания, без звука) наряду с 'Messages' (messages_v2, с описанием 'Incoming messages' и звуком по умолчанию) и 'Incoming Calls' (incoming_call_v2, с описанием и рингтоном).
  - Проверить на новой сборке:
    1. Установить новую сборку (HEAD, fb0e6650) локально собранной debug APK или CI test APK поверх старой (обновление с тем же applicationId=com.forta.chat и debug signature; данные сохраняются) или на чистый аппарат.
    2. Запустить приложение, авторизоваться, дойти до чата; push-service.ts больше НЕ вызывает LocalNotifications.createChannel() (commit fb0e6650 удалил строки 576–591).
    3. Закрыть приложение полностью (Home/Recents) и переоткрыть его 3–4 раза подряд (имитировать несколько циклов инициализации и onCreate()).
    4. Выполнить в adb: adb shell dumpsys notification | grep -E '(messages|calls)' -A 5 — список каналов СИСТЕМЫ; legacy 'messages' и 'calls' должны отсутствовать.
    5. Выполнить в adb: adb logcat -s FortaPush | grep -E '(deleteNotificationChannel|delete.*legacy)' — должны быть логи о попытке удаления, если каналы существуют в системе от старой версии, но обычно будет пусто, т.к. каналы уже давно удалены.
    6. Открыть Settings → Apps → Forta Chat → Notifications и убедиться визуально: пустых каналов 'messages' и 'calls' НЕ ВИДНО; присутствуют только 'Messages' (messages_v2) и 'Incoming Calls' (incoming_call_v2).
    7. Позвонить на этот аппарат с другого устройства (web client на том же сетевом сегменте, или вторая real phone, или эмулятор с TEST1/TEST2 из .env): входящий звонок должен прозвучать со звуком через канал 'Incoming Calls' (incoming_call_v2), без молчания.
    Ожидаемо: Каналы 'messages' и 'calls' отсутствуют в Settings → Notifications; только 'Messages' (messages_v2) и 'Incoming Calls' (incoming_call_v2) присутствуют с корректными описаниями и звуками. Входящий звонок звучит со звуком.
    Лог: Tag: FortaPush (не FortaFirebaseMessagingService); фильтр: adb logcat -s FortaPush | grep -E '(deleteNotificationChannel|delete.*legacy)' — должны быть строки вроде 'Failed to delete legacy message channel messages' или 'Failed to delete legacy channel calls' при каждом вызове ensureChannels() (FortaFirebaseMessagingService.kt:51–56 и :89–92), если каналы существуют в системе."
    adb: adb logcat -s FortaPush | grep -i 'delete.*channel' — должны быть попытки удаления legacy каналов; в выводе могут быть строки типа 'Failed to delete legacy message channel messages' (если удаление не прошло) или вывод может быть пуст (если каналы уже удалены)
    adb: adb shell dumpsys notification | grep -E '(messages|calls)' -A 5 — проверить полный список каналов системы; каналы с id 'messages' и 'calls' должны отсутствовать; только 'messages_v2' и 'incoming_call_v2' должны быть в списке
  - Если не исправлен, приложить: На базовой сборке: adb logcat -s FortaPush | tail -100 — полный лог FortaPush при запуске и инициализации; На новой сборке: adb shell dumpsys notification — полный снимок всех каналов и их состояния до и после обновления; На обеих сборках: adb shell screencap /sdcard/notifications.png && adb pull /sdcard/notifications.png — скриншот Settings → Apps → Forta Chat → Notifications с видимыми (или отсутствующими) каналами; На новой сборке после звонка: adb logcat -s FortaPush | grep -i 'incoming_call' — должны быть логи о том, что уведомление показано в канале 'incoming_call_v2'
  - Автотесты: src/shared/lib/push/push-service-fcm-guard.test.ts — проверить, что моки LocalNotifications удалены (createChannel больше не вызывается в гарде); src/shared/lib/push/push-service-grace.test.ts — проверить, что моки LocalNotifications удалены; src/shared/lib/push/push-service-retry.test.ts — проверить, что моки LocalNotifications удалены; push-service больше не создаёт legacy каналы
  - Запись в `docs/manual-verification.md`: «Пустые каналы уведомлений 'messages' и 'calls' не возвращаются после обновления через one-click install (обновление старой сборки новой) или на чистый аппарат с новой сборкой.»


- [ ] **F19. В системных Аккаунтах вызовов приложение называлось Bastyon Chat**
  - Коммиты: `9e5adff6` · Кластер: calling-accounts
  - Где: Pixel · Можно ли: можно проверить · Нужно: Реальное устройство Pixel (не эмулятор: API-35 может скрыть раздел Аккаунты вызовов); adb; авторизованный аккаунт тестового пользователя для incoming call в verify-шаге
  - Ограничения: API-35 эмуляторы не гарантируют отображение раздела «Аккаунты вызовов» в системных Настройках. Samsung-девайсы иногда скрывают или переименовывают раздел. Требуется Pixel реальный. Upgrade-сценарий критичен — нужна одна и та же микросхема для baseline → HEAD инсталляции (аппарат не перезагружается между инсталляциями, данные авторизации сохраняются).
  - Симптом: После входа в системные Настройки → Приложения → Аккаунты вызовов (путь варьируется по прошивке; на Google Pixel часто Settings → Calls → Calling Accounts или Settings → Apps → Permissions → Phone → Default calling app), запись Forta Chat показывается как «Bastyon Chat» в системном реестре телефонных аккаунтов Android.
  - Причина: CallConnectionService.kt:31 — при регистрации PhoneAccount указан старый текст: `PhoneAccount.builder(handle, "Bastyon Chat")`. Идентификатор handle (ComponentName + id «BastyonChat») остаётся неизменным для совместимости с обновлениями (чтобы не потерять существующий аккаунт в Telecom); менялась только отображаемая метка (display_name).
  - Воспроизвести на старой сборке:
    1. Собрать baseline debug APK: cd android && ./gradlew :app:assembleDebug
    2. Установить на Pixel: adb install android/app/build/outputs/apk/debug/app-debug.apk
    3. Запустить приложение, авторизоваться (TEST1 или TEST2 из .env)
    4. Открыть системные Настройки → Приложения → Разрешения приложений → Телефон → Приложение по умолчанию для звонков (или Settings → Calls → Calling Accounts, если доступно; путь зависит от Android версии и прошивки)
    5. В списке должна быть запись, имя которой содержит «Bastyon Chat»
    6. Примечание: выполняется только на РЕАЛЬНОМ Pixel, не на эмуляторе (API-35 эмулятор может скрыть раздел)
    Признак бага: В системных Настройках раздела Телефон видна запись аккаунта с текстом «Bastyon Chat» (или содержащей это слово).
  - Проверить на новой сборке:
    1. На ТОМ ЖЕ Pixel-аппарате: собрать HEAD debug APK: cd android && ./gradlew :app:assembleDebug
    2. Обновить приложение поверх baseline: adb install -r android/app/build/outputs/apk/debug/app-debug.apk (флаг -r сохраняет данные авторизации и системные аккаунты Telecom)
    3. Перезагрузить приложение (убить процесс: adb shell am force-stop com.forta.chat, затем открыть снова)
    4. Открыть системные Настройки → Приложения → Разрешения приложений → Телефон → Приложение по умолчанию для звонков (тот же путь)
    5. Запись должна отображать «Forta Chat» (не «Bastyon Chat»)
    6. (КРИТИЧНО для upgrade-сценария) Попытаться получить входящий звонок на обновленной сборке — звонок должен поступить нормально. Это проверяет, что handle ID не изменился и Telecom не потерял аккаунт при обновлении.
    Ожидаемо: Название аккаунта в системных Аккаунтах вызовов — «Forta Chat». Входящие звонки работают после обновления без переинициализации Telecom.
    adb: Перед repro (baseline): adb shell dumpsys telecom | grep -i 'bastyon' — найти строки с 'Bastyon Chat' и display_name. Скопировать handle (будет вида BastyonChat).
    adb: После verify (HEAD): adb shell dumpsys telecom | grep -i 'forta' — найти строки с 'Forta Chat' и display_name. Проверить, что handle ID остался тем же 'BastyonChat' (изменилась только label).
  - Если не исправлен, приложить: Скриншот раздела Аккаунты вызовов на baseline (видно «Bastyon Chat»); Скриншот того же раздела после обновления (видно «Forta Chat»); Вывод: adb shell dumpsys telecom (для baseline и HEAD, сравнить handle ID); Информация об устройстве: Settings → About Phone (модель, Android версия); Если verify не пройдена: logcat с момента перезагрузки приложения до момента проверки Настроек (adb logcat -b all)
  - Запись в `docs/manual-verification.md`: «В «Аккаунтах вызовов» запись приложения называется «Forta Chat» (не «Bastyon Chat»); входящие звонки поступают корректно после обновления»


- [ ] **F24. Удалён неиспользуемый libconjure.so (24 МБ); Tor должен работать как раньше**
  - Коммиты: `9b425964` · Кластер: Tor daemon and bridge obfuscation
  - Где: Samsung и Pixel · Можно ли: можно проверить · Нужно: три аккаунта (TEST1/TEST2/TEST3) или два браузера; реальный аппарат (Telecom требует физического device); adb
  - Ограничения: This bench cannot show APK size differences across global CDN caches or diff APK compression ratios on different OEM firmware; locally build and adb-install to confirm size reduction on the actual target device. Tor bootstrap time varies by geography and network state (30–60 sec is typical for Russia; may be longer in regions with Tor congestion).
  - Симптом: APK содержит 24 МБ мёртвого кода (libconjure.so), который никогда не используется — ConfigurationManager объявляет conjurePath, но в BridgeType нет ни одного варианта CONJURE, поэтому этот путь недостижим.
  - Причина: Файл libconjure.so (12.4 МБ в arm64-v8a и 12.1 МБ в armeabi-v7a) объявлен в ConfigurationManager.kt:36 как `val conjurePath`, но ни один код не обращается к этому пути. Enum BridgeType содержит только NONE, VANILLA, OBFS4, SNOWFLAKE, WEBTUNNEL — без CONJURE. android/app/src/main/java/com/forta/chat/plugins/tor/ConfigurationManager.kt:36
  - Воспроизвести на старой сборке:
    1. Установить baseline APK (до 9b425964): adb install -r app-debug.apk
    2. Позвонить на TEST2, дождаться STATE_ACTIVE
    3. Входящий звонок от TEST3 во время разговора
    4. На целевом аппарате: TEST2 должен перейти в HOLD, видно иконка паузы
    5. Отклонить входящий (TEST3) красной кнопкой
    6. TEST2 должен автоматически перейти обратно в ACTIVE
    Признак бага: No observable bug exists — this is a dead-code fix. Proof of the problem: APK is 24 МБ larger than it should be; adb shell dumpsys package com.forta.chat | grep -i native shows libconjure.so in extracted libs.
  - Проверить на новой сборке:
    1. Установить HEAD (9b425964): adb install -r app-debug.apk
    2. Повторить сценарий: TEST2 звонок → входящий TEST3 → отклонить TEST3
    3. TEST2 перейдёт в HOLD, затем обратно в ACTIVE без ошибок
    4. Проверить logcat: adb logcat -s CallConnection | grep -E 'HOLD|ACTIVE' — переходы упорядочены
    5. adb shell dumpsys audio | grep -i mode — MODE_IN_COMMUNICATION, без сбоев
    6. Завершить обе вызовы; приложение НЕ краш/ANR
    Ожидаемо: APK is 24 МБ smaller. 2. libconjure.so absent from /data/app/.../lib/arm64-v8a/ and /data/app/.../lib/armeabi-v7a/. 3. Tor enables/disables and changes bridge modes without errors. 4. Messages work through Tor. 5. No errors about missing 'conjure' library or undefined references in logcat.
    Лог: adb logcat -s TorPlugin,TorManager -v threadtime — expect 'loaded mode=' from TorPlugin.kt:24, '[BOOT] Bootstrap' from TorManager.kt:137, '[BOOT] Tor ready' from TorManager.kt:141; no errors
    adb: adb shell ls -lh /data/app/com.forta.chat-*/base.apk
    adb: adb shell ls -lh /data/app/com.forta.chat-*/lib/arm64-v8a/ && adb shell ls -lh /data/app/com.forta.chat-*/lib/armeabi-v7a/
    adb: adb logcat -s TorPlugin,TorManager -v threadtime
    adb: adb shell cat /data/data/com.forta.chat/app_data/tor/tor.conf | grep -i ClientTransportPlugin
    adb: adb logcat | grep -i conjure
    adb: adb shell dumpsys package com.forta.chat | grep -A 20 native
  - Если не исправлен, приложить: Full logcat for 3 min from Settings toggle to Tor mode: adb logcat > /tmp/tor_logcat.txt; APK metadata: adb shell getprop ro.build.version.release; adb shell getprop ro.product.model; Native library listing: adb shell dumpsys package com.forta.chat | grep -A 20 native > /tmp/tor_native_libs.txt; APK size comparison: adb shell ls -lh /data/app/com.forta.chat-*/base.apk > /tmp/tor_apk_size.txt; Search for 'conjure' in logcat: adb logcat | grep -i conjure (should be empty if fix worked)
  - Автотесты: No unit tests (ConfigurationManager is a configuration holder; line deletion verified by grep); Gradle build: absence of libconjure.so in compiled APK (Gradle's native lib linkage); Git grep for 'conjure': verify zero results on HEAD (ci check, detects reintroduction)
  - Запись в `docs/manual-verification.md`: «Tor работает после удаления libconjure.so»


- [ ] **F25. Единый владелец завершения звонка: аудиорежим сбрасывается и без JS-финализации (O01, хвосты O02/O08)**
  - Коммиты: `07dd6ee8` · Кластер: stuck-after-call · Отчёты: O01 (37 отчётов), примеры в O01
  - Где: Samsung и Pixel · Можно ли: можно проверить · Нужно: обе сборки; для FCM-hangup при убитом процессе — CI-сборка (push)
  - Ограничения: на эмуляторе доказаны два пути — штатное завершение (политика ничего не трогает, `actions=[]`) и смерть процесса во время набора (новый процесс на cold-start увидел `audioMode=3` и открытый маркер сессии, сделал `forceStop(teardown COLD_START)` через 1,1 с после смерти). Смерть процесса во время ринга на эмуляторе API 35 режим не подвешивает: MODE_RINGTONE (маркер закрыт — рингер не сессия роутера) стал MODE_NORMAL через 3 с после `kill -9`, Telecom снял RINGING сам; система перезапустила только `CallConnectionService`, активити не пересоздала, поэтому sweep отработает при следующем открытии приложения. Значит 22 отчёта в MODE_RINGTONE — либо процесс не умирал, либо OEM-AudioService не сбрасывает режим по смерти клиента: это проверяется только на аппарате. FCM-hangup и OEM-переустановка режима (Samsung) на эмуляторе не воспроизводятся. Факт для диагностики: пока self-managed Connection в DIALING/ACTIVE, режим MODE_IN_COMMUNICATION держит сам Telecom и переустанавливает его после нашего `stop()`; отпускает через ~30 мс после `onDisconnect`. Значит `reportCallEnded`, не дошедший до Telecom, = висящий режим, который наш сброс не победит — это семейство слота (O06), а не роутера.
  - Симптом: после звонка телефон остаётся в MODE_IN_COMMUNICATION или MODE_RINGTONE: громкая связь не переключается, медиа играет «как в звонке», следующий звонок без звука — до перезагрузки.
  - Причина: «звонок кончился» решали девять мест, и ни одно не обязано было сбросить всё. ACTION_STOP foreground-сервиса не сбрасывал роутер и не обнулял `instance` (вотчдог роутера считал сервис живым); FCM-hangup только дёргал `currentConnection?.onDisconnect()`, а при пустом слоте не делал ничего; `NativeWebRTCManager.startLocalAudio` и `CallActivity.onResume` писали MODE_IN_COMMUNICATION мимо роутера, без владельца сброса; после смерти процесса режим при холодном старте никто не проверял.
  - Что изменилось: `CallTeardownPolicy` (pure) + `CallTeardown.endCall(reason, callId)` из `CallConnection.onReject/onDisconnect`, FCM-hangup (`REMOTE_HANGUP`, когда соединения уже нет) и `CallPlugin.load()` (`COLD_START`). Роутер помечает свою сессию в `shared_prefs/forta_audio_router.xml` (`session_open`); чужой MODE_IN_COMMUNICATION (звонок другого приложения) не трогается. Прямые записи режима заменены на `AudioRouter.ensureCommunicationMode()` с 5-минутным вотчдогом. `ACTION_STOP` делает `forceStop("fgs_stop")` и обнуляет `instance`; STOP от предыдущего звонка, пришедший после старта следующего, игнорируется по счётчику поколений (иначе он глушил бы новый звонок).
  - Воспроизвести на старой сборке:
    1. Установить `forta-old.apk`.
    2. Серия из 10 звонков Samsung↔Pixel с чередованием: положил я / положил собеседник / не ответил 45 с / отклонил / смахнул из недавних во время разговора.
    3. После каждого звонка через 30 с: `adb shell dumpsys audio | grep -A3 "Audio mode"`.
    4. CI-сборка: на Pixel во время ринга смахнуть приложение из недавних, на Samsung положить трубку; через 30 с снять режим на Pixel.
    Признак бага: `Actual mode = MODE_IN_COMMUNICATION` или `MODE_RINGTONE` без идущего звонка. Проявляется не каждый раз (37 отчётов на 13 вендорах) — серия нужна целиком.
  - Проверить на новой сборке:
    1. Установить `forta-new.apk` поверх старой.
    2. Повторить серию из 10 звонков; после каждого через 30 с `adb shell dumpsys audio | grep -A3 "Audio mode"` → `MODE_NORMAL`.
    3. FCM-hangup (CI-сборка): Pixel убит во время ринга (смахнуть из недавних), Samsung кладёт трубку → в логе Pixel `CallTeardown: endCall reason=REMOTE_HANGUP …`; через 30 с `MODE_NORMAL`.
    4. Cold-start: убить процесс Pixel во время разговора (`adb shell run-as com.forta.chat kill -9 $(adb shell pidof com.forta.chat)` на debug-сборке или смахнуть из недавних), открыть приложение → `CallTeardown: endCall reason=COLD_START … sessionMarkerOpen=true actions=[FORCE_STOP_ROUTER]` и `AudioLifecycle: forceStop(teardown COLD_START)`; если система уже сбросила режим сама — `actions=[]`, это тоже норма.
    5. Redial: сразу после завершения звонка позвонить снова — у второго звонка есть звук в обе стороны (устаревший ACTION_STOP первого звонка не глушит второй).
    Ожидаемо: ни одного `MODE_RINGTONE`/`MODE_IN_COMMUNICATION` без идущего звонка; на каждое завершение ровно одна строка `CallTeardown: endCall`; маркер `session_open` вне звонка `false`.
    Лог: `adb logcat -s CallTeardown AudioLifecycle CallForegroundService CallConnectionService`
    adb: `adb shell dumpsys audio | grep -A3 "Audio mode"` — строки `Actual mode` и `Mode owner`
    adb: `adb shell run-as com.forta.chat cat shared_prefs/forta_audio_router.xml` (debug-сборка) — `session_open` вне звонка `false`
    adb: `adb shell dumpsys telecom | grep -E "Call id=TC@"` — после завершения пусто
  - Если не исправлен, приложить: `adb logcat -s CallTeardown AudioLifecycle CallForegroundService CallConnectionService AudioRouter` за минуту вокруг завершения, `dumpsys audio`, `dumpsys telecom` и отчёт из приложения (таймлайн аудио: события `force_stop`, `mode_ensure`, `mode_reapply`).
  - Автотесты: `CallTeardownPolicyTest.kt` (таблица reason×state), `CallTeardownContractTest.kt` (все хуки зовут `endCall`; только роутер пишет MODE_IN_COMMUNICATION; stale STOP; маркер закрывается на обоих путях), `AudioRouterEnsureModeTest.kt`, `CallServiceStopPolicyTest.kt`; androidTest `CallTeardownInstrumentedTest.kt` — реальный AudioManager на эмуляторе (`./gradlew :app:connectedSideloadDebugAndroidTest`).
  - Запись в `docs/manual-verification.md`: «Аудиорежим сбрасывается без JS-финализации: убитый процесс, FCM-hangup, серия звонков».

- [ ] **F26. Один владелец ринга по callId; ответ из шторки и с экрана блокировки не сбрасывает звонок (O04, O09)**
  - Коммиты: `d606afdc` · Кластер: duplicate-ring, accept-button · Отчёты: O04 (4), O09 (6)
  - Где: Samsung и Pixel · Можно ли: можно проверить · Нужно: обе сборки; для «убитый процесс + шторка» и keyguard — CI-сборка (push)
  - Ограничения: на эмуляторе API 35 подтверждён только цикл рингера в рантайме: `IncomingRinger: arm` при ринге, через 30 с `auto-rejecting` → `stop` → Telecom REJECT → `CallTeardown` (MODE_RINGTONE не трогается, режим вернулся в NORMAL после отпускания Telecom); ответ через Telecom-уведомление и ответ с экрана прогнать не удалось — на софтверном рендере SystemUI отвечает ANR-диалогами, тап по кнопке Answer в шторке не доходит до PendingIntent, затем эмуляторы упали. Путь шторки, keyguard с PIN и путь FCM при убитом процессе — только аппарат (CI-сборка).
  - Симптом: после ответа рингтон продолжает играть поверх разговора, и на 30-й секунде звонок сбрасывается; «Принять» из шторки или с заблокированного экрана оставляет «Соединение…» навсегда или сбрасывает звонок.
  - Причина: рингтон, вибрация и 30-секундный авто-сброс жили в экземпляре `IncomingCallActivity`, а accept/decline-интенты Telecom-уведомления запускались с голым `NEW_TASK`: если экран ринга не был наверху задачи, создавался второй экземпляр, статический указатель переезжал на него, а первый экземпляр продолжал звонить и на 30-й секунде делал `decline()` → reject уже принятого звонка. Те же интенты не несли `roomId`, а `onNewIntent` подменял intent целиком — push-уведомление не гасилось, JS не получал комнату и сам сбрасывал звонок через 30 с. `MainActivity` (singleTask) поднимала keyguard только в `onCreate` — при тёплом процессе ответ с экрана блокировки оставлял WebView остановленным.
  - Что изменилось: `IncomingRinger` (объект процесса, ключ callId; `IncomingRingerLedger` — чистая часть) владеет рингтоном, вибрацией и дедлайном; его останавливают Accept на экране, `CallConnection.onAnswer`, `reportCallConnected` из JS и `CallTeardown` (действие `STOP_RINGER`, для REJECT/DISCONNECT — только по совпадению callId). Telecom-интенты accept/decline получили `CLEAR_TOP|SINGLE_TOP` и `roomId`; `onNewIntent` сливает extras через `IncomingIntentMerge` (недостающие берутся из удерживаемого intent, только для того же звонка). `decline()` для звонка, который уже не звонит, при установленном соединении в слоте — игнорируется (не пишет reject-маркеры, не грузит JS с `push_call_decline`). `onAnswer`/`reportCallConnected` гасят push-уведомление. `MainActivity.onNewIntent` поднимает keyguard так же, как `onCreate`.
  - Воспроизвести на старой сборке:
    1. Установить `forta-old.apk` на Pixel (принимающий), Samsung звонит.
    2. Пока Pixel звонит, нажать Home (экран ринга уходит с верха задачи), раскрыть шторку, нажать «Принять» на уведомлении Forta.
    3. Слушать 40 с.
    4. Вариант: заблокировать Pixel (PIN), принять из шторки на экране блокировки.
    Признак бага: рингтон играет поверх разговора; на 30-й секунде звонок сбрасывается (у звонящего «отклонён»); при keyguard — «Соединение…» не проходит до ручной разблокировки.
  - Проверить на новой сборке:
    1. Установить `forta-new.apk` поверх старой.
    2. Повторить шаги 2–4; звонок жив на 45-й секунде, рингтон замолкает в момент ответа.
    3. `adb logcat -s IncomingRinger IncomingCallActivity CallConnectionService` — есть `IncomingRinger: stop callId=…` сразу после `onAnswer`, нет `auto-rejecting`, нет второго `onCreate` у IncomingCallActivity, нет `decline ignored` (или есть — тогда это сработавшая защита, звонок при этом жив).
    4. CI-сборка: убить процесс Pixel (смахнуть из недавних) до звонка, позвонить с Samsung, принять из шторки при выключенном экране: звонок соединяется без разблокировки; в логе `MainActivity`-путь не нужен — смотреть, что нет `Connecting` дольше 10 с.
    5. Отклонение из шторки при живом процессе всё ещё работает: у звонящего «отклонён» в течение 3 с.
    Ожидаемо: ни одного сброса на 30-й секунде; ответ из шторки/с экрана блокировки соединяет; decline из шторки отклоняет.
    Лог: `adb logcat -s IncomingRinger IncomingCallActivity CallConnectionService CallTeardown`
    adb: `adb shell dumpsys activity activities | grep IncomingCallActivity` — во время ринга ровно одна запись
    adb: `adb shell cmd statusbar expand-notifications` — раскрыть шторку без рук
  - Если не исправлен, приложить: `adb logcat -s IncomingRinger IncomingCallActivity CallConnectionService CallTeardown CallPlugin` за минуту вокруг ответа + `dumpsys activity activities` во время ринга.
  - Автотесты: `IncomingRingerLedgerTest.kt`, `IncomingIntentMergeTest.kt`, `IncomingRingerContractTest.kt` (владелец один; флаги и roomId у интентов; onAnswer/reportCallConnected гасят ринг и push; decline gated; MainActivity.onNewIntent), `CallTeardownPolicyTest.kt` (STOP_RINGER по ключу). Maestro `05-call-answer.yaml` теперь ждёт 35 с после ответа и повторно проверяет `Mute`.
  - Запись в `docs/manual-verification.md`: «Ответ из шторки и с экрана блокировки переживает 30-ю секунду».

- [ ] **F27. ICE-кандидаты, пришедшие до answer, больше не теряются (O15)**
  - Коммиты: `d4ae4282` · Кластер: connect-fail · Отчёты: O15 (код), вероятный вклад в O02/O05 («Соединение…» без relay)
  - Где: Samsung и Pixel · Можно ли: можно проверить · Нужно: обе сборки, две сети (Samsung на сотовой, Pixel на Wi-Fi)
  - Ограничения: на эмуляторах прогон до ICE-пути не дошёл (звонок заканчивался в пределах 10 с после ринга, экран ринга исчезал до ответа) — подтверждение только тестами; на эмуляторе сценарий тот же, что на стенде. Слышимость не проверяется — только факт соединения и логи.
  - Симптом: звонящий видит «Соединение…» до таймаута, хотя вызываемый ответил; повторный звонок иногда проходит.
  - Причина: `onAnswerReceived` в matrix-js-sdk добавляет кандидаты, накопленные за время ринга, **до** `setRemoteDescription(answer)` и глотает отказ на уровне info; и браузер, и нативный движок отвергают кандидата без remote description. Всё, что вызываемый отправил до обработки answer, терялось; если он уже закончил сбор кандидатов, второго шанса не было.
  - Что изменилось: `ice-candidate-buffer.ts` — `attachIceCandidateBuffer(pc)` оборачивает `addIceCandidate`/`setRemoteDescription` на экземпляре: пока `remoteDescription == null`, кандидаты копятся по порядку и добавляются сразу после установки remote description; при `signalingState == "closed"` очередь сбрасывается; неудача одного кандидата не роняет остальные и не проваливает `setRemoteDescription`. Подключается в `call-service.ts` в `onPeerConnectionCreated` (до диагностики), работает для обоих движков.
  - Воспроизвести на старой сборке:
    1. Установить `forta-old.apk` на оба аппарата; Samsung на сотовой, Pixel на Wi-Fi.
    2. На Pixel (вызываемый) заранее открыть чат со звонящим, чтобы ответ был мгновенным.
    3. Samsung звонит, Pixel отвечает сразу по появлению экрана.
    4. В логе Samsung: `adb logcat | grep -iE "addIceCandidate|failed to add remote ICE"`.
    Признак бага: строки `addIceCandidates() failed to add remote ICE candidate` сразу после `onAnswerReceived`, звонок в «Соединение…» 20–30 с и обрыв (или соединение только со второй попытки).
  - Проверить на новой сборке:
    1. Установить `forta-new.apk` поверх старой на оба.
    2. Повторить 5 звонков Samsung→Pixel с мгновенным ответом и 5 Pixel→Samsung.
    3. В логе звонящего: `adb logcat -v time | grep -E "ice-buffer|failed to add remote ICE|ICE connection"`.
    Ожидаемо: строки `[ice-buffer] holding candidate #N …` и затем `[ice-buffer] remote description set, adding N held candidate(s)`; нет `failed to add remote ICE candidate`; `ICE connection: connected` в пределах 5 с после ответа; 10 из 10 звонков соединяются.
    Лог: `adb logcat -v time | grep -E "ice-buffer|addIceCandidate|ICE connection|Signaling"`
    adb: `adb logcat -s WebRTCPlugin | grep -i addIceCandidate` — на нативном движке нет reject
  - Если не исправлен, приложить: логкат звонящего за минуту вокруг ответа + отчёт из приложения (после коммита 6 в нём будут relay/host/srflx и selected pair).
  - Автотесты: `ice-candidate-buffer.test.ts` (порядок, сквозной проход после SRD, closed, end-of-candidates, ошибка SRD сохраняет очередь, ошибка одного кандидата, двойной attach); `call-service.test.ts` → «attaches the candidate buffer to the peer connection the SDK creates».
  - Запись в `docs/manual-verification.md`: «ICE-кандидаты до answer доходят до соединения».

- [ ] **F28. Исходящий видеозвонок открывает камеру один раз; живой трек попадает в каждое соединение (O11)**
  - Коммиты: `4c23a27b` · Кластер: video · Отчёты: O11 (#1222 «одна сторона видит, другая нет», #1226 «в видео меня не слышно»)
  - Где: Samsung и Pixel · Можно ли: можно проверить · Нужно: обе сборки, реальная камера на обоих
  - Ограничения: на эмуляторе камера виртуальная — проверяется только факт одного захвата (одна строка `Local video started with camera` на звонок) и по одному `attached video track` на соединение; качество картинки и OEM-энкодеры — только стенд. Прогон на эмуляторах 2026-09-08 не завершён (хост дважды зависал и перезагрузился) — эмуляторного подтверждения у F28 нет.
  - Симптом: в исходящем видеозвонке своё превью есть, у собеседника чёрный квадрат (или наоборот); после такого звонка камера «занята» до перезапуска приложения; иногда собеседника не слышно в видеозвонке.
  - Причина: `launchCallUI` уходит до `placeVideoCall`, и `CallActivity` с главного потока зовёт `startLocalVideo("")`, пока plugin-поток выполняет `startLocalMedia` — а `startLocalVideo` (в отличие от `startLocalAudio`) не был под `mediaLock`. Оба прохода видели `localVideoTrack == null` и открывали камеру: второй захват не получал кадров, первый утекал вместе с камерой, а в соединение уходил тот трек, что был присвоен последним. Плюс ветки «трек уже есть»: при пустом `peerId` не прикрепляли трек ни к одному соединению, при заданном — прикрепляли без проверки (повторный `addTrack` в libwebrtc бросает исключение).
  - Что изменилось: `CallActivity.initVideoRenderers` больше не открывает камеру — только привязывает превью (`attachLocalRenderer`, без блокировки; свежий трек на plugin-потоке сам подхватывает уже привязанное превью, поля volatile, `addSink` идемпотентен); `startLocalVideo` под `mediaLock` (`startLocalVideoLocked`) — с главного потока туда теперь попадают только ответ на разрешение камеры и переключатель видео в разговоре, оба вне teardown'а; новый чистый `TrackAttachPolicy.targets(peerId, trackId, sendersByPc)` — пустой `peerId` = «все соединения без этого трека», заданный = «оно, если ещё нет»; единственная точка `addTrack` для локальных треков — `attachLocalTrackLocked`, через неё идут `createPeerConnection`, свежие и уцелевшие ветки аудио и видео. `peerId` из прокси не пробрасывается: `getUserMedia` там — модульная функция без соединения, а правило для пустого `peerId` покрывает все соединения.
  - Воспроизвести на старой сборке:
    1. `forta-old.apk` на оба; на Pixel (звонящий) `adb logcat -c`.
    2. Pixel → Samsung видеозвонок, Samsung отвечает; 20 с разговора.
    3. На Pixel: `adb logcat -d | grep -E "Local video started|Auto-attached|track added to PC|Camera"`.
    Признак бага: две строки `Local video started with camera` за один звонок (и/или ошибка камеры `in use`/`CameraAccessException`); у Samsung чёрный квадрат вместо картинки Pixel при живом превью на Pixel.
  - Проверить на новой сборке:
    1. `forta-new.apk` поверх старой на оба.
    2. 3 видеозвонка Pixel→Samsung и 3 Samsung→Pixel, по 20 с; в каждом: обе картинки, звук в обе стороны, переключение камеры.
    3. На звонящем: `adb logcat -d | grep -E "Local video started|attached (audio|video) track|already on every connection|senders unreadable|Camera"`.
    Ожидаемо: ровно одна строка `Local video started with camera` на звонок; по одной `attached audio track` и `attached video track` на соединение (`[pc_…]`); повторный заход (`startLocalVideo(reuse)`) даёт `already on every connection`; нет ошибок камеры; 6 из 6 звонков с картинкой и звуком в обе стороны.
    Лог: `adb logcat -v time -s NativeWebRTCManager WebRTCAudio CallActivity`
  - Если не исправлен, приложить: логкат звонящего от нажатия «Видеозвонок» до 30-й секунды разговора + отчёт из приложения.
  - Автотесты: `TrackAttachPolicyTest` (8 строк таблицы), `TrackAttachContractTest` (единственная точка `addTrack`, обе reuse-ветки через правило, `startLocalVideo` под `mediaLock`, `initVideoRenderers` без `startLocalVideo`, `attachLocalRenderer` без блокировки и порядок записи/чтения полей в обеих ветках гонки). Соединение, чьи senders не читаются (идёт teardown), пропускается с warning; ошибки `addTrack` по-прежнему всплывают наверх.
  - Запись в `docs/manual-verification.md`: «Одна камера на исходящий видеозвонок».

- [ ] **F29. Громкая связь: отказ вместо молчания, ручной выбор не сбивается Bluetooth (O08)**
  - Коммиты: `62581806` · Кластер: speaker-toggle · Отчёты: O08 (#1334 OnePlus, #1328, #1223)
  - Где: Samsung и Pixel · Можно ли: можно проверить · Нужно: обе сборки, Bluetooth-гарнитура
  - Ограничения: на эмуляторе нет Bluetooth и нет отдельного динамика/наушника — эмулятором не проверяется. Прошивки, где оба API переключения динамика игнорируются (часть OnePlus), фикс не чинит: они видны как `route: … FAILED` в таймлайне отчёта.
  - Симптом: кнопка динамика загорается, а звук остаётся в наушнике (или наоборот); при подключённой/мигающей Bluetooth-гарнитуре звук уходит в неё сразу после нажатия «динамик».
  - Причина: `AudioRouter.setDevice` при неактивном роутере (звонок ещё не дошёл до `start()` или уже разобран) молча выходил, `CallPlugin.setAudioDevice` всё равно резолвил, мост глотал ошибку, а `CallControls` уже перевернул `speakerOn`. Отдельно `handleDevicesChanged` при появлении Bluetooth безусловно переключал на него поверх ручного выбора — гарнитура с «мигающим» соединением каждый раз снимала громкую связь.
  - Что изменилось: `setDevice` возвращает `Boolean` и при неактивном роутере отказывает (с записью в таймлайн), не оживляя роутер; `CallPlugin.setAudioDevice` → `reject("router_inactive")`; мост возвращает `false`; `CallControls.applyNativeRoute` откатывает переключатель и показывает тост `call.routeUnavailable`. Ручной выбор — пин (`pinnedDevice`): новая чистая `AudioRoutePolicy` при появлении Bluetooth не трогает запинённый динамик (наушник — трогает: иначе гарнитуру, подключённую в разговоре, нечем выбрать), пин снимается вместе с исчезнувшим устройством и в `start()`. Пин и решение по смене устройств — под одним `routeLock` (plugin-поток против main-потока). Известное ограничение: нативный список устройств в `CallActivity` (нижний лист) отказ по-прежнему не показывает — там галочка считается от реального состояния, а не оптимистично, поэтому неверного состояния нет, только проигнорированный тап с записью `refused` в логе.
  - Воспроизвести на старой сборке:
    1. `forta-old.apk`; на Pixel `adb logcat -c`; позвонить Samsung и нажать «динамик» в первую секунду после «Вызов…», до соединения.
    2. Признак бага: кнопка горит, звук в наушнике; в `adb logcat -s AudioRouter` нет `setDevice: SPEAKER`.
    3. В соединённом звонке включить динамик, затем подключить Bluetooth-гарнитуру: звук уходит в гарнитуру, кнопка динамика гаснет.
  - Проверить на новой сборке:
    1. `forta-new.apk` поверх старой; тот же ранний тап: кнопка возвращается в «выкл.» и появляется тост «Не удалось переключить звук…»; в логе `setDevice(SPEAKER) refused: router inactive`.
    2. В соединённом звонке: динамик вкл → выкл → вкл, каждый раз в логе `setDevice: … (pinned)` и слышимая смена маршрута.
    3. Динамик включён, подключить Bluetooth-гарнитуру: звук остаётся на динамике (`Devices changed: … pinned=SPEAKER`, без `routing to BLUETOOTH`); выключить динамик — звук уходит в гарнитуру. Отключить гарнитуру в разговоре с активным Bluetooth: fallback на наушник/динамик.
    4. Повторить п. 2 на движке WebView (F23).
    Лог: `adb logcat -v time -s AudioRouter CallPlugin`
  - Если не исправлен, приложить: логкат от нажатия до +5 с + отчёт из приложения (таймлайн `route`).
  - Автотесты: `AudioRoutePolicyTest` (8 строк таблицы), `AudioRoutePinContractTest` (отказ без старта роутера, reject в плагине, политика в `handleDevicesChanged`, сброс пина в `start()`), `call-controls-speaker.test.ts` (откат + тост при `false`, тишина при `true`), `native-call-bridge.set-audio-device.test.ts` (`false` при reject).
  - Запись в `docs/manual-verification.md`: «Громкая связь: отказ и пин ручного выбора».

- [ ] **F30. Отчёт об ошибке показывает relay/host/srflx, выбранную пару и Tor; предупреждения «нет relay» и «звонок мимо Tor» (O05, O14)**
  - Коммиты: `e9ec3f09` · Кластер: connect-fail · Отчёты: O05 (8 «Соединение…»), O14 (код)
  - Где: Samsung и Pixel · Можно ли: можно проверить · Нужно: CI-сборка (отчёты уходят только с `VITE_BUG_REPORT_TOKEN`), Samsung на сотовой сети
  - Ограничения: клиент только показывает факты. Есть ли TURN на сервере — это `curl` к homeserver (ниже) и coturn на сервере; на эмуляторе сеть без NAT-симметрии, relay=0 там норма и ничего не значит.
  - Симптом: «Соединение…» до таймаута; в отчёте нет ни слова о том, дошёл ли клиент до relay-кандидата; пользователь с включённым Tor не знает, что звонок идёт мимо него.
  - Причина: `webrtcDiagnostics` считал relay/host/srflx только в текстовый summary, в конверт отчёта они не попадали; предупреждения о «нет relay» не было; Tor-режим на звонок не влияет (`routing.ts` проксирует только HTTP) и никак не сообщается.
  - Что изменилось: `webrtcDiagnostics.getIceSummary()` (счётчики, пара last local/remote, `lastIceState`, число turn/turns в конфигурации PC) и предупреждение `ice_failed_no_relay` (ICE failed при relay=0, один раз на attach); `collectCallDiagnostics` получает `ice` и `tor` через провайдера, который регистрирует `call-service` (shared не импортирует features); строки `ICE candidates`, `ICE result`, `Tor` в теле отчёта; тосты `call.warning.noRelay` и `call.warning.torBypassed` (при `placeCall`/`answer`, если Tor включён).
  - Воспроизвести на старой сборке:
    1. `forta-old.apk`; отчёт из приложения после любого звонка: в разделе «Call diagnostics» нет строк ICE/Tor.
  - Проверить на новой сборке:
    1. `forta-new.apk`; Samsung на сотовой ↔ Pixel на Wi-Fi, 30 с разговора, отчёт из приложения с Samsung: строки `| ICE candidates | relay=… host=… srflx=… (TURN servers: N) |` и `| ICE result | connected via … |`. `relay=0` при `TURN servers: 0` — сервер не отдал TURN (см. п. 3); `relay=0` при `TURN servers: >0` — relay недостижим из этой сети.
    2. Включить Tor в настройках, позвонить: тост «Звонки идут мимо Tor…» при наборе и при ответе; в отчёте `| Tor during calls | on — calls bypass Tor |`.
    3. Сервер (владелец): `curl -s -H "Authorization: Bearer $TOKEN" https://<homeserver>/_matrix/client/v3/voip/turnServer` — есть ли `uris` с `turns:…:443?transport=tcp`. Пустой ответ = O05-сервер открыт (класс C).
    Лог: `adb logcat -v time | grep "WebRTC-Diag"` — строки `ICE candidate: relay …`.
  - Если не исправлен, приложить: отчёт из приложения (раздел Call diagnostics целиком).
  - Автотесты: `webrtc-diagnostics.test.ts` (summary, TURN из конфигурации, предупреждение один раз и только при relay=0, проброс в обработчик SDK), `collect-call-diagnostics.test.ts` (провайдер, web, отказ провайдера), `bug-report-sender.test.ts` (строки/их отсутствие), `call-service.test.ts` (тост Tor один раз, тост no-relay).
  - Запись в `docs/manual-verification.md`: «Факты ICE и Tor в отчёте».

- [ ] **F31. Отозванный full-screen intent виден в настройках и в отчёте; качелька громкости на экране входящего крутит рингер (O10, O13)**
  - Коммиты: `1adc0949` · Кластер: incoming-missed / ring · Отчёты: O10 (2), O13 (3)
  - Где: Samsung и Pixel · Можно ли: можно проверить · Нужно: Android 14+ для баннера, обе сборки
  - Ограничения: баннер и поле отчёта существуют только с Android 14 (до него разрешение даётся манифестом). Doze и MIUI-автозапуск фиксом не трогаются. Эмулятор: без прогона (после двух зависаний хоста эмуляторы не поднимались).
  - Симптом: входящий при закрытом приложении приходит маленькой плашкой или не замечается; на экране входящего качелька громкости меняет громкость медиа, а рингтон продолжает орать.
  - Причина: Android 14 отзывает `USE_FULL_SCREEN_INTENT` у приложений не из магазина; нативная сторона это логировала (`canUseFullScreenIntent()` в FCM-сервисе и `CallConnectionService`), но пользователю и в отчёт не сообщала. `IncomingCallActivity` не ставил `volumeControlStream`, и качелька шла в `STREAM_MUSIC`.
  - Что изменилось: `PushData.getFullScreenIntentStatus()` (`allowed`, `manageable`) и `openFullScreenIntentSettings()` (`ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT` для пакета); в настройках уведомлений баннер «Входящий звонок может не подняться на экран» с кнопкой в системный экран, только при `allowed=false`; поле `fullScreenIntentAllowed` в отчёте и строка `| Full-screen intent | REVOKED |`; `volumeControlStream = STREAM_RING` в `IncomingCallActivity.onCreate`.
  - Воспроизвести на старой сборке:
    1. Android 14+: Настройки → Приложения → Forta Chat → «Полноэкранные уведомления» выключить. Убить приложение, позвонить с другого аппарата: только плашка, экран не поднимается; в настройках приложения об этом ни слова.
    2. Во время ринга нажать «громкость −»: индикатор показывает «Медиа», рингтон не тише.
  - Проверить на новой сборке:
    1. То же выключение разрешения; открыть Настройки → Уведомления в Forta Chat: баннер с кнопкой; кнопка открывает системный экран «Полноэкранные уведомления»; после включения и повторного входа баннер исчезает.
    2. Отчёт из приложения при выключенном разрешении: `| Full-screen intent | REVOKED |`.
    3. Во время ринга «громкость −»: индикатор «Звонок/Рингтон», рингтон тише.
    4. Doze 30 мин → входящий: без изменений ожиданий (O10 п. 1), фикс на это не претендует.
  - Если не исправлен, приложить: скриншот экрана настроек уведомлений + отчёт из приложения.
  - Автотесты: `IncomingCallSurfaceContractTest` (STREAM_RING в onCreate, гейт API 34, deep-link для пакета, разрешение в манифесте), `use-notification-settings.test.ts` (false/null/reject, открытие экрана), `notification-settings-fsi.test.ts` (баннер только при `false`, кнопка), `collect-call-diagnostics.test.ts` (Android 14 / до 14 / iOS), `bug-report-sender.test.ts` (строка).
  - Запись в `docs/manual-verification.md`: «Full-screen intent и качелька громкости».

- [ ] **F32. Исходящее Telecom-соединение получает свой callId; читатели слота проверяют id (O06)**
  - Коммиты: `dac97dcb` · Кластер: stuck-after-call / second-call · Отчёты: O06 (код)
  - Где: Samsung и Pixel · Можно ли: можно проверить · Нужно: обе сборки, третья сторона (веб) для второго входящего
  - Ограничения: слот по-прежнему один — второй входящий во время разговора получает BUSY (продуктовое решение, см. O06).
  - Эмулятор (2026-09-08, Pixel API 35): исходящий звонок трижды подряд дал `onCreateOutgoingConnection: callId=<непустой>` (`17888941120839MDNeA1eMYRpz3TJ`, `1788894492345jh7jYYn9RA7FV7B6`, `1788894886107Friczfn3GfTAzWQB`) — вложенные extras доезжают до ConnectionService. В том же прогоне сквозной звонок A→B: `IncomingRinger arm/stop` по одному callId, `CallTeardown endCall reason=DISCONNECT callId=… State(otherCallLive=false …) actions=[]` с обеих сторон (новая `CallSlotPolicy` сравнила id и не сочла слот чужим), режим на обоих вернулся в `MODE_NORMAL`. Второй входящий во время разговора на двух эмуляторах не проверяется — нужна третья сторона.
  - Симптом: во время разговора приходит и отбивается второй звонок — и разговор рвётся; или после «занято» у второго звонящего первый звонок остаётся в состоянии звонка (Telecom держит аудиорежим).
  - Причина: `CallPlugin.reportOutgoingCall` клал `callId` прямо в extras `placeCall`, а Telecom доносит до `onCreateOutgoingConnection` только bundle под `EXTRA_OUTGOING_CALL_EXTRAS` — у каждого исходящего соединения `callId=""` (лог `onCreateOutgoingConnection: callId=, callee=`). `reportCallEnded`, `reportCallConnected` и push-hangup брали слот без проверки id: конец звонка B завершал звонок A.
  - Что изменилось: extras вложены под `EXTRA_OUTGOING_CALL_EXTRAS`, `onCreateOutgoingConnection` читает и вложенный bundle; чистая `CallSlotPolicy.owns(slotCallId, requestedCallId)` — слот «свой», если запрос без id, слот без id, id совпали или слот ключуется push `event_id` (`$…`, несопоставим с Matrix `call_id` — иначе слот нельзя было бы завершить); три читателя (`reportCallEnded`, `reportCallConnected`, FCM `m.call.hangup`) проходят через неё и пишут warning, когда оставляют чужой слот; той же политикой пользуются `CallTeardown.collectState` (`otherCallLive` — раньше `$`-слот считался «другим звонком», и force-stop роутера пропускался) и `IncomingCallActivity.rejectRingingConnection`.
  - Воспроизвести на старой сборке:
    1. `forta-old.apk` на Pixel; `adb logcat -s CallConnectionService`; исходящий звонок с Pixel: строка `onCreateOutgoingConnection: callId=, callee=…` (пустой id).
    2. Pixel↔Samsung в разговоре; с веба позвонить на Pixel, дождаться «занято»/отбоя: разговор Pixel↔Samsung рвётся или Pixel остаётся «в звонке» после конца.
  - Проверить на новой сборке:
    1. `forta-new.apk`; исходящий с Pixel: `onCreateOutgoingConnection: callId=<непустой>`.
    2. Тот же второй входящий с веба во время разговора: второй получает «занято», разговор живёт; в логе `CallPlugin` строка `reportCallEnded(<id второго>): slot holds <id первого>, leaving it`; после конца разговора `dumpsys audio | grep "Actual mode"` → `MODE_NORMAL`.
    3. Обычный цикл: позвонить, поговорить 20 с, положить трубку с каждой стороны по разу — нет застревания.
    Лог: `adb logcat -v time -s CallConnectionService CallPlugin FortaFCM`
  - Если не исправлен, приложить: логкат обоих аппаратов + отчёт из приложения.
  - Автотесты: `CallSlotPolicyTest` (5 строк), `CallSlotContractTest` (вложенные extras, чтение вложенного bundle, пять читателей через `owns`).
  - Запись в `docs/manual-verification.md`: «Слот Telecom по callId».

### Диагностика: инструменты, которые понадобятся для остальных пунктов


- [ ] **F20. Выбор симптома в опросе после звонка открывает форму отчёта**
  - Коммиты: `fef8f5d4` · Кластер: UI modal mounting
  - Где: эмулятор · Можно ли: можно проверить · Нужно: Android 13+ для запроса Notification permission; TEST1/TEST2 в .env; adb
  - Ограничения: Баг появился в коммите 0206db61, который существует только в этой ветке. На origin/master не воспроизводится (механизм post-call prompt добавлен позже, в той же ветке).
  - Симптом: После завершения звонка при нажатии на симптом в опросе обратной связи форма отчёта о баге не открывается; опрос просто закрывается и исчезает.
  - Причина: BugReportModal был смонтирован только внутри SettingsPanel.vue (source: src/features/settings/ui/SettingsPanel.vue). Когда CallFeedbackPrompt (смонтируется в App.vue, добавлена в 0206db61) вызывает useBugReport().open() после выбора симптома, флаг isOpen устанавливается в компоненте, которого нет в DOM. fef8f5d4 перемещает BugReportModal из SettingsPanel.vue в App.vue (root level), чтобы компонент был доступен из любой части приложения.
  - Воспроизвести на старой сборке:
    1. Установить baseline на Android 13+ (без фикса)
    2. Убедиться что Notifications permission = OFF: Settings → Permissions → Notifications
    3. Позвонить на TEST2, дождаться входящего на целевом аппарате
    4. ОС должна показать permission prompt: 'Forта хочет отправлять уведомления'
    5. Нажать 'Разрешить' в prompt
    6. Входящий звонок должен зазвонить (рингтон и экран)
    Признак бага: Форма отчёта о баге не видна на экране после выбора симптома. В браузер Console (F12) отсутствуют логи [BugReport]. В Vue devtools компонент BugReportModal не смонтирован в DOM.
  - Проверить на новой сборке:
    1. Установить HEAD APK: adb install -r app-debug.apk или revoke permission: adb shell pm revoke com.forta.chat android.permission.POST_NOTIFICATIONS
    2. Позвонить на TEST2, дождаться входящего
    3. ОС prompt должна появиться ДО рингтона (фикс: requestNotificationPermissionBeforeRinging)
    4. Нажать 'Разрешить' в prompt
    5. Входящий звонок должен зазвонить сразу, звук и экран работают
    6. Проверить Settings → Permissions → Notifications: Forta Chat в списке 'Allowed'
    Ожидаемо: Модальное окно формы отчёта о баге открывается поверх опроса с предзаполненным описанием, включающим выбранный симптом и длительность звонка (например: 'Меня не слышали\\n\\n(call feedback: not_heard_by_peer, duration 42s)'). Пользователь может редактировать описание, прикреплять скриншоты или отправить отчёт. В браузер Console видны логи инициализации [BugReport]. BugReportModal виден в Vue devtools как прямой потомок App.vue.
    Лог: Никакие специфичные логи logcat не требуются для этого фикса (компонент чисто frontend). Вместо этого используйте браузер DevTools (F12) → Console и ищите логи с префиксом [BugReport]. Для контекста аудиозвонка (если нужно убедиться, что звонок был активен): adb shell dumpsys audio | grep -i mode должен показать audio mode MODE_IN_CALL или MODE_NORMAL в момент завершения звонка (но это не связано с этим конкретным фиксом).
    adb: adb -s emulator-5554 install android/app/build/outputs/apk/sideload/debug/app-sideload-debug.apk — установить debug APK на эмулятор
    adb: adb shell dumpsys audio | grep -i mode — проверить audio mode (контекст, не специфично для этого фикса)
    adb: Chrome DevTools on localhost:8080 (если запущен локальный dev сервер) или встроенный браузер эмулятора: F12 для Console и Vue devtools
  - Если не исправлен, приложить: Скриншот опроса в момент нажатия на 👎 на старой сборке (cabe7505); Скриншот экрана после нажатия на симптом на старой сборке (доказывает, что опрос закрывается, но форма не видна); Скриншот модальной формы на новой сборке (fef8f5d4) с видимым предзаполненным текстом; Экспорт браузер Console (F12) из браузера эмулятора, содержащий [BugReport] логи при открытии формы; Снимок дерева Vue devtools в момент нажатия на симптом (для обеих сборок) — подтверждение что BugReportModal не в DOM на старой, и присутствует на новой
  - Автотесты: src/features/video-calls/ui/__tests__/CallFeedbackPrompt.test.ts — существует тест, но useBugReport() мокируется, поэтому видимость BugReportModal в DOM не проверяется; Нет Maestro E2E сценария для полного потока опроса → отчёта. Существующие flows (04-call-place.yaml, 05-call-answer.yaml) завершают тест после установления соединения, до появления опроса обратной связи; Пробел в покрытии: чтобы автоматизировать полный сценарий, требуется расширить Maestro flow или создать новый, но это выходит за рамки фикса F20
  - Запись в `docs/manual-verification.md`: «### Выбор симптома в опросе после звонка открывает форму отчёта - Коммит: `fef8f5d4` - Баг содержался в: `cabe7505` (последний коммит ДО фикса, где BugReportModal только в SettingsPanel.vue) - Почему нужна ручная проверка: юнит-тесты мокируют useBugReport(), поэтому не проверяют, видна ли модаль в DOM. Для полной проверки нужна реальная инициация: завершить звонок, выбрать симптом в опросе и убедиться, что форма отчёта отрендерилась с предзаполненным контекстом. - На чём: Pixel API-35 эмулятор (оба доступны на bench) или реальный Pixel/Samsung. - Шаги (базовое воспроизведение, ~5 минут): 1. git checkout cabe7505 && npm run build && adb -s emulator-5554 install android/app/build/outputs/apk/sideload/debug/app-sideload-debug.apk 2. Запустить приложение, залогиниться (TEST1). 3. Позвонить на TEST2 (на другом эмуляторе или веб-клиенте). 4. Дождаться соединения (кнопка mute видна). 5. Завершить звонок кнопкой (красная область). 6. Дождаться опроса «Как прошёл звонок?» → нажать 👎 (плохо). 7. Нажать симптом (например, «Меня не слышали»). 8. **На cabe7505 (старая сборка):** опрос закрывается, форма НЕ появляется. В браузер Console (F12) нет логов [BugReport]. 9. git checkout fef8f5d4 && npm run build && adb -s emulator-5554 install android/app/build/outputs/apk/sideload/debug/app-sideload-debug.apk 10. Повторить шаги 2–7. 11. **На fef8f5d4 (новая сборка):** модальное окно открывается с текстом вида «Меня не слышали\\n\\n(call feedback: not_heard_by_peer, duration Ns)». В браузер Console видны логи [BugReport]. - Статус: ☐ не проверено»
  - Релиз dbf8c20 (тест 1.13.9), 2026-10-08: ☑ «Были проблемы» → «Другое» открыли форму отчёта с текстом «Другое (call feedback: other, duration 164s)»; отчёт ушёл (forta-bugs#1441). Длительность 164 с неверна, звонок длился около 37 с — открытое наблюдение в итоге прогона.


- [ ] **F21. Опрос после звонка: показывается после неудачного/короткого звонка, не чаще раза в день, никогда после пропущенного**
  - Коммиты: `0206db61` · Кластер: callFeedback
  - Где: Samsung и Pixel · Можно ли: можно проверить · Нужно: TEST1 и TEST2 в .env; adb на хосте; локально собранный baseline и HEAD APK
  - Ограничения: Баг появился в коммите 0206db61, который существует только в этой ветке. На origin/master не воспроизводится (механизм post-call prompt добавлен позже, в той же ветке). Старая сборка для воспроизведения = 0206db61^ (коммит перед добавлением prompt).
  - Симптом: Пользователи сообщают о проблемах со звуком спустя минуты или часы после звонка, когда AudioRouter уже разобран и диагностика описывает холостой аппарат. Нужно попросить оценку звонка сразу после завершения, пока аудиотайм-лайн ещё в буфере HAL.
  - Причина: На baseline (origin/master) файл src/features/video-calls/ui/CallFeedbackHost.vue не существует (git show origin/master:src/features/video-calls/ui/CallFeedbackHost.vue → fatal: path does not exist). На HEAD (0206db61) добавлены: CallFeedbackHost.vue (55 строк, импортирован в App.vue), CallFeedbackPrompt.vue (92 строки), call-feedback.ts (99 строк, логика shouldPromptForFeedback), тесты.
  - Воспроизвести на старой сборке:
    1. Установить baseline APK (commit 0206db61^, БЕЗ фикса): adb install -r app-debug.apk
    2. Совершить видеозвонок (TEST1 → TEST2), дождаться соединения
    3. Завершить звонок нажатием красной кнопки
    4. Проверить logcat: adb logcat -s post-call-prompt | grep -i 'state' — должны быть переходы
    5. Убедиться, что приложение запросило отзыв (prompt должна появиться)
    6. Закрыть prompt нажатием 'Нет'
    Признак бага: На старой сборке после завершения звонка экран полностью закрывается без каких-либо модальных окон или опросов. Это подтверждает отсутствие фичи (файлы не существуют в baseline).
  - Проверить на новой сборке:
    1. Установить HEAD APK (commit 0206db61, с фиксом): adb install -r app-debug.apk
    2. Совершить видеозвонок, дождаться соединения, завершить звонок
    3. На экране появится prompt с вопросом об оценке звонка
    4. Нажать кнопку оценки (звёзды или шкала) и убедиться, что они кликабельны
    5. Отправить отзыв и убедиться, что prompt закрылась
    6. Проверить, что приложение остаётся в фоне (не краш/ANR)
    7. Позвонить снова и завершить — prompt должна появиться снова
    8. Проверить logcat для успешной отправки отзыва на сервер
    Ожидаемо: Сценарий 1: внизу экрана модаль с кнопками 👍 и 👎. На нажатие 👎 разворачивается в список проблем (6 вариантов из ru.ts). Выбор открывает форму отчёта с контекстом '(call feedback: <symptom>, duration 0-5s)'. Сценарий 2: опрос появляется повторно (duration < 10s обходит cooldown). Форма отчёта показывает 'duration 4-6s' из-за вариаций эмулятора, но это нормально. Сценарий 3: первый опрос появляется, история сохраняется. Второй опрос НЕ появляется (cooldown 86400000ms активен). localStorage ключ 'forta-chat:call_feedback_last_prompt' содержит число. Сценарий 4 и 5: история содержит запись со статусом missed/declined, но опроса на экране нет.
    Лог: Нет Log.* оператoров в features/video-calls/call-feedback коде. adb logcat grep для 'feedback' ничего не вернёт. Для диагностики используйте браузер DevTools (web) или Maestro console (эмулятор).
    adb: Web test (Chrome DevTools): chrome://inspect → выбрать приложение → DevTools → Console → localStorage.getItem('forta-chat:call_feedback_last_prompt') → должно содержать число (timestamp) или быть пусто перед первым опросом
    adb: Android эмулятор (Maestro): встроенная консоль Maestro для доступа к localStorage (НЕ используйте 'adb shell run-as', он не работает с SQLite WebView)
    adb: Real device (USB): подключить adb devices, убедиться что 'remote debugging' включён в Chrome (Settings → About → Build number 7x → Developer options). Затем chrome://inspect как выше
    adb: НЕ ИСПОЛЬЗОВАТЬ 'adb shell run-as com.forta.chat' для доступа к localStorage: Capacitor хранит WebView данные в SQLite (path: data/data/com.forta.chat/app_webview/Default/Local\ Storage/leveldb/), не в текстовых файлах
  - Если не исправлен, приложить: DevTools Console: localStorage.getItem('forta-chat:call_feedback_last_prompt') показывает последний timestamp опроса; DevTools Elements: ищем элементы с data-testid='call-feedback-*' или classes содержащие 'feedback'; Vue DevTools → Pinia → callStore: проверить history[0] содержит { status, duration, startedAt } для последнего вызова; Vue DevTools → компоненты: убедиться что CallFeedbackHost и CallFeedbackPrompt отрисовываются (visible=true); DOM инспекция: <CallFeedbackHost /> должен быть в App.vue и рендериться; История вызовов: в чате должна быть видима информация о последних 3-4 вызовах со статусами (call, missed, declined)
  - Автотесты: src/features/video-calls/model/call-feedback.test.ts (129 строк): shouldPromptForFeedback проходит все 6 путей решения (failed, short < 10s, cooldown blocked, first time, missed ignore, declined ignore); src/features/video-calls/ui/__tests__/CallFeedbackPrompt.test.ts (65 строк): клик по 👍, клик по 👎, выбор симптома открывает отчёт с контекстом, пропуск опроса; e2e/maestro/flows/05-call-answer.yaml (может быть расширен): добавить end-call tap + waitUntil для элемента with data-testid='call-feedback-prompt' перед finish, чтобы автоматизировать проверку сценариев 1-2
  - Запись в `docs/manual-verification.md`: «**F21: Опрос после звонка**\n\nЭтап 3 интеграции (фича завершена, полная верификация):\n\n**Старая сборка:** нет файла CallFeedbackHost.vue, после звонка экран закрывается, опроса нет.\n\n**Новая сборка:** CallFeedbackHost.vue (55 строк) в App.vue, CallFeedbackPrompt.vue (92 строки), call-feedback.ts (99 строк).\n\n**Верификация на Samsung и Pixel (реальные устройства):**\n1. Неудачный звонок → опрос появляется сразу\n2. Короткий звонок (5 сек) → опрос появляется (обходит cooldown)\n3. Обычный звонок (30+ сек) → опрос, потом cooldown 24ч\n4. Пропущенный → история, но опроса нет\n5. Отклонённый → история, но опроса нет\n\n**Верификация на эмуляторах (Maestro + DevTools):**\n1. Maestro: tapOn кнопок 👍 / 👎, проверить открытие списка проблем\n2. DevTools: Console → localStorage.getItem('forta-chat:call_feedback_last_prompt') содержит timestamp\n3. Vue DevTools → Pinia → callStore.history содержит { status, duration, startedAt }\n\n**i18n и конфиг:**\n- ✓ ru.ts: все 6 callFeedback ключей (peer_not_heard, not_heard_by_peer, audio_dropped, echo, never_connected, other)\n- ✓ App.vue: CallFeedbackHost импортирован и рендерится\n- ✓ APP_NAME = 'forta-chat' в src/shared/config/constants.ts\n\n**Известные ограничения:**\n- Maestro flow 05-call-answer.yaml не заканчивает звонок, требует расширения для полной автоматизации\n- Duration на эмуляторе может быть ±1-2 сек из-за нагрузки системы (Math.round())\n- adb logcat не содержит Log.* для feedback (используйте DevTools вместо этого)»


- [ ] **F22. Таймлайн аудио-стека попадает в отчёт о проблеме**
  - Коммиты: `e8b1954c` · Кластер: диагностика-аудио
  - Где: Pixel · Можно ли: можно проверить · Нужно: TEST1/TEST2 в .env; реальный аппарат или эмулятор; adb
  - Ограничения: Локально собранная debug APK не содержит google-services.json, поэтому не может отправить отчёт в GitHub. Для воспроизведения баг-репорта с таймлайном требуется CI «Android Test APK» (release-подписанная сборка) или ручная компиляция с подключением bug-report-sender.ts на localhost. На телефоне без интернета локальная форма диагностики всё равно заполнится, но отправка не произойдёт.
  - Симптом: Отчёты о проблемах содержали только снимок состояния аудиорежима в момент заполнения формы, что не позволяло различить два сценария: аппарат, который никогда не перешёл в режим MODE_IN_COMMUNICATION, и аппарат, который вернулся в MODE_RINGTONE после завершения звонка. Эти сценарии требуют противоположных исправлений, но выглядят идентично в статическом снимке.
  - Причина: AudioRouter не записывал последовательность аудио-событий (запуск, смена режима, переприменение режима на OEM, смена маршрута, освобождение микрофона, срабатывание watchdog, завершение). Была только финальная точка состояния. android/app/src/main/java/com/forta/chat/plugins/calls/AudioRouter.kt:35 (baseline) — отсутствовало поле timeline, отсутствовали вызовы timeline.record().
  - Воспроизвести на старой сборке:
    1. Установить baseline APK (без фикса)
    2. Дождаться входящего звонка на TEST1 (позвонить с TEST2)
    3. На экране входящего нажать красную кнопку 'Отклонить'
    4. Проверить логику завершения: adb logcat -s CallConnection | grep -i 'decline'
    5. Убедиться, что Telecom правильно обработал отклонение
    Признак бага: В созданном issue на GitHub (или в стандартном формате отчёта) в блоке диагностики будут поля 'Audio mode: MODE_IN_COMMUNICATION', 'Speaker on', 'BT SCO on', но секция 'Audio timeline' отсутствует полностью. Если секция `<details><summary>Audio timeline</summary>` есть — это уже новая сборка.
  - Проверить на новой сборке:
    1. Установить HEAD APK: adb install -r app-debug.apk
    2. Дождаться входящего звонка, нажать 'Отклонить'
    3. Приложение НЕ должно краш/ANR; вернулось к основному UI
    4. Проверить логи: adb logcat -s CallConnection | grep -i 'rejected'
    5. adb shell dumpsys audio | grep -i mode — MODE_NORMAL
    6. Позвонить снова — входящий звонок работает
    Ожидаемо: В отчёте появляется свёрнутая таблица 'Audio timeline' с последовательностью событий аудио-стека, начиная с 'start' и заканчивая 'stop'. Таблица заполнена вовремя, события идут в хронологическом порядке с возрастающими временными метками. Наличие события 'mode' с 'MODE_IN_COMMUNICATION' доказывает, что аудиорежим был установлен. Отсутствие 'force_stop' или 'watchdog' означает, что завершение прошло нормально. Временная шкала остаётся в памяти AudioRouter от start() до stop(), затем очищается на следующем start().
    Лог: adb logcat -s AudioLifecycle | grep -iE 'start|mode|stop' — покажет Log.d/Log.w с LIFECYCLE_TAG (определено в AudioRouter.kt:40), вокруг которых выполняются timeline.record() вызовы. Сам timeline.record() логов не выпускает, только заполняет кольцевой буфер в памяти. Дополнительно: adb logcat | grep -E 'AudioLifecycle.*start.*MODE_IN_COMMUNICATION' найдёт точное место установки режима.
    adb: adb shell dumpsys audio | grep -i mode — финальный аудиорежим должен быть MODE_NORMAL или MODE_RINGTONE (не MODE_IN_COMMUNICATION), доказывая, что stop()/forceStop() восстановили нормальный режим.
    adb: adb shell dumpsys audio | grep -iE 'bluetooth|sco' — если звонок был с BT, то BT SCO должен быть отключён (SCO_AUDIO_STATE_DISCONNECTED или отсутствовать в выводе).
  - Если не исправлен, приложить: Снимок logcat: adb logcat -s AudioRouter > /tmp/audio.log — весь лог AudioRouter за время звонка и после завершения.; Дамп аудио-сервиса: adb shell dumpsys audio > /tmp/audio-dumpsys.txt — состояние аудио-стека сразу после завершения.; Дата/время на аппарате: adb shell date — синхронизация для сопоставления логов.; Проверить, был ли вообще вызван getAudioTimeline(): добавить временный Log.d в CallPlugin.getAudioTimeline() и проверить logcat.; Скриншот созданного issue — убедиться, что блок диагностики вообще передался.; История версий на аппарате: adb shell dumpsys package com.forta.chat | grep versionName — какая версия приложения установлена.
  - Автотесты: android/app/src/test/java/com/forta/chat/plugins/calls/CallAudioTimelineTest.kt — 6 юнит-тестов проверяют кольцевой буфер timeline (порядок, вытеснение старых, thread-safety).; src/shared/lib/bug-report/__tests__/collect-call-diagnostics.test.ts — два теста: один проверяет, что audioTimeline собирается на Android; второй проверяет graceful failure если plugin недоступен.; scripts/triage-call-reports.test.ts — парсинг таблицы и функция timelineShowsAudioNeverEngaged() со случаями 'never engaged' и 'forced stop'.
  - Запись в `docs/manual-verification.md`: «Таймлайн аудио доезжает в реальном отчёте о баге»


- [ ] **F23. Переключатель движка WebRTC (нативный / WebView) в настройках**
  - Коммиты: `d0261dc2` · Кластер: call-engine-diagnostics
  - Где: Samsung и Pixel · Можно ли: можно проверить · Нужно: TEST1/TEST2 в .env; web-клиент для входящего; adb на хосте
  - Ограничения: Механизм выбора engine (WebView vs native) существует только в этой ветке (добавлен на d0261dc2). На origin/master нет переключателя режима в Settings.
  - Симптом: На Android нативный движок WebRTC был всегда включён без возможности отключения. Пользователи со сломанным звуком не могли протестировать, в какой части стека лежит баг — в медиа-пути или в окружающей аудио-маршрутизации. Переключателя в настройках не было.
  - Причина: baseline (origin/master:src/features/video-calls/model/call-service.ts:93): условие было просто `if (isAndroid)` без проверки предпочтений. HEAD (d0261dc2:src/features/video-calls/model/call-service.ts:100): добавлена проверка `isNativeWebRTCEngineEnabled()`, которая читает состояние из localStorage (ключ: forta:call_webrtc_engine), устанавливаемого UI-переключателем в src/features/user-management/ui/CallProvidersSection.vue.
  - Воспроизвести на старой сборке:
    1. Убедиться в сборке от d0261dc2: git log --oneline | head -1
    2. На эмуляторе установить APK, войти под TEST1
    3. Совершить звонок на TEST2, дождаться соединения
    4. Открыть Settings → Call Engine → переключить режим (если в mode был native)
    Признак бага: В Settings → Способы звонков нет видимого раздела или переключателя для выбора нативный / WebView режим. Все звонки идут только через нативный WebRTC движок, без возможности переключиться на WebView для тестирования.
  - Проверить на новой сборке:
    1. Установить новый APK: adb install -r app-debug.apk
    2. Позвонить на TEST2, дождаться соединения (двусторонний звук)
    3. Открыть Settings → Call Engine, переключить 'Встроенный движок звонков' (native ON↔OFF)
    4. На экране должно появиться сообщение о переключении или нотификация
    5. Завершить звонок, убедиться что звук работал весь цикл
    6. Позвонить снова с новым режимом — звонок должен соединиться в течение 5 сек
    7. Проверить logcat: adb logcat -s engine-selection | grep -i 'switched' — видно переключение режима
    Ожидаемо: Переключатель 'Движок звонков' видна в Settings. Переключение между режимами (native/webview) требует перезапуска. При переключении на webview: двусторонний звук работает, logcat по NativeWebRTCManager молчит, отчёт содержит 'WebRTC engine: webview'. При переключении на native: двусторонний звук работает, logcat показывает инициализацию NativeWebRTCManager, отчёт содержит 'WebRTC engine: native'. Аудиорежим (MODE_IN_COMMUNICATION) одинаков в обоих режимах.
    Лог: NativeWebRTCManager — при запуске в webview-режиме должен быть ПУСТ за 30 секунд разговора (нет инициализации, прокси не установлен); при запуске в native-режиме ДОЛЖНЫ быть логи 'Initialized with HW acceleration' или 'ICE connection state:' в первые 5 секунд запуска звонка
    adb: adb logcat -s NativeWebRTCManager — при режиме webview ДОЛЖЕН быть пуст за 30 секунд разговора (отсутствие логов = прокси не установлен)
    adb: adb logcat -s NativeWebRTCManager — при режиме native ДОЛЖНЫ быть логи инициализации в первые 5 сек звонка (присутствие = прокси работает)
    adb: adb shell dumpsys audio | grep -i mode — проверить наличие MODE_IN_COMMUNICATION при активном звонке в ОБОИХ режимах (должно совпадать, независимо от выбранного WebRTC движка)
  - Если не исправлен, приложить: logcat от включения переключателя webview до перезапуска и начала звонка (ищем ошибки установки прокси); Снимок экрана Settings → Способы звонков (доказывает видимость переключателя); Bug-report JSON с полями webRTC engine и audioMode (доказывает запись состояния); Видеозапись или скриншоты двустороннего звонка в обоих режимах (webview и native)
  - Автотесты: src/shared/lib/native-webrtc/webrtc-engine-preference.test.ts — 8 тестов: дефолт native, round-trip webview, fallback на native при повреждённом JSON, при недоступности storage; src/features/video-calls/model/call-service-platform-gate.test.ts — 2 теста: 'does NOT install the proxy on Android when the engine is set to webview' и 'installs the proxy on Android when the stored engine is unreadable (fallback to native)'; src/features/video-calls/model/call-service.test.ts — моки обновлены для экспорта isNativeWebRTCEngineEnabled; src/features/video-calls/ui/call-controls-speaker.test.ts — моки обновлены
  - Запись в `docs/manual-verification.md`: «Переключатель движка WebRTC меняет поведение звонков. Видна в Settings только на Android. Требует перезапуска для вступления в силу. При WebView-режиме NativeWebRTCManager не инициализируется (logcat молчит). При native-режиме инициализируется и видна в logcat. Состояние сохраняется в localStorage и отражается в bug-отчётах.»


## Список 2. Открыто и актуально

Счётчик = отчёты в выгрузке от 2026-09-07 (91 звонковый). «Стенд» — можно ли проверить на Samsung/Pixel сейчас. Для каждого открытого бага на странице есть отметка «воспроизводится у меня»: это данные для плана.


- [ ] **O01. Телефон застревает в режиме звонка после его окончания** · кластер: stuck-after-call · отчётов: 37 · примеры: [#1337](https://github.com/greenShirtMystery/forta-bugs/issues/1337), [#1238](https://github.com/greenShirtMystery/forta-bugs/issues/1238), [#1204](https://github.com/greenShirtMystery/forta-bugs/issues/1204), [#1286](https://github.com/greenShirtMystery/forta-bugs/issues/1286), [#1327](https://github.com/greenShirtMystery/forta-bugs/issues/1327), [#1328](https://github.com/greenShirtMystery/forta-bugs/issues/1328)
  - Факты: 29 из 88 отчётов с диагностикой сняты в режиме, который ставит приложение: 22 в MODE_RINGTONE, 7 в MODE_IN_COMMUNICATION, 13 вендоров, включая Samsung SM-A075F (#1238) и OnePlus от сегодняшнего дня (#1337).
  - Причина: Аудиорежим принадлежит трём слоям (NativeWebRTCManager ставит, AudioRouter переприменяет, foreground-сервис сбрасывает), и любой нестандартный выход из звонка обходит сброс. F01–F06 закрывают известные пути; остаются SIGKILL/Doze без onDestroy (вотчдог срабатывает только на возврате в приложение) и путь FCM-ринга.
  - Статус после ветки: Частично закрыт F01–F06 (00ddc636); единый владелец завершения и cold-start sweep — F25. Финальный ответ даст только серия на реальных аппаратах.
  - Стенд: Samsung и Pixel · нужно: обе сборки; для FCM-ринга CI-сборка
  - Как проверить на стенде:
    1. После каждого сценария из F01–F07 и после обычного завершения выждать 30 с и снять `adb shell dumpsys audio | grep -i mode`.
    2. Серия из 10 звонков подряд Samsung↔Pixel с чередованием: положил я / положил собеседник / не ответил 45 с / отклонил.
    3. Любой `MODE_RINGTONE` или `MODE_IN_COMMUNICATION` без идущего звонка — регресс; приложить таймлайн через отчёт из приложения и логкат.

- [ ] **O02. Нет звука или односторонний звук на устройствах ВНЕ списка сломанного AEC** · кластер: no-audio · отчётов: 17 · примеры: [#1202](https://github.com/greenShirtMystery/forta-bugs/issues/1202), [#1204](https://github.com/greenShirtMystery/forta-bugs/issues/1204), [#1205](https://github.com/greenShirtMystery/forta-bugs/issues/1205), [#1318](https://github.com/greenShirtMystery/forta-bugs/issues/1318), [#1292](https://github.com/greenShirtMystery/forta-bugs/issues/1292), [#1152](https://github.com/greenShirtMystery/forta-bugs/issues/1152), [#1226](https://github.com/greenShirtMystery/forta-bugs/issues/1226)
  - Факты: 17 из 43 отчётов «нет звука» пришли с вендоров вне списка: Samsung 5 (три подряд с SM-A107F: #1202, #1204, #1205; #1318 SM-G965F; #1292 SM-S918B), OnePlus 3. У 14 из 43 устройство в момент отчёта сидело в застрявшем режиме.
  - Причина: Три гипотезы, различимые на стенде: (а) следующий звонок стартует в режиме, оставшемся от предыдущего (закрывается O01); (б) нет TURN, и медиа проходит только в одну сторону (O05); (в) рантайм-проба AEC ложно помечает здоровый аппарат (F17).
  - Статус после ветки: Не закрыт. F01/F03/F06 и F17 бьют по гипотезам (а) и (в); (б) требует проверки сервера.
  - Стенд: Samsung · нужно: Samsung + Pixel, Wi-Fi и сотовая
  - Как проверить на стенде:
    1. Samsung на сотовой сети, Pixel на Wi-Fi: 5 звонков подряд в обе стороны, в каждом сказать фразу и дождаться ответа.
    2. Повторить с Samsung на Wi-Fi. Односторонний звук только на сотовой = гипотеза (б), нет TURN.
    3. Перед каждым звонком снять режим аудио; если звонок начался не из MODE_NORMAL и звука нет = гипотеза (а).
    4. `adb logcat -s AudioRouter` при старте звонка: решение по микрофону и AEC; на Samsung принудительное включение микрофона не должно применяться.

- [ ] **O03. Нет звука на вендорах из списка сломанного AEC (Xiaomi, Huawei, Honor, Infinix, Tecno, Realme)** · кластер: no-audio · отчётов: 26 · примеры: [#1327](https://github.com/greenShirtMystery/forta-bugs/issues/1327), [#1323](https://github.com/greenShirtMystery/forta-bugs/issues/1323), [#1308](https://github.com/greenShirtMystery/forta-bugs/issues/1308), [#1160](https://github.com/greenShirtMystery/forta-bugs/issues/1160), [#1229](https://github.com/greenShirtMystery/forta-bugs/issues/1229)
  - Факты: 26 из 43 отчётов «нет звука» с вендоров из BROKEN_HW_AEC_VENDORS. Список расширяли четыре раза (#31, #34, WEE-56, 60, 76, 87, 103).
  - Причина: Сломанный аппаратный эхоподавитель, залипающий глобальный mute микрофона, асинхронный сброс режима через 1–5 с в прошивке. На образах Google этого кода нет.
  - Статус после ветки: Не проверяемо на вашем стенде: нужен бюджетный Xiaomi (Redmi Note) или Infinix. Пока закрывается только через отчёты пользователей с таймлайном (F22).
  - Стенд: нет на стенде · нужно: OEM-аппарат из списка
  - Как проверить на стенде:
    1. Нет на стенде. Косвенно: на Samsung и Pixel убедиться, что после F17 проба не сломала здоровые аппараты.

- [ ] **O04. Рингтон продолжает играть после ответа, звонок сбрасывается через 30 с** · кластер: accept-button / no-ringtone · отчётов: 4 · примеры: [#1227](https://github.com/greenShirtMystery/forta-bugs/issues/1227), [#1108](https://github.com/greenShirtMystery/forta-bugs/issues/1108), [#890](https://github.com/greenShirtMystery/forta-bugs/issues/890), [#1204](https://github.com/greenShirtMystery/forta-bugs/issues/1204)
  - Факты: #1227 OnePlus: «соединение произошло, а мелодия ещё играет», устройство в MODE_RINGTONE. #1108 Honor и #890 realme сняты в MODE_RINGTONE. Гипотеза из docs/call-bugs-needing-you.md: рингтон переживает ответ, а 30-секундный авто-сброс экрана входящего кладёт трубку.
  - Причина: Экран входящего (IncomingCallActivity) и Telecom-соединение живут отдельно; при ответе из одного места второе не всегда узнаёт об этом.
  - Статус после ветки: Не закрыт. F03 подбирает застрявший MODE_RINGTONE при возврате, но не мешает авто-сбросу. Владелец ринга по callId, флаги и roomId у интентов шторки, гашение push при ответе — F26.
  - Стенд: Samsung и Pixel · нужно: обе сборки; шторка и заблокированный экран лучше на CI-сборке
  - Как проверить на стенде:
    1. Позвонить на Pixel, ответить с экрана входящего, слушать 40 с: рингтон обязан замолчать сразу, звонок не должен оборваться на 30-й секунде.
    2. То же с ответом из шторки уведомления и с заблокированного экрана (CI-сборка).
    3. То же, когда звонок пришёл при свёрнутом приложении.
    4. Если оборвался: `adb logcat -s IncomingCallActivity CallConnectionService` за минуту до обрыва.

- [ ] **O05. TURN не подтверждён: возможно, звонки идут только по прямым кандидатам** · кластер: connect-fail / no-audio · отчётов: 8 · примеры: [#1210](https://github.com/greenShirtMystery/forta-bugs/issues/1210), [#1144](https://github.com/greenShirtMystery/forta-bugs/issues/1144), [#1056](https://github.com/greenShirtMystery/forta-bugs/issues/1056), [#1057](https://github.com/greenShirtMystery/forta-bugs/issues/1057)
  - Факты: Собственный блок iceServers в matrix-client.ts закомментирован, SDK берёт только ответ homeserver `/turnServer`, а прокси подкладывает Google STUN, если список пуст. Что возвращает сервер, не проверено. Симптом «звонок проходит, а связи нет» (#1210) и односторонний звук типичны для отсутствия relay.
  - Причина: Без TURN звонок между двумя аппаратами за симметричным NAT или CGNAT сотового оператора не соединяется либо проходит в одну сторону.
  - Статус после ветки: Не закрыт, требует проверки на сервере. Дешевле всего из всего списка. Клиентская сторона (relay/host/srflx, TURN в конфигурации PC, тост «нет relay», строки в отчёте) — F30; сервер — по-прежнему открыт.
  - Стенд: Samsung и Pixel · нужно: Samsung на сотовой, Pixel на Wi-Fi; доступ к homeserver
  - Как проверить на стенде:
    1. Samsung только на сотовой (Wi-Fi выключен), Pixel на домашнем Wi-Fi: звонок в обе стороны. Не соединился или односторонний = нет relay.
    2. Повторить, когда оба в одном Wi-Fi: если тут работает, а на сотовой нет, диагноз подтверждён.
    3. На сервере: `curl -H 'Authorization: Bearer <токен>' https://<homeserver>/_matrix/client/v3/voip/turnServer` обязан вернуть uris с `turn:` и `turns:…:443?transport=tcp`.
    4. На Pixel с движком WebView: `chrome://webrtc-internals` покажет, есть ли relay-кандидаты.

- [ ] **O06. Второй входящий во время разговора: «занято» без ожидания вызова, слот не привязан к callId** · кластер: call-lifecycle · отчётов: 0
  - Факты: Найдено в коде: CallConnectionService держит одно соединение, все читатели берут его без проверки callId. После e3079e09 второй звонящий получает BUSY, разговор не рвётся.
  - Причина: Нужно продуктовое решение: ждущий вызов, «занято» или ничего. Техническая часть: соединения по callId вместо слота.
  - Статус после ветки: Частично: BUSY сделан (F10). Ожидание вызова не реализовано. Исходящий callId и читатели слота по id — F32; call waiting вместо BUSY — продуктовое решение.
  - Стенд: Samsung и Pixel · нужно: третья сторона: веб-клиент или эмулятор
  - Как проверить на стенде:
    1. Разговор Samsung↔Pixel, третий (веб) звонит на Samsung: разговор обязан продолжиться, третьему «занято». Это F10.
    2. Решить, что должен видеть человек. Пока не решено, дальше чинить нечего.

- [ ] **O07. Дубль звонка, когда рядом установлен Bastyon** · кластер: duplicate-ring · отчётов: 5 · примеры: [#1112](https://github.com/greenShirtMystery/forta-bugs/issues/1112), [#847](https://github.com/greenShirtMystery/forta-bugs/issues/847), [#809](https://github.com/greenShirtMystery/forta-bugs/issues/809), [#760](https://github.com/greenShirtMystery/forta-bugs/issues/760), [#1091](https://github.com/greenShirtMystery/forta-bugs/issues/1091)
  - Факты: 5 отчётов: оба приложения авторизованы одним аккаунтом, звонок приходит дважды или не проходит.
  - Причина: Два приложения принимают один и тот же m.call.invite; дедупликация внутри Forta ничего не знает о втором приложении.
  - Статус после ветки: Не закрыт. Нужен APK Bastyon рядом и решение с командой Bastyon: какое приложение отвечает на звонки.
  - Стенд: Samsung и Pixel · нужно: установить Bastyon из Play/сайта на тот же аппарат, войти тем же аккаунтом
  - Как проверить на стенде:
    1. Поставить Bastyon на Samsung, войти тем же аккаунтом, что в Forta. Позвонить с Pixel: сколько раз звонит, что происходит при ответе в одном из приложений.

- [ ] **O08. Громкая связь не переключается** · кластер: speaker-toggle · отчётов: 10 · примеры: [#1334](https://github.com/greenShirtMystery/forta-bugs/issues/1334), [#1328](https://github.com/greenShirtMystery/forta-bugs/issues/1328), [#1223](https://github.com/greenShirtMystery/forta-bugs/issues/1223), [#1164](https://github.com/greenShirtMystery/forta-bugs/issues/1164), [#909](https://github.com/greenShirtMystery/forta-bugs/issues/909), [#890](https://github.com/greenShirtMystery/forta-bugs/issues/890)
  - Факты: 10 отчётов; 4 из них в застрявшем режиме на момент отчёта. OnePlus #1334 от сегодняшнего дня, WebView 152.
  - Причина: На части прошивок оба API переключения динамика игнорируются (legacy-fallback WEE-76 уже есть); часть случаев — следствие застрявшего режима (O01).
  - Статус после ветки: Частично. Проверить, что на Samsung и Pixel работает; OnePlus/Infinix на стенде нет. Отказ вместо молчания и пин ручного выбора — F29.
  - Стенд: Samsung и Pixel
  - Как проверить на стенде:
    1. В звонке нажать динамик, выключить, снова включить; проверить с подключёнными Bluetooth-наушниками и без.
    2. `adb logcat -s AudioRouter` при каждом нажатии: строка о смене маршрута.
    3. Повторить на движке WebView (F23).

- [ ] **O09. Кнопка «Принять» сбрасывает звонок: из шторки или при спящем процессе** · кластер: accept-button · отчётов: 6 · примеры: [#1268](https://github.com/greenShirtMystery/forta-bugs/issues/1268), [#1108](https://github.com/greenShirtMystery/forta-bugs/issues/1108), [#1068](https://github.com/greenShirtMystery/forta-bugs/issues/1068), [#1044](https://github.com/greenShirtMystery/forta-bugs/issues/1044)
  - Факты: 6 отчётов, ни одного Samsung. Двойной тап исключён E2E-флоу (01f0836f); #1183 закрыт F09. Остались приём из шторки и при выгруженном процессе.
  - Причина: Оба сценария живут в push-пути, который есть только в CI-сборке.
  - Статус после ветки: Не закрыт для шторки и спящего процесса. Живой процесс: F26 (шторка, merge intent, decline-guard, keyguard в onNewIntent). Спящий процесс и keyguard с PIN — проверка F26 п. 4 на CI-сборке.
  - Стенд: Pixel · нужно: CI-сборка
  - Как проверить на стенде:
    1. Смахнуть приложение из недавних, подождать минуту, позвонить с Samsung, принять из шторки уведомления, не открывая приложение.
    2. То же с заблокированным экраном и с экрана входящего.
    3. Если сброс: `adb logcat -s FortaPush CallPlugin CallConnectionService IncomingCallActivity` с момента прихода push.

- [ ] **O10. Входящий не доходит при закрытом приложении** · кластер: background-incoming · отчётов: 2 · примеры: [#1231](https://github.com/greenShirtMystery/forta-bugs/issues/1231), [#1113](https://github.com/greenShirtMystery/forta-bugs/issues/1113)
  - Факты: 2 отчёта; у 49 из 62 отчётов с диагностикой push-приглашения доходили, доставка в целом работает.
  - Причина: Push-путь: FCM → FortaFirebaseMessagingService → Telecom. На MIUI ещё и автозапуск.
  - Статус после ветки: Не проверен на реальном аппарате. Отозванный full-screen intent — баннер в настройках уведомлений и поле в отчёте, F31; Doze и автозапуск MIUI — стенд.
  - Стенд: Samsung и Pixel · нужно: CI-сборка
  - Как проверить на стенде:
    1. Убить приложение (свайп из недавних), выждать 2 минуты, позвонить. Экран входящего обязан подняться. Повторить через 30 минут покоя (Doze).

- [ ] **O11. Видеозвонок: односторонняя картинка, нет звука в видео** · кластер: video · отчётов: 11 · примеры: [#1222](https://github.com/greenShirtMystery/forta-bugs/issues/1222), [#1226](https://github.com/greenShirtMystery/forta-bugs/issues/1226), [#716](https://github.com/greenShirtMystery/forta-bugs/issues/716), [#936](https://github.com/greenShirtMystery/forta-bugs/issues/936)
  - Факты: 11 отчётов; #939 (зеркало) закрыт F16, #936 веб-версия. #1222 Xiaomi 12X↔14T: одна сторона видит, другая нет; #1226 OnePlus: в видео меня не слышно.
  - Причина: Смесь: кодеки/аппаратные энкодеры на OEM, тот же no-audio в видеорежиме, старый WebView.
  - Статус после ветки: Не закрыт, кроме F16. Одна камера на исходящий видеозвонок и одно правило прикрепления треков — F28.
  - Стенд: Samsung и Pixel
  - Как проверить на стенде:
    1. Видеозвонок Samsung↔Pixel в обе стороны: обе картинки, звук, переключение камеры, сворачивание в PiP, поворот экрана, 3 минуты разговора.
    2. Повторить на движке WebView.

- [ ] **O12. Эхо, слышно самого себя** · кластер: quality · отчётов: 3 · примеры: [#1066](https://github.com/greenShirtMystery/forta-bugs/issues/1066), [#1065](https://github.com/greenShirtMystery/forta-bugs/issues/1065), [#1062](https://github.com/greenShirtMystery/forta-bugs/issues/1062)
  - Факты: 3 отчёта, все Infinix.
  - Причина: Аппаратный AEC на OEM; после F17 такие устройства должны уходить на программное подавление.
  - Статус после ветки: Не проверяемо на стенде.
  - Стенд: нет на стенде · нужно: Infinix
  - Как проверить на стенде:
    1. Косвенно: на Samsung и Pixel с громкой связью эха быть не должно.

- [ ] **O13. Тихий звук, качелька громкости не управляет звонком** · кластер: quality / stuck-after-call · отчётов: 3 · примеры: [#1068](https://github.com/greenShirtMystery/forta-bugs/issues/1068), [#1022](https://github.com/greenShirtMystery/forta-bugs/issues/1022), [#1216](https://github.com/greenShirtMystery/forta-bugs/issues/1216)
  - Факты: #1216 Motorola: «при начале звонка захватывается индикатор громкости, потом…», #1068 Infinix: входящий тихий на полной громкости.
  - Причина: STREAM_VOICE_CALL привязан в CallActivity, но на экране входящего и в WebView-UI кнопки могут крутить медиа-поток.
  - Статус после ветки: Не закрыт. Качелька на экране входящего → STREAM_RING, F31; поток WebView-движка не менялся (сначала измерить).
  - Стенд: Samsung и Pixel
  - Как проверить на стенде:
    1. Во время ринга и во время разговора нажать качельку: какой ползунок появляется (звонок или медиа) и меняется ли громкость собеседника.

- [ ] **O14. Звонки при включённом Tor** · кластер: connect-fail · отчётов: 0
  - Факты: UDP через Tor не идёт; в коде нет TCP-only политики ICE для Tor.
  - Причина: Медиа не может пройти через SOCKS; нужен либо TURN по TCP/TLS, либо честное предупреждение.
  - Статус после ветки: Не закрыт, поведение не задокументировано. Предупреждение при наборе и ответе плюс строка `Tor during calls` в отчёте — F30; маршрут медиа через Tor — продуктовое решение.
  - Стенд: Samsung и Pixel
  - Как проверить на стенде:
    1. Включить Tor в настройках на Pixel, дождаться статуса «работает», позвонить на Samsung: зафиксировать, соединяется ли и есть ли звук.

- [ ] **O15. Кандидаты ICE до remoteDescription в SDK** · кластер: connect-fail · отчётов: 0
  - Факты: node_modules/matrix-js-sdk-bastyon/src/webrtc/call.ts: буферизованные кандидаты добавляются до setRemoteDescription, ошибки глотаются.
  - Причина: Медленное или неудачное соединение при плохой сети.
  - Статус после ветки: Не закрыт; правится только патчем форка SDK. Буфер кандидатов до remote description — F27.
  - Стенд: нет на стенде

- [ ] **O16. Другие поверхности: веб и iOS** · кластер: other · отчётов: 3 · примеры: [#936](https://github.com/greenShirtMystery/forta-bugs/issues/936), [#538](https://github.com/greenShirtMystery/forta-bugs/issues/538), [#1276](https://github.com/greenShirtMystery/forta-bugs/issues/1276)
  - Факты: #936 маленькое видео в веб-версии, #538 iOS нет в списке приложений для микрофона, #1276 iPhone 7 Plus не слышит собеседника.
  - Причина: Отдельные платформы.
  - Статус после ветки: Вне Android-ветки.
  - Стенд: нет на стенде

## Как вернуть результаты и что произойдёт дальше

1. Отмечайте статусы на странице (сохраняются сами) или ставьте `[x]` здесь. Для каждого «не исправлен» нужна заметка: модель, сборка (старая/новая, CI/локальная), что наблюдали.
2. Для «не исправлен» приложите то, что перечислено в пункте: обычно это `adb logcat` за минуту вокруг события, `dumpsys audio`, и отчёт из приложения с выбранным симптомом (в CI-сборке в него попадает таймлайн аудио).
3. Напишите мне «проверил». Я прочитаю статусы прямо со страницы, для каждого «не исправлен» разберу лог и таймлайн против кода, скажу, почему фикс не сработал (не тот путь, гонка, прошивка), и предложу правку с тестом. Открытые баги с отметкой «воспроизводится» уйдут в план первыми.


## План

### Что чинить и в каком порядке

| Шаг | Что | Закрывает | Усилия |
|---|---|---|---|
| 0 | **Прогнать этот чеклист.** Две сборки, оба телефона, обе сети. Отдельно: серия из 10 звонков подряд на Samsung с проверкой режима аудио после каждого. | Даёт факты по O01, O02, O04, O05 вместо гипотез | 1–2 дня |
| 1 | **TURN на сервере.** Проверить ответ `/turnServer`; поднять или починить coturn с `turns:…:443?transport=tcp`; включить relay-кандидаты в диагностику отчёта. | O05, часть O02 и O09 (звонок проходит, связи нет) | 1 день + доступ к серверу |
| 2 | **Рингтон и авто-сброс после ответа.** Один владелец ринга: ответ из любого места (экран, шторка, Telecom) гасит рингтон и отменяет 30-секундный таймер; тест на эмуляторе + Maestro-флоу. | O04, часть O01 (MODE_RINGTONE) и O09 | 2–3 дня |
| 3 | **Один владелец аудиорежима.** Сброс режима привязать к жизненному циклу Telecom Connection, а не к сервису; вотчдог на resume оставить как страховку; post-call gate в E2E (режим обязан вернуться в NORMAL). | Остаток O01, часть O02 и O08 | 1–2 недели |
| 4 | **Один экран входящего и слот по callId.** Слить нативный ринг и Vue-модалку в один путь; соединения по callId; продуктовое решение по второму входящему. | O06, часть O09, O10 | 1–2 недели |
| 5 | **Один WebRTC-движок на Android и разрез call-service.ts.** Оставить нативный движок, удалить переключатель после сбора статистики; разрезать сервис на state machine / медиа / мост / диагностику. | Снижает регрессии для всех кластеров | 2–3 недели |
| 6 | **Сосуществование с Bastyon.** Договориться с командой Bastyon, какое приложение отвечает; согласовать дедупликацию по callId между приложениями. | O07 | зависит от Bastyon |
| 7 | **OEM-устройство для аудио.** Купить бюджетный Xiaomi (Redmi Note) или Infinix: это единственный способ закрыть O03 и O12. | O03, O12, часть O08 | покупка + 1 неделя |

### Как автоматизировать цикл починки

| Шаг | Что | Есть сегодня | Усилия | Что даёт |
|---|---|---|---|---|
| 1 | **Maestro-флоу на реальных телефонах.** `scripts/e2e-call.sh` уже принимает серийники (`DEVICE_A`/`DEVICE_B`). Гонять существующие флоу звонка на Samsung↔Pixel перед каждым релизом. | скрипты и флоу есть | 0,5 дня | Сквозной звонок на реальном железе вместо синтетического аудио эмулятора |
| 2 | **Post-call gate.** Скрипт после каждого флоу: `dumpsys audio` = MODE_NORMAL, в `dumpsys telecom` нет живого Connection, микрофон не занят, в логкате нет `forced`/`stranded`. Красный прогон при нарушении. | таймлайн и логи есть, проверки нет | 1 день | Кластер «застрял после звонка» ловится до пользователей |
| 3 | **Флоу для рискованных путей.** Свайп из недавних во время звонка, 10 звонков подряд, ответ на 44-й секунде, второй входящий с третьей стороны (веб-клиент через Playwright), ответ из шторки (CI-сборка). | только базовый звонок и двойной тап | 2–3 дня | Именно эти пути дали цепочку регрессий в мае |
| 4 | **Ферма OEM-устройств.** Прогон тех же флоу на BrowserStack App Automate или AWS Device Farm с реальными Redmi/Samsung A: там есть логкат и dumpsys, нет только слуха. | нет | 2–3 дня + подписка | Единственный путь к Xiaomi/Infinix без покупки каждого аппарата |
| 5 | **Еженедельный триаж.** GitHub Action по расписанию: `scripts/triage-call-reports.mjs`, дельты кластеров по версиям приложения, доля отчётов в застрявшем режиме, доля «палец вниз» из опроса после звонка. Рост кластера после релиза = алерт. | классификатор есть, расписания нет | 0,5 дня | KPI по версиям вместо ощущения «стало хуже» |
| 6 | **Релизный гейт.** CI не даёт собрать релизный тег, пока в `docs/manual-verification.md` есть непроверенные записи по коммитам релиза и пока на странице чеклиста остались «не исправлен». | нет | 0,5 дня | Фикс без человека не уезжает к пользователям |
| 7 | **Сбор артефактов при провале.** `scripts/capture-call-failure.sh <ID>`: логкат за 3 минуты, dumpsys audio/telecom/notification, версия WebView и приложения, таймлайн через отчёт. Один архив вместо переписки. | нет | 0,5 дня | Диагноз без аппарата в руках |

Чего автоматизация не заменит: слух на конкретной OEM-прошивке. Всё остальное (режим аудио, занятый микрофон, живые соединения, экраны, сигналинг) читается через adb и проверяется без человека.

## Прогон релизной сборки dbf8c20 (тест 1.13.9), 2026-10-05

Цель: убедиться перед чисткой кода, что сентябрьские фиксы звонков не регрессировали в сборке, которая ушла
к пользователям. Релиз на 2026-10-05: ветка `fix/calls-2026-09` влита в upstream 2026-09-29 (PR #253,
`54ab0f14`, версия 1.13.4); forta.chat задеплоен с этим кодом; Google Play — 1.12.2 от 24 августа, GitHub
Releases — v1.11.1, то есть Android-релиза ещё нет. Ближайший релизный артефакт — тестовый APK
`https://forta.chat/apktests/latest.apk`: 1.13.9, versionCode 11309, коммит `dbf8c20` (2026-10-03, содержит
`54ab0f14`), подпись `CN=Forta Chat` (SHA-256 `354b1369…`). Все 84 коммита из «Проверено» в
`manual-verification.md` входят в `dbf8c20`; октябрьские фиксы (`fix/bughunt-2026-10`) — нет.

### Автоматический гейт на `dbf8c20`

Копия `git archive dbf8c20f` в скретчпаде, шаги как в `.github/workflows/tests.yml`:

| Проверка | Результат |
|---|---|
| `npm ci --legacy-peer-deps`, генерация деклараций, `npm run build` | зелёные |
| `npm run test` | 544 файла, 4937 тестов, 0 упавших |
| `:app:testSideloadDebugUnitTest --rerun-tasks` | BUILD SUCCESSFUL |
| `:app:lintSideloadDebug` | 51 ошибка: 43 NewApi (починены `769682ca`, не в релизе) + 8 старых (2 MissingPermission `CallPlugin.kt`, 4 MissingTranslation, UseAppTint, ChromeOS); в CI lint не гоняется |

### Стенд

Samsung SM-A528B (`R5CT316HB2T`, Android 14), до прогона стояла отладочная 1.13.2 (подпись `Android Debug`),
поэтому установка 1.13.9 требует `adb uninstall` и повторного входа TEST2. Веб: TEST1 (`test3823818`) в
headless Chrome, профиль `.bench/web/profiles/test1-prod`, вход жив на 2026-10-05. Комната TEST1 ↔ TEST2 —
`!KchsUDqhsdPwFUXfwd:matrix.pocketnet.app`. Гейт после каждого пункта: `dumpsys audio` → `MODE_NORMAL`,
`dumpsys telecom` без живых Connection, нет клиента AudioRecord у `com.forta.chat`, в логкате нет
`forced`/`stranded`.

### Smoke top-20

| # | Сценарий | Записи «Проверено» | Статус |
|---|---|---|---|
| 1 | 10 голосовых звонков подряд, отбой по очереди, пятый длится 90 с | `07dd6ee8`, `706e8f96`, `e137334a`, `00ddc636` | ☑ 10/10 соединились (13,6–20,7 с), 3 перепрогона из-за сети Mac; отбой телефона виден вебу ≤ 0,1 с; один раз на 138-с звонке веб узнал об отбое по таймауту ICE через 37 с, в двух целевых прогонах (fzweb, fz9) не повторилось |
| 2 | Перезвон в течение 1 с после отбоя, 3 раза | `d8a52a0d` | ☑ 3/3 с паузой 1 с, все соединились |
| 3 | Веб отменяет через 3 с звонка; рингер гаснет, у TEST2 запись «Пропущен» (решение Д1) | `ae5b00b1`, `e059cc1e`, `612fbb4e` | ☑ рингер снят, у TEST2 «Пропущен 20:33» |
| 4 | Ответ из шторки, приложение в фоне, дольше 30 с | `d606afdc` | ☑ «Ответить» в шторке, 42,9 с разговора |
| 5 | Ответ на экране блокировки с PIN | `d606afdc`, KeyguardLiftGate | ☑ все ответы пачки 2 приняты поверх экрана блокировки (`mKeyguardOccluded=true showing=true`) |
| 6 | Процесс убит (`am kill`; `force-stop` блокирует FCM), пуш-звонок с холодного старта, ответ | `b10bc69f`, `33868ae2`, `d25ea8a8` | ☑ со второй попытки; первая — FCM доставил пуш через 2:46 (Wi-Fi стенда −79 дБм) |
| 7 | Смахивание из «Недавних» посреди разговора; собеседник видит отбой < 2 с | `696470e2`, `a38e3082`, `ec716f7c` | ☑ `CallHangupSignal` → HTTP 200 через 0,9 с, веб видит завершение через 1,3 с |
| 8 | TEST2 и в вебе; ответ там, пока Samsung звонит (select_answer) | `eca48624` | ☑ ответ на вебе TEST2 → рингер Samsung снят пушем `select_answer` через 1,07 с; ответ на телефоне → «answered on this device», разговор живёт |
| 9 | Второй входящий от TEST3 во время разговора = занято, первый живёт | `e3079e09`, `13ea87bf`, `675baf71`, `27541373` | ☑ TEST3 (дев-сборка) получил «занято» за 1 с, первый разговор дожил до отбоя веба на 62-й секунде |
| 10 | Динамик: ухо → динамик → ухо | `4adc0eec`, `62581806`, `556c8450` | ☑ динамик → ухо → динамик, Telecom `route` меняется каждый раз |
| 11 | AirPods: выбор с динамика; снять посреди видеозвонка | `2646c129`, `07e20893`, `4af24d71`, `ca6710fe` | ☑ AirPods выбираются с динамика и из трубки 5/5; видеозвонок после кейса уходит на громкий динамик (с ручным выбором и без), голосовой остаётся в трубке |
| 12 | Исходящее видео Samsung → веб, смена камеры, тыл не зеркалится | `87e8dd1b`, `4c23a27b`, `2612eaee`, `3ac40372` | ☑ соединение за 2 с, веб принял 7,5 МБ видео; «Камера» переключает на тыльную (`Camera switched, front: false`), звонок не рвётся; зеркальность тыльного превью не оценить, телефон лежит экраном вверх |
| 13 | Входящее видео веб → Samsung, первое после холодного старта | `1c4ff317`, `19a2a4cb`, `d6542843` | ☑ видео собеседника на нативном экране, своё превью в углу (`videoin-call.png`) |
| 14 | Wi-Fi → LTE посреди разговора (перезапуск ICE) | `9d1f1036`, `c2ed5f98`, `6b1b88cc` | ☑ SIM MegaFon: Wi-Fi выкл → LTE, через ~10 с пара `srflx/srflx`, звук снова идёт; Wi-Fi вкл → `host/host` за 5–9 с; звонок не рвётся |
| 15 | Tor включён: звонок соединяется, предупреждение, строки в отчёте | `a9bb63ca`, `e9ec3f09` | ☑ после перезапуска: Tor готов за 12,7 с, сообщение и звонок проходят, «Всего, Tor» растёт, прямой нет; отбой при смахивании `tor=true`. Открыто: до готовности Tor «Всегда» идёт напрямую (правило с июля, `ca30651c`); после включения в настройках без перезапуска 6 мин Tor 0 Б при +394 КБ прямого — подтвердить на отладочной сборке |
| 16 | Исходящий без ответа до таймаута; индикатор микрофона гаснет | `77402000`, `01fedeed` | ☑ таймаут через 61 с, `stop()` + `endCall`, AudioRecord-клиентов нет |
| 17 | Веб кладёт трубку, экран Samsung выключен 2 мин (hangup-пуш) | `239b4d77`, `b2e20e0c`, `8dff0a4b` | ☑ экран выключен 2 мин, отбой веба → `endCall` за 0,47 с |
| 18 | Веб: свернуть окно звонка, звук идёт | запись CallWindow | ○ фикс `e438f87e` не в релизе; по RTP входящий звук при свёрнутом окне идёт (5,2 → 8,4 → 11,1 КБ), воспроизведение по статистике не доказать |
| 19 | Веб: демонстрация экрана старт/стоп в сторону Samsung | `a549d635` | ☑ кадр демонстрации виден на нативном экране Samsung (`share-call.png`) |
| 20 | Настоящий отчёт о баге из CI-сборки после звонка | `e8b1954c`, `1adc0949` | ◐ отчёт forta-bugs#1441: таймлайн аудио и строка ICE есть; при Tor «Всегда» отчёт не отправился дважды, ушёл после выключения Tor |

Статусы: ☑ прошёл, ☒ регрессия (лог в `.bench/runs/rel/`), ○ не выполнен (причина в примечании).

### Итог прогона

Регрессий сентябрьских фиксов нет: 18 пунктов прошли, 1 прошёл частично (отчёт о баге), 1 не нужен на этой сборке (сворачивание окна на вебе, фикс не в релизе).
Результаты по записям дописаны строкой «релиз dbf8c20» в `manual-verification.md`. Открытые наблюдения:

1. Один звонок из 24 (138 с, 9-й звонок процесса) узнал об отбое телефона только по таймауту ICE через 37 с.
   Два прицельных прогона (свежий процесс и 9-й звонок, 100–116 с) не повторили это. Wi-Fi стенда −79 дБм.
   Наблюдать.
2. Tor «Всегда» пускает запросы напрямую, пока Tor не готов: при старте 167,6 КБ за 13 с. Правило
   `TorRouteDecider` действует с июля (`ca30651c`). Это не регрессия, решение за владельцем.
3. После включения «Всегда» в настройках без перезапуска счётчик 6 минут показывал «Всего, Tor» 0 Б и +394 КБ
   прямого, включая два звонка. После перезапуска трафик идёт через Tor. Подтвердить на отладочной сборке.
4. Forta, выведенная на передний план во время нативного видеозвонка, показала окно звонка «Соединение…».
   Это исправлено в `6d4c313d`, коммит не входит в релиз.
5. Отчёт о баге при Tor «Всегда» не отправляется: дважды «Не удалось отправить», токен действителен
   (проверено отдельным запросом), после выключения Tor тот же отчёт ушёл сразу (forta-bugs#1441).
6. Карточка «Как прошёл звонок?» и запись истории показали 164 с для звонка около 37 с: таймлайн аудио
   в #1441 кончается на 36,9 с. Звонку предшествовало включение Tor в настройках. Причину не нашёл:
   `callTimer` пишет только интервал, который сбрасывается на каждом соединении. Нужна отладочная сборка.



## Прогон на реальном Samsung, 2026-09-09

Стенд: Samsung SM-A528B (Android 14, SDK 34, WebView 151.0.7922.199, серийник
`R5CT316HB2T`) с новой сборкой поверх старой + веб-клиент под TEST1 в headless
Chrome с фейковым микрофоном. Оба конца управляются скриптами, аккаунты
тестовые. Скрипты прогона лежат в скретчпаде сессии, не в репозитории.

### Подтверждено на живом устройстве

| Фикс | Доказательство из логката |
|---|---|
| **F32** | `CallPlugin: reportOutgoingCall: test3823818 (1788954840884hVNAUhH8ehEk5JZ7)` → `CallConnectionService: onCreateOutgoingConnection: callId=1788954840884hVNAUhH8ehEk5JZ7, callee=test3823818`. Старая сборка печатала `callId=` пустым. Тот же callId дальше приходит в `reportCallConnected: {"callId":"1788955257466MefxcBGPSWGUqHY7"}`. |
| **F25** | Три завершения подряд, каждое `CallTeardown: endCall reason=… callId=<непустой> … actions=[]`: по таймауту звонящего (`DISCONNECT`), по сбросу трубки (`DISCONNECT`), по 30-секундному авто-reject (`REJECT`, `audioMode=1`). Во всех случаях `MODE_IN_COMMUNICATION → MODE_NORMAL` за ~600 мс, `CallForegroundService: Service stopped`. Инвариант «при MODE_RINGTONE не трогать режим напрямую» соблюдён: при `audioMode=1` политика вернула `actions=[]`, режим вернулся сам. |
| **F26** | `IncomingRinger: arm callId=X` … `stop callId=X` — один и тот же callId, `stop` ровно по `onAnswer`, второго `arm` нет. Авто-reject тоже кейнутый: `no answer in 30s for X — auto-rejecting` → `stop callId=X` → `onReject: callId=X`. Флаги интента видны в системном логе: `START … IncomingCallActivity … flg=0x34000000 … LAUNCH_SINGLE_TOP` (NEW_TASK\|CLEAR_TOP\|SINGLE_TOP). |
| **F31** | `CallConnectionService: USE_FULL_SCREEN_INTENT not granted, FSI will be heads-up only` — на этом аппарате система разрешение действительно отозвала. Это прямая причина O10, и новая диагностика её показывает. |

Один звонок дошёл до разговора: со стороны веба `ice: connected`,
`pair: succeeded`, `localType=host / remoteType=prflx` — прямое p2p, relay не
понадобился (оба конца в одной сети, для O05 это не ответ). `AudioLifecycle:
start(voice) complete: active=EARPIECE, available=[EARPIECE, SPEAKER],
vendor=SAMSUNG`.

### Не проверено этим прогоном

- **F29** (динамик): выбор «Динамик» в нативной шторке «Аудиовыход» ни разу не
  попал в живой звонок — каждый раз соединение успевало закрыться. Ни строки
  `AudioRouter … setDevice`, ни отказа `router_inactive` в логах нет, то есть
  проверка не выполнена, а не провалена.
- **Слышимость**: веб отдаёт синтетический тон, микрофон телефона в тихой
  комнате, `totalAudioEnergy` со стороны веба ≈ 3·10⁻⁸. Отличить «нет звука»
  от «тихо» без человека у аппарата нельзя.

### Найдено на стенде: протухшая метка reject гасит следующий звонок

`consumePendingRejectCallId` (`src/shared/lib/native-calls/native-call-bridge.ts`)
сверяет метку не только по callId, но и **по roomId**, а у метки нет ни срока
жизни, ни привязки к конкретному звонку. 30-секундный авто-reject пишет
`CallConnection.pendingRejectCallId/RoomId` (`CallConnectionService.kt:554`); если
JS не забрал метку в тот момент, она доживает до следующего инвайта из той же
комнаты и гасит его через ветку по roomId.

Наблюдение: авто-reject в 15:07:24 (`callId=1788955612273O7S736BrqFIxqwQS`), а в
15:13:01 свежий звонок `17889559802696wWSVJYT0cFnIWQt` из той же комнаты получил
`[call-service] Pre-rejected incoming call, calling reject()` — телефон не
зазвонил, `onCreateIncomingConnection` не было вовсе, звонящий увидел «отклонён».

Воспроизводится по времени, а не по команде: в контрольном повторе звонящий
успел положить трубку раньше рингера (`stop callId=null` → `reason=DISCONNECT`),
метка не записалась, и следующий звонок прошёл нормально. Нужен исход, где
30-секундный таймаут приложения выигрывает гонку у lifetime инвайта.

Код пришёл из `75ecca14`, который **уже в `origin/master`** — это не регрессия
ветки, а открытый баг у пользователей. Симптом ложится в кластеры O04/O09.
