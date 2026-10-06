#!/bin/bash
# Sincroniza el codigo de Android de redroid-forge con el arbol de AOSP y compila un modulo dentro
# del contenedor de build (redroid-build-persist). Uso: android/build.sh <modulo> [log]
#
# Notas aprendidas el 06/10/2026:
#  - El ANALISIS de Soong (se repite cada vez que cambia un Android.bp) llego a mas de 20 GB de RAM
#    y tardo ~20 min con el arbol completo: el contenedor necesita un tope de memoria holgado
#    (se uso 30 GB) para que, si algo se pasa, el kernel mate al build y no a otros procesos del host.
#  - Cambiar solo archivos .cpp/.h NO repite el analisis: iterar sobre el codigo, no sobre los .bp.
set -euo pipefail
AOSP=${AOSP_DIR:-$HOME/aosp-redroid-15}
HERE=$(cd "$(dirname "$0")" && pwd)
MOD=${1:?uso: android/build.sh <modulo> [log]}
LOG=${2:-/dev/stdout}

mkdir -p "$AOSP/external/vaapi_codec2"
rsync -a "$HERE/vaapi_codec2/" "$AOSP/external/vaapi_codec2/"
# protocol.h: una sola fuente de verdad, la del daemon (el componente de Android la incluye tal cual).
cp "$HERE/../backend/native/vaapi-daemon/protocol.h" "$AOSP/external/vaapi_codec2/component/protocol.h"

docker exec -u jgustavo -e HOME=/home/jgustavo -e USER=jgustavo redroid-build-persist bash -c "
set -e
cd /src
. build/envsetup.sh >/dev/null 2>&1
lunch redroid_x86_64-ap3a-userdebug >/dev/null 2>&1
export OUT_DIR=/out GOMAXPROCS=8
start=\$(date +%s)
m -j16 $MOD 2>&1 | tail -n 400
echo BUILD_SEGUNDOS=\$((\$(date +%s)-start))
" > "$LOG" 2>&1
