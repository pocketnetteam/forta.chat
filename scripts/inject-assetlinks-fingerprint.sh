#!/usr/bin/env bash
# Replaces PLACEHOLDER_FILL_BEFORE_RELEASE in dist/.well-known/assetlinks.json
# with the real SHA-256 fingerprint of the Android release keystore.
#
# Runs in CI after `vite build` and before FTP deploy. The repo file stays with
# a placeholder — the production value is derived at deploy time from the same
# keystore that signs the APK.
#
# Required env:
#   ANDROID_KEYSTORE_B64      — base64-encoded release keystore
#   ANDROID_KEYSTORE_PASSWORD — keystore password
#   ANDROID_KEY_ALIAS         — key alias within the keystore
#
# Optional env:
#   ASSETLINKS_PATH           — override output path (default dist/.well-known/assetlinks.json)

set -euo pipefail

ASSETLINKS_PATH="${ASSETLINKS_PATH:-dist/.well-known/assetlinks.json}"

if [[ -z "${ANDROID_KEYSTORE_B64:-}" || -z "${ANDROID_KEYSTORE_PASSWORD:-}" || -z "${ANDROID_KEY_ALIAS:-}" ]]; then
  echo "[inject-assetlinks] missing required env (ANDROID_KEYSTORE_B64, ANDROID_KEYSTORE_PASSWORD, ANDROID_KEY_ALIAS)" >&2
  exit 1
fi

if [[ ! -f "$ASSETLINKS_PATH" ]]; then
  echo "[inject-assetlinks] $ASSETLINKS_PATH not found — did vite build run?" >&2
  exit 1
fi

TMP_KEYSTORE="$(mktemp -t keystore.XXXXXX.jks)"
trap 'rm -f "$TMP_KEYSTORE"' EXIT

echo "$ANDROID_KEYSTORE_B64" | base64 -d > "$TMP_KEYSTORE"

# `keytool -list -v` prints the full cert chain; we want the SHA256 line for
# the chosen alias. The value looks like:
#   SHA256: AA:BB:CC:...:99
#
# Use `-storepass:env` so the password is read from an environment variable
# rather than a command-line argument — otherwise it would appear in
# `ps aux` output on the CI runner and in any crash dumps.
FINGERPRINT="$(
  KEYTOOL_STOREPASS="$ANDROID_KEYSTORE_PASSWORD" \
  keytool -list -v \
    -keystore "$TMP_KEYSTORE" \
    -alias "$ANDROID_KEY_ALIAS" \
    -storepass:env KEYTOOL_STOREPASS \
    2>/dev/null \
  | awk -F': ' '/SHA256:/ { print $2; exit }' \
  | tr -d '[:space:]'
)"

if [[ -z "$FINGERPRINT" ]]; then
  echo "[inject-assetlinks] failed to extract SHA-256 fingerprint (wrong alias or password?)" >&2
  exit 1
fi

# Sanity check: colon-separated 32 hex bytes = 64 hex chars + 31 colons = 95.
if [[ ${#FINGERPRINT} -ne 95 ]]; then
  echo "[inject-assetlinks] fingerprint has unexpected length ${#FINGERPRINT}: $FINGERPRINT" >&2
  exit 1
fi

# Replace the placeholder. Portable across GNU/BSD sed: write to a temp file
# and move — avoids `sed -i` incompatibility (BSD needs a suffix arg).
TMP_OUT="$(mktemp)"
sed "s|PLACEHOLDER_FILL_BEFORE_RELEASE[^\"]*|$FINGERPRINT|g" "$ASSETLINKS_PATH" > "$TMP_OUT"
mv "$TMP_OUT" "$ASSETLINKS_PATH"

if grep -q "PLACEHOLDER_FILL_BEFORE_RELEASE" "$ASSETLINKS_PATH"; then
  echo "[inject-assetlinks] placeholder still present after substitution — check assetlinks.json format" >&2
  exit 1
fi

echo "[inject-assetlinks] injected fingerprint into $ASSETLINKS_PATH (length ${#FINGERPRINT})"
