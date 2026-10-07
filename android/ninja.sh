#!/bin/bash
# Compila SOLO con ninja, sin pasar por Soong (ni su analisis de ~20 min y >30 GB de RAM).
# Sirve mientras solo cambien archivos .cpp/.h ya listados en un Android.bp existente: ninja
# reconstruye lo que cambio. Si se agrega un archivo fuente o se toca un Android.bp, hay que
# pasar una vez por android/build.sh (que corre Soong) para regenerar los .ninja.
#
# Uso: android/ninja.sh <ruta-de-salida-dentro-de-/out> [log]
#   ej. android/ninja.sh /out/target/product/redroid_x86_64/vendor/bin/hw/android.hardware.media.c2-vaapi-service
#
# Importante: corre como `jgustavo` (el usuario del ultimo build bueno). Como root, Soong detecta otro
# usuario de compilacion y rehace todo el analisis; ademas deja archivos de root en /out.
set -euo pipefail
AOSP=${AOSP_DIR:-$HOME/aosp-redroid-15}
HERE=$(cd "$(dirname "$0")" && pwd)
TARGET=${1:?uso: android/ninja.sh <ruta-de-salida-en-/out> [log]}
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
