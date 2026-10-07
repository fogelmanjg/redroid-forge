#!/bin/bash
# End-to-end test of hardware decode INSIDE an Android instance, through MediaCodec.
# It compares, frame by frame, Android's software decoder (the control, it has to match ffmpeg)
# against our hardware decoder. It runs from server01 against a test host over ssh.
#
#   run_on_instance.sh <host-ssh> <contenedor> <binario hwdec_mediacodec_test> [codecs...]
#   codecs: h264 hevc vp9 (by default, the ones the host offers according to the daemon)
set -u
HOST=${1:?ssh host}; CONT=${2:?container}; TOOL=${3:?hwdec_mediacodec_test binary}; shift 3
CODECS=${*:-"h264 hevc vp9"}
HERE=$(cd "$(dirname "$0")" && pwd)
W=/tmp/hwdec-android

ssh "$HOST" "mkdir -p $W" && scp -q "$TOOL" "$HERE/verify_mediacodec.py" "$HOST:$W/" || exit 1
ssh "$HOST" "cd $W && chmod +x hwdec_mediacodec_test && ffmpeg -v error -y -f lavfi -i mandelbrot=size=1280x720:rate=30:maxiter=400 -t 10 -c:v libx264 -profile:v high -bf 3 -refs 4 -b:v 4M -g 60 -pix_fmt yuv420p h264_720.mp4 && ffmpeg -v error -y -f lavfi -i mandelbrot=size=1920x1080:rate=30:maxiter=400 -t 6 -c:v libx264 -profile:v high -bf 3 -refs 4 -b:v 8M -g 60 -pix_fmt yuv420p h264_1080.mp4 && ffmpeg -v error -y -f lavfi -i mandelbrot=size=1920x1080:rate=30:maxiter=400 -t 6 -c:v libx265 -x265-params log-level=error:bframes=3 -b:v 6M -g 60 -pix_fmt yuv420p hevc_1080.mp4 && ffmpeg -v error -y -f lavfi -i mandelbrot=size=1280x720:rate=30:maxiter=400 -t 8 -c:v libvpx-vp9 -deadline realtime -cpu-used 8 -b:v 3M -g 60 -pix_fmt yuv420p vp9_720.webm && ffmpeg -v error -y -f lavfi -i mandelbrot=size=1920x1080:rate=30:maxiter=400 -t 5 -c:v libx265 -x265-params log-level=error:bframes=3 -b:v 6M -g 60 -pix_fmt yuv420p10le hevc10_1080.mp4 && ffmpeg -v error -y -f lavfi -i mandelbrot=size=1280x720:rate=30:maxiter=400 -t 5 -c:v libvpx-vp9 -deadline realtime -cpu-used 8 -b:v 3M -g 60 -pix_fmt yuv420p10le vp9p2_720.webm" || exit 1

ssh "$HOST" "docker exec $CONT mkdir -p /data/local/tmp/t && docker cp $W/hwdec_mediacodec_test $CONT:/data/local/tmp/t/ && docker exec $CONT chmod 755 /data/local/tmp/t/hwdec_mediacodec_test" || exit 1

run() {   # <clip> <component> <label>
  local clip=$1 comp=$2 label=$3 mode=${4:-}
  ssh "$HOST" "docker cp $W/$clip $CONT:/data/local/tmp/t/$clip && docker exec $CONT sh -c 'cd /data/local/tmp/t && timeout 180 ./hwdec_mediacodec_test $clip $comp out.txt' 2>&1 | grep RESULT | cut -c1-150; docker cp $CONT:/data/local/tmp/t/out.txt $W/out_$label.txt 2>/dev/null; python3 $W/verify_mediacodec.py $W/$clip $W/out_$label.txt $mode 2>&1 | sed 's/^/      /'"
}
# The 10-bit clips (hevc10, vp9p2) are requested as 8-bit I420: the decoder keeps the high 8 bits
# (redroid's gralloc does not allocate P010), and the reference does the same. There is no software control: Android's
# own round differently, so only the hardware is verified.
declare -A CLIPS=([h264]="h264_720.mp4 h264_1080.mp4" [hevc]="hevc_1080.mp4 hevc10_1080.mp4" [vp9]="vp9_720.webm vp9p2_720.webm")
declare -A SW=([h264]=OMX.google.h264.decoder [hevc]=OMX.google.hevc.decoder [vp9]=OMX.google.vp9.decoder)
for c in $CODECS; do
  for clip in ${CLIPS[$c]}; do
    echo "== $c / $clip"
    mode=""; case "$clip" in hevc10_*|vp9p2_*) mode=trunc8;; esac
    [ -z "$mode" ] && { echo "   control (Android software through ACodec, ${SW[$c]}):"; run "$clip" "${SW[$c]}" "sw_${c}_${clip%%.*}"; }
    echo "   hardware (c2.hardware.decoder.$c):";         run "$clip" "c2.hardware.decoder.$c" "hw_${c}_${clip%%.*}" "$mode"
  done
done
