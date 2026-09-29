#!/usr/bin/env bash
#
# Run the Maestro flows against a connected device or emulator.
#
#   scripts/e2e-android.sh                 # smoke only — needs no credentials
#   scripts/e2e-android.sh --all           # every single-device flow (needs .env)
#   scripts/e2e-android.sh --build         # rebuild + reinstall the debug APK first
#   scripts/e2e-android.sh flows/02-send-text.yaml
#
# --all deliberately excludes the `call` tag. Those three flows are the two
# halves of one scenario — the callee waits for a call the caller places from a
# second device — so on a single device they can only ever time out. Run them
# with scripts/e2e-call.sh, which drives both devices.
#
# Credentials come from .env, which is gitignored and never printed.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

APK="android/app/build/outputs/apk/sideload/debug/app-sideload-debug.apk"
BUILD=0
TARGET="e2e/maestro/flows/00-smoke-launch.yaml"
EXCLUDE_TAGS=""

for arg in "$@"; do
  case "$arg" in
    --build) BUILD=1 ;;
    --all) TARGET="e2e/maestro/flows"; EXCLUDE_TAGS="call" ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) TARGET="$arg" ;;
  esac
done

# Maestro interpolates ${VAR} in a flow from its own process environment, so
# exporting here is all that is needed — no -e passing. Values are never
# echoed: the file holds a private key.
if [ -f .env ]; then
  # Parsed line by line rather than sourced: a value may legitimately contain
  # spaces (a mnemonic phrase is twelve words), and `.` would try to run it as
  # a command. Nothing from .env is ever echoed.
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      ''|'#'*) continue ;;
    esac
    key=${line%%=*}
    value=${line#*=}
    case "$key" in
      *[!A-Za-z0-9_]*|'') continue ;;
    esac
    # Strip one layer of surrounding quotes if present.
    case "$value" in
      \"*\") value=${value#\"}; value=${value%\"} ;;
      "'"*"'") value=${value#"'"}; value=${value%"'"} ;;
    esac
    export "$key=$value"
  done < .env

  # Accept the shorter TEST1/TEST2 names as aliases so an existing .env works
  # without being rewritten.
  : "${MAESTRO_E2E_PRIVATE_KEY:=${TEST1:-}}"
  : "${MAESTRO_E2E_PRIVATE_KEY_B:=${TEST2:-}}"
  export MAESTRO_E2E_PRIVATE_KEY MAESTRO_E2E_PRIVATE_KEY_B

  if [ -n "${MAESTRO_E2E_PRIVATE_KEY:-}" ]; then
    echo "[e2e] loaded .env (account key present)"
  else
    echo "[e2e] loaded .env (no account key — credentialed flows will fail)"
  fi
else
  echo "[e2e] no .env — only credential-free flows will pass"
fi

export MAESTRO_CLI_NO_ANALYTICS=1
export PATH="$HOME/.maestro/bin:$PATH"

command -v maestro >/dev/null || {
  echo "[e2e] maestro not found. Install: curl -Ls https://get.maestro.mobile.dev | bash" >&2
  exit 1
}

# Pick a device explicitly. Bare `adb get-state`/`adb install` fail with "more
# than one device" as soon as a second emulator is running, which is the normal
# state here because the call scenario needs two.
DEVICE="${DEVICE:-$(adb devices | awk '$2 == "device" { print $1; exit }')}"
[ -n "$DEVICE" ] || {
  echo "[e2e] no device. Start one: emulator -avd callA" >&2
  exit 1
}
echo "[e2e] using $DEVICE"

if [ "$BUILD" = "1" ]; then
  echo "[e2e] building debug APK"
  npm run cap:build
  (cd android && ./gradlew assembleSideloadDebug)
fi

[ -f "$APK" ] || {
  echo "[e2e] $APK missing — run with --build" >&2
  exit 1
}

echo "[e2e] installing APK"
# A silent failure here (a release build with another signature on the device)
# used to leave the old app in place and every flow failing on its first screen.
if ! install_out=$(adb -s "$DEVICE" install -r "$APK" 2>&1); then
  echo "[e2e] install failed: $install_out" >&2
  echo "[e2e] a release build on the device? uninstall it first: adb -s $DEVICE uninstall com.forta.chat" >&2
  exit 1
fi

# Which flows will actually run — needed both for the tag filter and for the
# preflight below.
selected_flows() {
  if [ -d "$TARGET" ]; then
    for f in "$TARGET"/*.yaml; do
      # An empty directory leaves the glob unexpanded; grepping that literal
      # path would be a bogus miss rather than an empty result.
      [ -e "$f" ] || continue
      if [ -n "$EXCLUDE_TAGS" ] && grep -q "^[[:space:]]*-[[:space:]]*$EXCLUDE_TAGS\$" "$f"; then
        continue
      fi
      printf '%s\n' "$f"
    done
  else
    printf '%s\n' "$TARGET"
  fi
  # Every credentialed flow pulls these in via runFlow.
  for f in e2e/maestro/subflows/*.yaml; do
    [ -e "$f" ] && printf '%s\n' "$f"
  done
}

# An unset ${VAR} does not fail a flow — Maestro substitutes the literal
# "undefined" and the run dies later on an assertion that reads like an app
# bug. Name the missing variables up front instead. Names only, never values.
missing=""
while IFS= read -r var; do
  [ -n "$var" ] || continue
  eval "val=\${$var:-}"
  [ -n "$val" ] || missing="$missing $var"
done <<EOF
$(selected_flows | xargs grep -rho 'MAESTRO_E2E_[A-Z_]*' 2>/dev/null | sort -u)
EOF

if [ -n "$missing" ]; then
  echo "[e2e] WARNING: unset in .env, flows using them will assert on the literal 'undefined':"
  for var in $missing; do echo "[e2e]   - $var"; done
  echo "[e2e] see .env.example for what each one holds"
fi

# Maestro writes every `inputText` value into ~/.maestro/tests/<run>/…/maestro.log,
# the private key included. Scrub those lines once the run is over, pass or fail.
scrub_maestro_logs() {
  local dir="$HOME/.maestro/tests"
  [ -d "$dir" ] || return 0
  find "$dir" -name 'maestro.log' -newer "$APK" -print0 2>/dev/null | while IFS= read -r -d '' log; do
    sed -i '' -E 's/(Inputting text: ).*/\1<redacted by e2e-android.sh>/' "$log" 2>/dev/null || true
  done
}
trap scrub_maestro_logs EXIT

echo "[e2e] running $TARGET${EXCLUDE_TAGS:+ (excluding tag: $EXCLUDE_TAGS)}"
if [ -n "$EXCLUDE_TAGS" ]; then
  maestro --device "$DEVICE" test --exclude-tags "$EXCLUDE_TAGS" "$TARGET"
else
  maestro --device "$DEVICE" test "$TARGET"
fi
