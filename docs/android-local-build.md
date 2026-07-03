# Локальная сборка APK

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

## Debug APK

```bash
# Собрать web + синхронизировать с android
npm run cap:build

# Собрать debug APK
cd android && ./gradlew assembleDebug && cd ..
```

Результат: `android/app/build/outputs/apk/debug/app-debug.apk`

## Release APK (подписанный)

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
cd android && ./gradlew assembleRelease && cd ..
```

Результат: `android/app/build/outputs/apk/release/app-release.apk`

## Тестовая сборка (QA)

Release-подписанный тестовый APK выкладывается на сервер **вручную** через GitHub Actions:

1. Откройте [Actions → Android Test APK](https://github.com/pocketnetteam/forta.chat/actions/workflows/android-test-apk.yml).
2. Нажмите **Run workflow**, выберите ветку (обычно `master`) и подтвердите.
3. После успешного прогона APK доступен по ссылке:

**https://forta.chat/apktests/latest.apk**

Workflow: [`.github/workflows/android-test-apk.yml`](../.github/workflows/android-test-apk.yml)

| | Prod (тег `v*`) | Тест (ручной запуск) |
|---|---|---|
| Канал | GitHub Releases | FTP `apktests/latest.apk` |
| Триггер | Push тега `v*` | `workflow_dispatch` в GitHub Actions |
| Имя файла | `forta-chat-<version>.apk` | `latest.apk` (внутри CI: `forta-chat-test-<sha>.apk`) |
| Автообновление в приложении | Да (`releases/latest`) | Нет |
| Подпись | Release keystore | Тот же release keystore |

### Установка для тестировщиков

1. Скачать [latest.apk](https://forta.chat/apktests/latest.apk) на устройство.
2. Разрешить установку из неизвестных источников (если потребуется).
3. Установить APK.

### Важно

- Тестовый APK **можно поставить поверх** production-версии (та же подпись, `versionCode` в диапазоне `900000+`).
- **Откат на prod без удаления не сработает** — у prod `versionCode` ниже. Чтобы вернуться на production, переустановите APK с [GitHub Releases](https://github.com/pocketnetteam/forta.chat/releases/latest).
- Тестовая сборка **не** создаёт GitHub Release и **не** влияет на автообновление у обычных пользователей.

## Установка на устройство

```bash
# Через Capacitor
npm run cap:run

# Через adb
adb install android/app/build/outputs/apk/debug/app-debug.apk
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
