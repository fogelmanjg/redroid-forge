# vaapi-daemon

Puerto directo del daemon de [`redroid-hwenc`](https://github.com/fogelmanjg/redroid-hwenc)
(tier5-vaapi-daemon), sin cambios de lógica — mismo binario, mismo protocolo. Ver el README
de ese proyecto para el diseño completo (por qué un daemon host-side en vez de VA-API nativo
dentro de Android, el protocolo del socket, y la tabla de compatibilidad por GPU).

Encode H.264 vía VA-API en AMD/Intel (`VAEntrypointEncSlice`) y decode H.264 vía NVDEC en
NVIDIA (`VAEntrypointVLD`, driver `nvidia-vaapi-driver`) — un solo proceso, dos backends
independientes, ninguno requerido para que el otro funcione.

## Build

```sh
make
```

Requiere headers de desarrollo de `libva`, `libva-drm`, `libgbm` y `libEGL` (ver Dockerfile
del backend para los paquetes exactos en la imagen de producción).

## Quién lo levanta

No se corre a mano — `backend/src/lib/hwAccel.js` lo lanza y supervisa como proceso hijo del
backend de redroid-forge (que corre `--privileged --pid=host --network=host`, ver
`docker-compose.yml`), y expone su socket (`/dev/vaapi-helper/socket`) bind-mounteado tanto
en el propio contenedor del backend como en cada instancia redroid que lo necesite — mismo
patrón que `binder.js` con `/dev/binderfs`.

## hwdec: decode por hardware vendor-agnóstico (paso 1, en desarrollo)

`hwdec.c`/`hwdec.h` son una sesión de decode por hardware con **libavcodec + VA-API**
(AMD y Intel; ver `docs/ROADMAP.md`, Fase 2, paso 5). Todavía **no está cableada al daemon**
(eso es el paso 2): hoy es una librería con su cliente de prueba `hwdec-test`.

Reglas de diseño:
- **Se usa por hardware todo lo que el host ofrezca.** `hwdec_probe()` pregunta a VA-API qué
  decodifica el nodo DRM (sin libavcodec) y `hwdec_open()` solo abre sesiones de esos códecs.
- **Nunca hay fallback silencioso a software.** Si el hardware no puede con el stream, la
  sesión falla y quien llama cae a su decoder por software.
- **Sesión con estado:** un access unit por `hwdec_send()`; `hwdec_receive()` devuelve los
  frames ya reordenados (B-frames), de a uno. Salida NV12 (8 bits) o P010 (10 bits) compacta.

### Probarlo (en cualquier host con Docker y `/dev/dri`)

```sh
cd backend/native/vaapi-daemon
docker run --rm --device /dev/dri -v "$PWD":/src -v /ruta/a/clips:/clips:ro -w /src alpine:latest sh -c '
  apk add -q --no-cache build-base pkgconf ffmpeg ffmpeg-dev libva-dev libva-utils \
      mesa-va-gallium intel-media-driver &&
  cp -r /src /build && cd /build && make hwdec-test &&
  ./hwdec-test --probe &&
  ./test/hwdec-verify.sh /dev/dri/renderD128 /clips/*'
```

`hwdec-verify.sh` decodifica cada clip por software (ffmpeg) y por hardware (`hwdec-test`) y
compara frame a frame en el orden de salida. **Ojo:** el `cpu=` que imprime incluye el hash
MD5 y la descarga de cada frame a RAM (en 4K de 10 bits son ~25 MB por frame), así que **no
mide el costo del decode**; la medición de CPU de verdad va con el paso 2 (sin copia).

Para este experimento se usa el FFmpeg de Alpine, compilado con `--enable-gpl`: sirve para
probar, pero **no se distribuye**. La imagen del proyecto compilará su propio libavcodec LGPL.

### Resultados (06/10/2026)

Clips: H.264 High con B-frames y 4 referencias (720p30 y 1080p30), HEVC Main10 HDR10 2160p30,
VP9 perfil 2 (10 bits) 2160p30. `✓` = todos los frames idénticos al software.

| GPU (driver) | H.264 720p | H.264 1080p | HEVC 4K 10 bits | VP9 4K 10 bits |
|---|---|---|---|---|
| Polaris RX 480 (radeonsi) | ✓ | ✓ | ✓ | rechazado: no hay hardware |
| Iris Xe (iHD) | ✓ | ✓ | ✓ | ✓ |
| Vega 8 del 5700G (radeonsi) | ✓ | ✓ | ✓ | ✓ |

Lo que `hwdec_probe()` anuncia por GPU: Polaris: h264, hevc (+10), mpeg2, vc1. Vega 8:
h264, hevc (+10), vp9 (+10), mpeg2, vc1. Iris Xe (iHD 26.2): h264, hevc (+10), vp9 (+10),
vp8, mpeg2, vc1, **av1** (+10); AV1 y VP8 están **anunciados pero sin probar** (no hay clips).

