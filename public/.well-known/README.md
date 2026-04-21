# `.well-known/assetlinks.json`

This file is served from `https://forta.chat/.well-known/assetlinks.json` and is
required for Android App Links verification (skipping the "Open with" dialog and
opening `https://forta.chat/invite?ref=...` directly in the app).

## Placeholder fingerprint

The `sha256_cert_fingerprints` value currently contains a **placeholder**. Before
a production release it must be replaced with the SHA-256 fingerprint of the
actual release signing certificate.

```
keytool -list -v \
  -keystore /path/to/forta-release.keystore \
  -alias forta \
  -storepass <password>
```

Take the line that starts with `SHA256:` and paste the full colon-separated hex
value into `assetlinks.json`.

If Play App Signing is enabled, use the fingerprint from **Google Play Console →
Release → Setup → App signing → App signing key certificate** (the colon-separated
SHA-256 shown there).

Multiple fingerprints (debug + release, or before/after key rotation) can be added
to the array — Android will accept any of them.

## Verifying after deploy

```
adb shell pm get-app-links com.forta.chat
```

Should show `forta.chat: verified` for the link to work without a chooser dialog.
