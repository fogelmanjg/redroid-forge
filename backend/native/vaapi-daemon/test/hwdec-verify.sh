#!/bin/sh
# Verifica la sesion hwdec contra la decodificacion por software de ffmpeg:
# mismo numero de frames, mismo orden de salida, MD5 identico en cada uno.
# Corre dentro de un contenedor con: ffmpeg, el hwdec-test compilado y el driver
# VA-API del host (ver README). Uso: hwdec-verify.sh <nodo-drm> <clip>...
NODE=$1; shift
ok=0; fail=0; skip=0
for f in "$@"; do
  name=$(basename "$f")
  pf=$(ffprobe -v error -select_streams v -show_entries stream=pix_fmt -of csv=p=0 "$f")
  case "$pf" in *10*) out_fmt=p010le ;; *) out_fmt=nv12 ;; esac
  # -y y rm previos: sin esto ffmpeg no sobrescribe y se compara contra el clip anterior.
  rm -f /tmp/_sw.md5 /tmp/_hw.md5
  ffmpeg -v error -y -threads 1 -i "$f" -f framemd5 -pix_fmt $out_fmt /tmp/_sw.md5 2>/dev/null
  [ -s /tmp/_sw.md5 ] || { echo "ERROR         $name: no se pudo generar la referencia por software"; fail=$((fail+1)); continue; }
  # HWDEC_SOCKET=<ruta>: la misma verificacion pero a traves del daemon (protocolo v2).
  if [ -n "$HWDEC_SOCKET" ]; then
    timeout 300 ./hwdec-test --socket "$HWDEC_SOCKET" "$f" "$NODE" /tmp/_hw.md5 > /tmp/_hw.out 2>&1; rc=$?
  else
    timeout 300 ./hwdec-test "$f" "$NODE" /tmp/_hw.md5 > /tmp/_hw.out 2>&1; rc=$?
  fi
  if [ $rc -ne 0 ]; then
    echo "SIN HARDWARE  $name: $(grep -E 'RESULTADO|no decodifica|hwdec:' /tmp/_hw.out | head -1 | cut -c1-110)"
    skip=$((skip+1)); continue
  fi
  S=$(grep -vc '^#' /tmp/_sw.md5); H=$(grep -vc '^#' /tmp/_hw.md5)
  D=$(paste -d' ' /tmp/_sw.md5 /tmp/_hw.md5 | grep -v '^#' | awk '{split($1,a,","); split($2,b,","); if (a[6]!=b[6]) n++} END{print n+0}')
  if [ "$S" -gt 0 ] && [ "$S" = "$H" ] && [ "$D" = 0 ]; then
    echo "OK            $name: $H frames idénticos (orden de salida incluido) | $(grep RESULTADO /tmp/_hw.out | sed "s/.*cpu=/cpu=/") (incluye hash MD5 y descarga a RAM)"
    ok=$((ok+1))
  else
    echo "FALLA         $name: sw=$S frames, hw=$H frames, distintos=$D"
    fail=$((fail+1))
  fi
done
rm -f /tmp/_sw.md5 /tmp/_hw.md5 /tmp/_hw.out
echo "== ok=$ok falla=$fail sin-hardware=$skip"
[ "$fail" = 0 ]
