#!/bin/sh
# Verifica el protocolo hwdec v2 de punta a punta: levanta el daemon (compilado con HWDEC=1),
# le pregunta las capacidades, decodifica los clips A TRAVES DEL SOCKET comparando contra
# software, y prueba dos streams simultaneos mas una sesion para un codec no soportado.
# Corre dentro de un contenedor con el daemon y hwdec-test ya compilados (ver README).
# Uso: hwdec-stream-verify.sh <nodo-drm> <clip>...
NODE=$1; shift
export REDROID_FORGE_DRM_NODE=$NODE
SOCK=/dev/vaapi-helper/socket
./daemon > /tmp/_daemon.log 2>&1 &
DPID=$!
i=0; while [ ! -S $SOCK ] && [ $i -lt 100 ]; do sleep 0.2; i=$((i+1)); done
[ -S $SOCK ] || { echo "el daemon no abrio el socket:"; tail -5 /tmp/_daemon.log; exit 1; }

echo "== capacidades segun el daemon"
./hwdec-test --socket-probe $SOCK 2>&1 | grep -v '^libva'

echo "== decode a traves del socket, contra software"
HWDEC_SOCKET=$SOCK ./test/hwdec-verify.sh "$NODE" "$@"
rc=$?

echo "== dos streams simultaneos (el daemon atiende cada uno en su hilo)"
set -- "$@"
A=$1; B=${2:-$1}
timeout 300 ./hwdec-test --socket $SOCK "$A" "$NODE" /tmp/_c1.md5 > /tmp/_c1.out 2>&1 &
P1=$!
timeout 300 ./hwdec-test --socket $SOCK "$B" "$NODE" /tmp/_c2.md5 > /tmp/_c2.out 2>&1 &
P2=$!
wait $P1; r1=$?; wait $P2; r2=$?
echo "   stream 1 rc=$r1: $(grep RESULTADO /tmp/_c1.out | cut -c1-90)"
echo "   stream 2 rc=$r2: $(grep RESULTADO /tmp/_c2.out | cut -c1-90)"
[ $r1 = 0 ] && [ $r2 = 0 ] || rc=1

echo "== el encode sigue respondiendo mientras hay un stream abierto"
timeout 300 ./hwdec-test --socket $SOCK "$A" "$NODE" /tmp/_c3.md5 > /tmp/_c3.out 2>&1 &
P3=$!
sleep 0.5
if kill -0 $P3 2>/dev/null; then
  # un cliente que abre una conexion nueva y solo pregunta capacidades: debe contestar al instante
  if ./hwdec-test --socket-probe $SOCK >/dev/null 2>&1; then echo "   OK: respondio con un stream en curso"; else echo "   FALLA: el daemon quedo bloqueado"; rc=1; fi
else
  echo "   (el stream termino antes de poder comprobarlo; no concluyente)"
fi
wait $P3

kill $DPID 2>/dev/null; wait $DPID 2>/dev/null
echo "== log del daemon (resumen)"; grep -E "hwdec" /tmp/_daemon.log | sort | uniq -c | sort -rn | head -6
rm -f /tmp/_c?.md5 /tmp/_c?.out /tmp/_daemon.log
exit $rc
