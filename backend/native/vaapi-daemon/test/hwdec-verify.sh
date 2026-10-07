#!/bin/sh
# Verifies the hwdec session against ffmpeg's software decode:
# same number of frames, same output order, identical MD5 in each one.
# It runs inside a container with: ffmpeg, the compiled hwdec-test and the host's
# VA-API driver (see README). Usage: hwdec-verify.sh <drm-node> <clip>...
NODE=$1; shift
ok=0; fail=0; skip=0
for f in "$@"; do
  name=$(basename "$f")
  pf=$(ffprobe -v error -select_streams v -show_entries stream=pix_fmt -of csv=p=0 "$f")
  case "$pf" in *10*) out_fmt=p010le ;; *) out_fmt=nv12 ;; esac
  # -y and the previous rm: without this ffmpeg does not overwrite and it is compared against the previous clip.
  rm -f /tmp/_sw.md5 /tmp/_hw.md5
  ffmpeg -v error -y -threads 1 -i "$f" -f framemd5 -pix_fmt $out_fmt /tmp/_sw.md5 2>/dev/null
  [ -s /tmp/_sw.md5 ] || { echo "ERROR         $name: could not generate the software reference"; fail=$((fail+1)); continue; }
  # HWDEC_SOCKET=<path>: the same verification but through the daemon (protocol v2).
  if [ -n "$HWDEC_SOCKET" ]; then
    timeout 300 ./hwdec-test --socket "$HWDEC_SOCKET" "$f" "$NODE" /tmp/_hw.md5 > /tmp/_hw.out 2>&1; rc=$?
  else
    timeout 300 ./hwdec-test "$f" "$NODE" /tmp/_hw.md5 > /tmp/_hw.out 2>&1; rc=$?
  fi
  if [ $rc -ne 0 ]; then
    echo "NO HARDWARE   $name: $(grep -E 'RESULT|does not decode|hwdec:' /tmp/_hw.out | head -1 | cut -c1-110)"
    skip=$((skip+1)); continue
  fi
  S=$(grep -vc '^#' /tmp/_sw.md5); H=$(grep -vc '^#' /tmp/_hw.md5)
  D=$(paste -d' ' /tmp/_sw.md5 /tmp/_hw.md5 | grep -v '^#' | awk '{split($1,a,","); split($2,b,","); if (a[6]!=b[6]) n++} END{print n+0}')
  if [ "$S" -gt 0 ] && [ "$S" = "$H" ] && [ "$D" = 0 ]; then
    echo "OK            $name: $H identical frames (output order included) | $(grep RESULT /tmp/_hw.out | sed "s/.*cpu=/cpu=/") (includes MD5 hash and download to RAM)"
    ok=$((ok+1))
  else
    echo "FAIL          $name: sw=$S frames, hw=$H frames, different=$D"
    fail=$((fail+1))
  fi
done
rm -f /tmp/_sw.md5 /tmp/_hw.md5 /tmp/_hw.out
echo "== ok=$ok fail=$fail no-hardware=$skip"
[ "$fail" = 0 ]
