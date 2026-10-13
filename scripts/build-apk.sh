#!/usr/bin/env bash
# Build the Hermes Omni Android shell (android/) in Docker and publish it for the hub:
#   omni-state/apk/hermes-omni.apk + omni-state/apk/meta.json
#
# - Builder: ghcr.io/cirruslabs/android-sdk:35 (JDK 21, SDK 35) + Gradle 8.10.2, both cached in the
#   named docker volume "hermes-omni-gradle". The source is copied inside the container, so the
#   repo never gets build/ or .gradle/ directories.
# - versionCode = yymmddHH (bumped past the published one), versionName = 0.1.<versionCode>.
# - Release key: generated once at omni-state/android/release.jks with a random password in
#   omni-state/android/keystore.pass (mode 600). Keep both: a new key forces users to reinstall.
# - Checks: apksigner verify, zipalign -c, aapt2 badging (package/versionCode/label), signer
#   continuity against the previously published meta.json.
#
# Usage: scripts/build-apk.sh [--hub-url URL] [--allow-signer-change]
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE="$REPO/omni-state"
APK_DIR="$STATE/apk"
KEY_DIR="$STATE/android"
HUB_ENV="$STATE/hub/hub.env"

IMAGE="${OMNI_ANDROID_IMAGE:-ghcr.io/cirruslabs/android-sdk@sha256:c724009e305b4607157287624033ab97f319af44c244bfc9f73b6293f3bb01b9}"
GRADLE_VOLUME="${OMNI_GRADLE_VOLUME:-hermes-omni-gradle}"
GRADLE_VERSION=8.10.2
GRADLE_SHA256=31c55713e40233a8303827ceb42ca48a47267a0ad4bab9177123121e71524c26
PACKAGE=net.hermesomni.app
APP_LABEL="Hermes Omni"
KS_ALIAS=hermes-omni
CONTAINER="omni-build-android-$$"

log() { printf '[build-apk] %s\n' "$*" >&2; }
die() { printf '[build-apk] ERROR: %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<EOF
Usage: $0 [--hub-url URL] [--allow-signer-change]

  --hub-url URL           Default hub URL baked into the app (first-run dialog prefill).
                          Default: OMNI_PUBLIC_URL from omni-state/hub/hub.env, else empty.
  --allow-signer-change   Publish even if the signing certificate differs from the
                          previously published APK (users must uninstall/reinstall).
Env: OMNI_ANDROID_IMAGE (builder image), OMNI_GRADLE_VOLUME (cache volume name).
EOF
}

HUB_URL=""
HUB_URL_SET=0
ALLOW_SIGNER_CHANGE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --hub-url) [ $# -ge 2 ] || die "--hub-url needs a value"; HUB_URL="$2"; HUB_URL_SET=1; shift 2 ;;
    --hub-url=*) HUB_URL="${1#*=}"; HUB_URL_SET=1; shift ;;
    --allow-signer-change) ALLOW_SIGNER_CHANGE=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; die "unknown argument: $1" ;;
  esac
done

command -v docker >/dev/null || die "docker not found"
[ -f "$REPO/android/app/build.gradle" ] || die "android project not found at $REPO/android"

# --- hub URL ---------------------------------------------------------------------------------
if [ "$HUB_URL_SET" = 0 ] && [ -f "$HUB_ENV" ]; then
  HUB_URL="$(sed -n 's/^OMNI_PUBLIC_URL=//p' "$HUB_ENV" | tail -n 1 | tr -d "\"'\r")"
  [ -n "$HUB_URL" ] && log "hub URL from hub.env: $HUB_URL"
fi
HUB_URL="${HUB_URL%/}"
if [ -n "$HUB_URL" ]; then
  # Strict shape: it is compiled into a Java string constant.
  [[ "$HUB_URL" =~ ^https?://[A-Za-z0-9._~-]+(:[0-9]{1,5})?(/[A-Za-z0-9._~/%-]*)?$ ]] \
    || die "invalid hub URL: $HUB_URL (expected http(s)://host[:port][/path])"
else
  log "no hub URL given and no OMNI_PUBLIC_URL in hub.env; the app will ask on first run"
fi

# --- directories, lock -----------------------------------------------------------------------
umask 022
mkdir -p "$APK_DIR" "$KEY_DIR"
chmod 755 "$APK_DIR"
chmod 700 "$KEY_DIR"
exec 9>"$APK_DIR/.build.lock"
flock -n 9 || die "another build-apk.sh is running"

HOST_UID="$(id -u)"
HOST_GID="$(id -g)"
# When run as root, hand published files to the owner of omni-state (the HERMES_UID user).
fix_owner() { if [ "$HOST_UID" = 0 ]; then chown --reference="$STATE" "$@" 2>/dev/null || true; fi; }

# --- version ---------------------------------------------------------------------------------
PREV_CODE=0
PREV_SIGNER=""
if [ -f "$APK_DIR/meta.json" ]; then
  PREV_CODE="$(grep -o '"version_code": *[0-9]*' "$APK_DIR/meta.json" | grep -o '[0-9]*$' || true)"
  PREV_SIGNER="$(grep -o '"signer_sha256": *"[0-9a-f]*"' "$APK_DIR/meta.json" | grep -o '[0-9a-f]\{64\}' || true)"
  PREV_CODE="${PREV_CODE:-0}"
fi
VERSION_CODE="$((10#$(date +%y%m%d%H)))"
if [ "$VERSION_CODE" -le "$PREV_CODE" ]; then VERSION_CODE=$((PREV_CODE + 1)); fi
VERSION_NAME="0.1.$VERSION_CODE"
log "version $VERSION_NAME (code $VERSION_CODE, previous $PREV_CODE)"

# --- staging + cleanup -----------------------------------------------------------------------
STAGE="$(mktemp -d "$APK_DIR/.staging.XXXXXX")"
chmod 755 "$STAGE"
cleanup() {
  docker rm -f "$CONTAINER" "$CONTAINER-keygen" >/dev/null 2>&1 || true
  rm -rf "$STAGE"
  rm -f "$APK_DIR/.meta.json.tmp" "$APK_DIR/.hermes-omni.apk.tmp"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  log "pulling $IMAGE (≈0.8 GB)"
  docker pull "$IMAGE" >/dev/null
fi

# --- keystore (once) -------------------------------------------------------------------------
if [ ! -s "$KEY_DIR/release.jks" ]; then
  if [ ! -s "$KEY_DIR/keystore.pass" ]; then
    PASS="$(head -c 48 /dev/urandom | od -An -tx1 | tr -d ' \n')"
    (umask 077 && printf '%s\n' "${PASS:0:40}" > "$KEY_DIR/keystore.pass")
    unset PASS
  fi
  log "generating release keystore (one-time)"
  docker run --rm --name "$CONTAINER-keygen" --network none \
    -v "$KEY_DIR:/keys" -e HOST_UID="$HOST_UID" -e HOST_GID="$HOST_GID" -e KS_ALIAS="$KS_ALIAS" \
    --entrypoint /bin/bash "$IMAGE" -c '
      set -euo pipefail
      KS_PASS="$(head -n 1 /keys/keystore.pass)"; export KS_PASS
      out="$(keytool -genkeypair -noprompt -keystore /keys/.release.jks.tmp -storetype PKCS12 \
        -alias "$KS_ALIAS" -keyalg RSA -keysize 3072 -validity 10000 \
        -dname "CN=Hermes Omni, O=hermes-omni" -storepass:env KS_PASS -keypass:env KS_PASS 2>&1)" || { echo "$out" >&2; exit 1; }
      chmod 600 /keys/.release.jks.tmp
      chown "$HOST_UID:$HOST_GID" /keys/.release.jks.tmp
      mv /keys/.release.jks.tmp /keys/release.jks'
fi
[ -s "$KEY_DIR/keystore.pass" ] || die "missing $KEY_DIR/keystore.pass for existing release.jks"
chmod 600 "$KEY_DIR/keystore.pass" "$KEY_DIR/release.jks"

# --- build -----------------------------------------------------------------------------------
# Runs inside the builder container (passed with -c, not stdin, so no child can eat the script).
read -r -d '' INNER_SCRIPT <<'INNER' || true
set -euo pipefail
GH="/cache/gradle-$GRADLE_VERSION"
if [ ! -x "$GH/bin/gradle" ]; then
  echo "[container] downloading Gradle $GRADLE_VERSION"
  tmp="$(mktemp -d /cache/.dl.XXXXXX)"
  trap 'rm -rf "$tmp"' EXIT
  curl -fsSL --retry 3 -o "$tmp/g.zip" "https://services.gradle.org/distributions/gradle-$GRADLE_VERSION-bin.zip"
  echo "$GRADLE_SHA256  $tmp/g.zip" | sha256sum -c --quiet -
  unzip -q "$tmp/g.zip" -d "$tmp"
  mv "$tmp/gradle-$GRADLE_VERSION" "$GH"
  rm -rf "$tmp"
fi

# Build in a scratch copy: the source mount is read-only and must stay free of build output.
rm -rf /work && cp -a /src /work && cd /work
rm -rf .gradle build app/build local.properties
OMNI_KS_PASS="$(head -n 1 /keys/keystore.pass)"; export OMNI_KS_PASS

"$GH/bin/gradle" --no-daemon --console=plain --warning-mode=summary -g /cache/home assembleRelease </dev/null

APK=app/build/outputs/apk/release/app-release.apk
BT="$ANDROID_HOME/build-tools/35.0.0"
[ -f "$APK" ] || { echo "[container] no signed release APK produced" >&2; exit 1; }
"$BT/zipalign" -c 4 "$APK"
"$BT/apksigner" verify --verbose --print-certs "$APK" > /out/apksigner.txt
"$BT/aapt2" dump badging "$APK" > /out/badging.txt
unzip -l "$APK" > /out/contents.txt
cp "$APK" /out/hermes-omni.apk
chown -R "$HOST_UID:$HOST_GID" /out
chmod 644 /out/*
INNER

log "building in $IMAGE (gradle cache volume: $GRADLE_VOLUME)"
BUILD_START=$SECONDS
docker run --rm --name "$CONTAINER" \
  -v "$REPO/android:/src:ro" \
  -v "$KEY_DIR:/keys:ro" \
  -v "$STAGE:/out" \
  -v "$GRADLE_VOLUME:/cache" \
  -e GRADLE_VERSION="$GRADLE_VERSION" -e GRADLE_SHA256="$GRADLE_SHA256" \
  -e ORG_GRADLE_PROJECT_omniVersionCode="$VERSION_CODE" \
  -e ORG_GRADLE_PROJECT_omniVersionName="$VERSION_NAME" \
  -e ORG_GRADLE_PROJECT_omniHubUrl="$HUB_URL" \
  -e OMNI_KS_FILE=/keys/release.jks -e OMNI_KS_ALIAS="$KS_ALIAS" \
  -e HOST_UID="$HOST_UID" -e HOST_GID="$HOST_GID" \
  --entrypoint /bin/bash "$IMAGE" -c "$INNER_SCRIPT"
BUILD_SECS=$((SECONDS - BUILD_START))

# --- verify ----------------------------------------------------------------------------------
APK="$STAGE/hermes-omni.apk"
[ -s "$APK" ] || die "build produced no APK"
grep -q '^Verifies$' "$STAGE/apksigner.txt" || die "apksigner verify failed: $(cat "$STAGE/apksigner.txt")"
grep -q "^package: name='$PACKAGE' versionCode='$VERSION_CODE' versionName='$VERSION_NAME'" "$STAGE/badging.txt" \
  || die "badging mismatch: $(head -n 1 "$STAGE/badging.txt")"
grep -q "^application-label:'$APP_LABEL'" "$STAGE/badging.txt" || die "badging: app label is not '$APP_LABEL'"
SIGNER="$(sed -n 's/^Signer #1 certificate SHA-256 digest: *//p' "$STAGE/apksigner.txt" | head -n 1)"
[[ "$SIGNER" =~ ^[0-9a-f]{64}$ ]] || die "could not read signer certificate digest"
if [ -n "$PREV_SIGNER" ] && [ "$PREV_SIGNER" != "$SIGNER" ]; then
  if [ "$ALLOW_SIGNER_CHANGE" = 1 ]; then
    log "WARNING: signer changed ($PREV_SIGNER -> $SIGNER); installed apps must be reinstalled"
  else
    die "signer changed ($PREV_SIGNER -> $SIGNER); refusing (use --allow-signer-change)"
  fi
fi

SHA256="$(sha256sum "$APK" | cut -d' ' -f1)"
SIZE="$(stat -c %s "$APK")"
BUILT_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# --- publish atomically: APK first, then meta.json -------------------------------------------
mv -f "$APK" "$APK_DIR/.hermes-omni.apk.tmp"
chmod 644 "$APK_DIR/.hermes-omni.apk.tmp"
fix_owner "$APK_DIR/.hermes-omni.apk.tmp"
mv -f "$APK_DIR/.hermes-omni.apk.tmp" "$APK_DIR/hermes-omni.apk"

printf '{\n  "version_name": "%s",\n  "version_code": %s,\n  "sha256": "%s",\n  "size": %s,\n  "built_at": "%s",\n  "signer_sha256": "%s"\n}\n' \
  "$VERSION_NAME" "$VERSION_CODE" "$SHA256" "$SIZE" "$BUILT_AT" "$SIGNER" > "$APK_DIR/.meta.json.tmp"
chmod 644 "$APK_DIR/.meta.json.tmp"
fix_owner "$APK_DIR/.meta.json.tmp"
mv -f "$APK_DIR/.meta.json.tmp" "$APK_DIR/meta.json"
fix_owner "$APK_DIR"

log "permissions: $(grep -o "^uses-permission: name='[^']*'" "$STAGE/badging.txt" | sed "s/.*name='//; s/'$//" | tr '\n' ' ')"
log "published $APK_DIR/hermes-omni.apk ($SIZE bytes, sha256 $SHA256)"
log "signer sha256 $SIGNER; default hub URL: ${HUB_URL:-<none>}; build ${BUILD_SECS}s, total ${SECONDS}s"
