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
