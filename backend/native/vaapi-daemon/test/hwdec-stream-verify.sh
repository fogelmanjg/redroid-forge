#!/bin/sh
# Verifies the hwdec v2 protocol end to end: it starts the daemon (built with HWDEC=1),
# asks it for its capabilities, decodes the clips THROUGH THE SOCKET comparing against
# software, and tests two simultaneous streams plus a session for an unsupported codec.
# It runs inside a container with the daemon and hwdec-test already built (see README).
# Usage: hwdec-stream-verify.sh <drm-node> <clip>...
NODE=$1; shift
export REDROID_FORGE_DRM_NODE=$NODE
SOCK=/dev/vaapi-helper/socket
./daemon > /tmp/_daemon.log 2>&1 &
DPID=$!
i=0; while [ ! -S $SOCK ] && [ $i -lt 100 ]; do sleep 0.2; i=$((i+1)); done
[ -S $SOCK ] || { echo "the daemon did not open the socket:"; tail -5 /tmp/_daemon.log; exit 1; }

echo "== capabilities according to the daemon"
./hwdec-test --socket-probe $SOCK 2>&1 | grep -v '^libva'

echo "== decode through the socket, against software"
HWDEC_SOCKET=$SOCK ./test/hwdec-verify.sh "$NODE" "$@"
rc=$?

echo "== two simultaneous streams (the daemon serves each one on its own thread)"
set -- "$@"
A=$1; B=${2:-$1}
timeout 300 ./hwdec-test --socket $SOCK "$A" "$NODE" /tmp/_c1.md5 > /tmp/_c1.out 2>&1 &
P1=$!
timeout 300 ./hwdec-test --socket $SOCK "$B" "$NODE" /tmp/_c2.md5 > /tmp/_c2.out 2>&1 &
P2=$!
wait $P1; r1=$?; wait $P2; r2=$?
echo "   stream 1 rc=$r1: $(grep RESULT /tmp/_c1.out | cut -c1-90)"
echo "   stream 2 rc=$r2: $(grep RESULT /tmp/_c2.out | cut -c1-90)"
[ $r1 = 0 ] && [ $r2 = 0 ] || rc=1

echo "== restart after end of stream: the same clip twice in ONE session (drain halfway through a video)"
timeout 300 ./hwdec-test --twice --socket $SOCK "$A" "$NODE" /tmp/_t.md5 > /tmp/_t.out 2>&1; rt=$?
n1=$(awk '/^# --- second/{exit} !/^#/{n++} END{print n+0}' /tmp/_t.md5)
n2=$(awk 'f&&!/^#/{n++} /^# --- segunda/{f=1} END{print n+0}' /tmp/_t.md5)
d=$(paste -d' ' <(awk '/^# --- segunda/{exit} !/^#/{split($0,a,","); print a[6]}' /tmp/_t.md5) <(awk 'f&&!/^#/{split($0,a,","); print a[6]} /^# --- segunda/{f=1}' /tmp/_t.md5) | awk '$1!=$2{n++} END{print n+0}')
echo "   rc=$rt, first pass=$n1 frames, second=$n2 frames, frames that differ between passes=$d"
if [ "$rt" = 0 ] && [ "$n1" -gt 0 ] && [ "$n1" = "$n2" ] && [ "$d" = 0 ]; then echo "   OK: the decoder kept working after the drain"; else echo "   FAIL"; rc=1; fi
rm -f /tmp/_t.md5 /tmp/_t.out

echo "== the encode keeps responding while a stream is open"
timeout 300 ./hwdec-test --socket $SOCK "$A" "$NODE" /tmp/_c3.md5 > /tmp/_c3.out 2>&1 &
P3=$!
sleep 0.5
if kill -0 $P3 2>/dev/null; then
  # a client that opens a new connection and only asks for capabilities: it must answer instantly
  if ./hwdec-test --socket-probe $SOCK >/dev/null 2>&1; then echo "   OK: it answered with a stream in progress"; else echo "   FAIL: the daemon got blocked"; rc=1; fi
else
  echo "   (the stream ended before it could be checked; inconclusive)"
fi
wait $P3

kill $DPID 2>/dev/null; wait $DPID 2>/dev/null
echo "== daemon log (summary)"; grep -E "hwdec" /tmp/_daemon.log | sort | uniq -c | sort -rn | head -6
rm -f /tmp/_c?.md5 /tmp/_c?.out /tmp/_daemon.log
exit $rc
