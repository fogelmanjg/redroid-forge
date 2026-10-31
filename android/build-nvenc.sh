#!/bin/bash
# Same build pipeline as build.sh, for external/nvenc_codec2 instead of external/vaapi_codec2 --
# see android/README.md for the traps (GOMEMLIMIT, build as jgustavo, no rsync --delete, etc.),
# all of which apply here unchanged. Usage: android/build-nvenc.sh <module> [log]
set -euo pipefail
AOSP=${AOSP_DIR:-$HOME/aosp-redroid-15}
HERE=$(cd "$(dirname "$0")" && pwd)
MOD=${1:?usage: android/build-nvenc.sh <module> [log]}
LOG=${2:-/dev/stdout}

mkdir -p "$AOSP/external/nvenc_codec2"
rsync -a "$HERE/nvenc_codec2/" "$AOSP/external/nvenc_codec2/"
# nvenc_scm_protocol.h: single source of truth, same convention as vaapi's protocol.h in
# build.sh -- the host daemon (backend/native/nvenc-daemon) includes the exact same file.
cp "$HERE/../backend/native/nvenc-daemon/nvenc_scm_protocol.h" "$AOSP/external/nvenc_codec2/component/nvenc_scm_protocol.h"

docker exec -u jgustavo redroid-build-persist sh -c '
B=/out/host/linux-x86/bin
if file $B/soong_build | grep -q ELF; then
  cp -p $B/soong_build $B/soong_build.real
  printf "#!/bin/sh\nexec env GOMEMLIMIT=26GiB GOGC=50 $B/soong_build.real \"\$@\"\n" > $B/soong_build.wrapper
  chmod 755 $B/soong_build.wrapper && mv $B/soong_build.wrapper $B/soong_build
fi'

docker exec -u jgustavo -e HOME=/home/jgustavo -e USER=jgustavo redroid-build-persist bash -c "
set -e
ulimit -n 65536
cd /src
. build/envsetup.sh >/dev/null 2>&1
lunch redroid_x86_64-ap3a-userdebug >/dev/null 2>&1
export OUT_DIR=/out GOMAXPROCS=8
start=\$(date +%s)
m -j16 $MOD 2>&1 | tail -n 400
echo BUILD_SECONDS=\$((\$(date +%s)-start))
" > "$LOG" 2>&1
