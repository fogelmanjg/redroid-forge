#!/bin/bash
# Syncs redroid-forge's Android code with the AOSP tree and builds a module inside
# the build container (redroid-build-persist). Usage: android/build.sh <module> [log]
#
# Notes learned on 06/10/2026:
#  - Soong's ANALYSIS (repeated every time an Android.bp changes) reached more than 20 GB of RAM
#    and took ~20 min with the full tree: the container needs a roomy memory cap
#    (30 GB was used) so that, if something overshoots, the kernel kills the build and not other host processes.
#  - Changing only .cpp/.h files does NOT repeat the analysis: iterate on the code, not on the .bp files.
set -euo pipefail
AOSP=${AOSP_DIR:-$HOME/aosp-redroid-15}
HERE=$(cd "$(dirname "$0")" && pwd)
MOD=${1:?usage: android/build.sh <module> [log]}
LOG=${2:-/dev/stdout}

mkdir -p "$AOSP/external/vaapi_codec2"
rsync -a "$HERE/vaapi_codec2/" "$AOSP/external/vaapi_codec2/"
# protocol.h: a single source of truth, the daemon's (the Android component includes it as is).
cp "$HERE/../backend/native/vaapi-daemon/protocol.h" "$AOSP/external/vaapi_codec2/component/protocol.h"

# Soong's analysis reached >37 GB because Go's garbage collector does not know the container's cap
# and lets the heap grow up to twice the live size. Soong launches soong_build with `env -i`
# (which clears GOMEMLIMIT), so the binary is wrapped in a script that sets it: with GOMEMLIMIT=26GiB the
# analysis went from dying of lack of memory (20+ min lost) to finishing in ~2.5 min. Idempotent:
# if Soong rebuilds soong_build, the new binary is an ELF again and gets wrapped again.
docker exec -u jgustavo redroid-build-persist sh -c '
B=/out/host/linux-x86/bin
if file $B/soong_build | grep -q ELF; then
  cp -p $B/soong_build $B/soong_build.real
  printf "#!/bin/sh\nexec env GOMEMLIMIT=26GiB GOGC=50 $B/soong_build.real \"\$@\"\n" > $B/soong_build.wrapper
  chmod 755 $B/soong_build.wrapper && mv $B/soong_build.wrapper $B/soong_build
fi'

docker exec -u jgustavo -e HOME=/home/jgustavo -e USER=jgustavo redroid-build-persist bash -c "
set -e
cd /src
. build/envsetup.sh >/dev/null 2>&1
lunch redroid_x86_64-ap3a-userdebug >/dev/null 2>&1
export OUT_DIR=/out GOMAXPROCS=8
start=\$(date +%s)
m -j16 $MOD 2>&1 | tail -n 400
echo BUILD_SECONDS=\$((\$(date +%s)-start))
" > "$LOG" 2>&1
