# Локальная сборка Android (APK / AAB)

## Пререквизиты

1. **JDK 17+** — Gradle 8.14 требует минимум JDK 17
   ```bash
   brew install openjdk@17
   ```

2. **Android SDK** — compileSdk 36, minSdk 24, targetSdk 36
   ```bash
   sdkmanager "platforms;android-36" "build-tools;36.0.0" "platform-tools"
   ```

3. **Переменная окружения** `ANDROID_HOME`:
   ```bash
   export ANDROID_HOME="$HOME/Library/Android/sdk"
   export PATH="$ANDROID_HOME/platform-tools:$PATH"
   ```

4. **Node.js** + **npm**

## Product flavors

Один `applicationId`: `com.forta.chat`. Два канала дистрибуции:

| Flavor | Артефакт | AppUpdater | `REQUEST_INSTALL_PACKAGES` |
|--------|----------|------------|----------------------------|
| `sideload` (default) | APK | да (GitHub Releases) | да |
| `play` | AAB | нет | нет |

Debug / `npx cap run` используют **sideload** (`isDefault`).

## Debug APK

```bash
# Собрать web + синхронизировать с android
npm run cap:build

# Собрать debug APK (sideload)
cd android && ./gradlew assembleSideloadDebug && cd ..
```

Результат: `android/app/build/outputs/apk/sideload/debug/app-sideload-debug.apk`

## Release: sideload APK + Play AAB

### Создание keystore (один раз)

```bash
keytool -genkey -v -keystore forta-release.keystore -alias forta -keyalg RSA -keysize 2048 -validity 10000
```

### Переменные окружения

```bash
export RELEASE_STORE_FILE=/path/to/forta-release.keystore
export RELEASE_STORE_PASSWORD=your_password
export RELEASE_KEY_ALIAS=forta
export RELEASE_KEY_PASSWORD=your_key_password
```

### Сборка

```bash
npm run cap:build
cd android && ./gradlew assembleSideloadRelease bundlePlayRelease && cd ..
node scripts/verify-android-distribution.mjs
```

Или через npm:

```bash
npm run cap:apk          # sideload release APK
npm run cap:aab:play     # play release AAB
npm run cap:verify-dist  # проверка манифестов / BuildConfig / артефактов
```

| Артефакт | Путь |
|----------|------|
| Sideload APK | `android/app/build/outputs/apk/sideload/release/app-sideload-release.apk` (без keystore: `…-unsigned.apk`) |
| Play AAB | `android/app/build/outputs/bundle/playRelease/app-play-release.aab` |

`verify-android-distribution.mjs` обязан пройти перед коммитом/релизом:

- sideload: permission + `ENABLE_APP_UPDATER=true` + `file_paths.xml` (`apk_updates`)
- play: **нет** `REQUEST_INSTALL_PACKAGES` + `ENABLE_APP_UPDATER=false`

## Тестовая сборка (QA)

Release-подписанные тестовые APK и AAB выкладываются на сервер **вручную** через GitHub Actions:

1. Откройте [Actions → Android Test APK](https://github.com/pocketnetteam/forta.chat/actions/workflows/android-test-apk.yml).
2. Нажмите **Run workflow**, выберите ветку (обычно `master`) и подтвердите.
3. После успешного прогона артефакты доступны по ссылкам:

- **APK (sideload, с AppUpdater):** https://forta.chat/apktests/latest.apk
- **AAB (play, без AppUpdater — Play Console):** https://forta.chat/apktests/latest.aab

Workflow: [`.github/workflows/android-test-apk.yml`](../.github/workflows/android-test-apk.yml)

| | Prod (тег `v*`) | Тест (ручной запуск) |
|---|---|---|
| Канал | GitHub Releases: sideload APK + play AAB | FTP `apktests/latest.apk` + `latest.aab` |
| Триггер | Push тега `v*` | `workflow_dispatch` в GitHub Actions |
| `versionName` / `versionCode` | Из тега, напр. `1.10.46` → `11046` | Из `package.json` +1 patch (та же формула `versionCode`) |
| Имя файла | `forta-chat-<version>.apk` + `.aab` | `latest.apk` / `latest.aab` (внутри CI: `forta-chat-test-<version>.{apk,aab}`) |
| Автообновление в приложении | Sideload APK: да (`releases/latest`). Play AAB: нет | Sideload APK: да (код есть), но test APK не на `releases/latest`. Play AAB: нет |
| Подпись | Release keystore | Тот же release keystore |

### Версионирование (тест → релиз)

Источник версии — **`package.json`** (`version`). GitHub Releases не используется как источник номера.

1. В `package.json` хранится последняя выпущенная версия (сейчас совпадает с prod).
2. **Тест:** CI берёт max(`package.json`, [`apktests/version.json`](https://forta.chat/apktests/version.json)), поднимает **patch на 1** и собирает sideload APK + play AAB.
3. **Релиз:** после QA поднимаете `package.json` до протестированной версии, коммитите и ставите тег `v*` с тем же номером.
4. Повторный тест до релиза снова поднимает patch (учитывается `version.json` на сервере).

### Установка для тестировщиков

1. Скачать [latest.apk](https://forta.chat/apktests/latest.apk) на устройство.
2. Разрешить установку из неизвестных источников (если потребуется).
3. Установить APK.

AAB (`latest.aab`) — **play**-flavor для загрузки в Play Console (internal/closed testing). На устройство напрямую не ставится; без in-app автообновления.

### Важно

- Тестовый APK **можно поставить поверх** production-версии (та же подпись, тот же `versionCode`-диапазон).
- После теста: обновите `package.json` до протестированной версии и выпускайте prod с тегом `v*` с **тем же номером**.
- Тестовая сборка **не** создаёт GitHub Release и **не** влияет на автообновление у обычных пользователей (AppUpdater читает только `releases/latest`).
- Prod GitHub Release должен публиковать **sideload** APK — иначе in-app updater сломается.

## Установка на устройство

```bash
# Через Capacitor (sideload debug)
npm run cap:run

# Через adb
adb install android/app/build/outputs/apk/sideload/debug/app-sideload-debug.apk
```

## Справка

| Параметр | Значение |
|----------|----------|
| Gradle | 8.14.3 |
| compileSdk | 36 |
| minSdk | 24 |
| targetSdk | 36 |
| JDK | 17+ |
| Capacitor | 8.2 |
| Firebase | опционально (`google-services.json`) |
| applicationId | `com.forta.chat` |
