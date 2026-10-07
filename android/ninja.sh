#!/bin/bash
# Builds ONLY with ninja, without going through Soong (nor its ~20 min / >30 GB RAM analysis).
# It works as long as only .cpp/.h files already listed in an existing Android.bp change: ninja
# rebuilds what changed. If a source file is added or an Android.bp is touched, it has to
# go through android/build.sh once (which runs Soong) to regenerate the .ninja files.
#
# Usage: android/ninja.sh <output-path-inside-/out> [log]
#   e.g. android/ninja.sh /out/target/product/redroid_x86_64/vendor/bin/hw/android.hardware.media.c2-vaapi-service
#
# Important: run as `jgustavo` (the user of the last good build). As root, Soong detects another
# build user and redoes the whole analysis; it also leaves root files in /out.
set -euo pipefail
AOSP=${AOSP_DIR:-$HOME/aosp-redroid-15}
HERE=$(cd "$(dirname "$0")" && pwd)
TARGET=${1:?usage: android/ninja.sh <output-path-in-/out> [log]}
LOG=${2:-/dev/stdout}

mkdir -p "$AOSP/external/vaapi_codec2"
rsync -a "$HERE/vaapi_codec2/" "$AOSP/external/vaapi_codec2/"
cp "$HERE/../backend/native/vaapi-daemon/protocol.h" "$AOSP/external/vaapi_codec2/component/protocol.h"

docker exec -i -u jgustavo -e HOME=/home/jgustavo -e USER=jgustavo redroid-build-persist python3 - "$TARGET" > "$LOG" 2>&1 <<'PY'
import json, os, subprocess, sys, time
env = {e["Key"]: e["Value"] for e in json.load(open("/out/soong/ninja.environment"))}
t0 = time.time()
rc = subprocess.call(["/src/prebuilts/build-tools/linux-x86/bin/ninja", "-f", "/out/combined-redroid_x86_64.ninja",
                      "-j16", "-d", "keepdepfile", sys.argv[1]], cwd="/src", env=env)
print("NINJA_SEGUNDOS=%d rc=%d" % (time.time() - t0, rc))
sys.exit(rc)
PY
