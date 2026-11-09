#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 3 ]]; then
  echo "Usage: $0 APK_PATH VERSION_CODE VERSION_NAME [RELEASE_NOTES] [mandatory]" >&2
  exit 64
fi

SOURCE_APK="$1"
VERSION_CODE="$2"
VERSION_NAME="$3"
RELEASE_NOTES="${4:-Bug fixes and improvements.}"
MANDATORY="${5:-false}"
RELEASE_DIR="${APP_RELEASE_DIR:-/var/lib/gabber/releases}"
MANIFEST_PATH="${APP_UPDATE_MANIFEST_PATH:-$RELEASE_DIR/android-update.json}"

if [[ ! -f "$SOURCE_APK" ]]; then
  echo "APK not found: $SOURCE_APK" >&2
  exit 66
fi
if [[ ! "$VERSION_CODE" =~ ^[1-9][0-9]*$ ]]; then
  echo "VERSION_CODE must be a positive integer." >&2
  exit 64
fi
if [[ "$MANDATORY" != "true" && "$MANDATORY" != "false" ]]; then
  echo "mandatory must be true or false." >&2
  exit 64
fi

sudo install -d -m 0755 -o "$(id -un)" -g "$(id -gn)" "$RELEASE_DIR"
FILENAME="gabber-${VERSION_CODE}.apk"
DESTINATION="$RELEASE_DIR/$FILENAME"
install -m 0644 "$SOURCE_APK" "$DESTINATION"

SHA256="$(sha256sum "$DESTINATION" | awk '{print $1}')"
BYTES="$(stat -c '%s' "$DESTINATION")"
TEMP_MANIFEST="$(mktemp "$RELEASE_DIR/android-update.XXXXXX.json")"

node - "$TEMP_MANIFEST" "$VERSION_CODE" "$VERSION_NAME" "$FILENAME" "$SHA256" "$BYTES" "$RELEASE_NOTES" "$MANDATORY" <<'NODE'
const fs = require("fs");
const [file, versionCode, versionName, filename, sha256, bytes, releaseNotes, mandatory] = process.argv.slice(2);
fs.writeFileSync(file, `${JSON.stringify({
  versionCode: Number(versionCode),
  versionName,
  filename,
  sha256,
  bytes: Number(bytes),
  releaseNotes,
  mandatory: mandatory === "true",
  publishedAt: new Date().toISOString(),
}, null, 2)}\n`, { mode: 0o644 });
NODE

mv -f "$TEMP_MANIFEST" "$MANIFEST_PATH"
echo "Published Gabber Android ${VERSION_NAME} (${VERSION_CODE})"
echo "APK: $DESTINATION"
echo "SHA-256: $SHA256"

