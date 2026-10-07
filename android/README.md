# Código de Android de redroid-forge (Codec2)

`vaapi_codec2/` es el servicio Codec2 (`android.hardware.media.c2-vaapi-service`) que corre **dentro**
de la instancia Android y habla con el daemon VA-API del host por el socket
`/dev/vaapi-helper/socket` (protocolo en `backend/native/vaapi-daemon/protocol.h`):

- `component/VaapiEncComponent.*`: encoder H.264 (`c2.hardware.encoder.h264`).
- `component/VaapiDecComponent.*`: decoders por hardware `c2.hardware.decoder.{h264,hevc,vp9}`,
  una sesión persistente por componente (protocolo hwdec v2), con salida demorada para B-frames.
- `service/`: el servicio, su `.rc`, el manifest VINTF y la política seccomp.
- `test-client/`: herramientas de prueba (`real_gralloc_*`, `vaapi_daemon_test_client`).

El código **se compila dentro del árbol de AOSP** (`~/aosp-redroid-15/external/vaapi_codec2`, 142 GB) en el
contenedor `redroid-build-persist`. Los scripts de esta carpeta sincronizan este código al árbol y compilan.

## Dos formas de compilar (leer esto antes de tocar nada)

| Script | Cuándo | Costo |
|---|---|---|
| `android/ninja.sh <ruta-en-/out>` | Cambiaste solo `.cpp`/`.h` ya listados en un `Android.bp` | **~13 s** |
| `android/build.sh <modulo>` | Agregaste un archivo fuente, un módulo o tocaste un `Android.bp` | **~5 min** (análisis de Soong ~2,5 min + compilar), memoria acotada por `GOMEMLIMIT` |

`ninja.sh` salta Soong llamando a `ninja` directo sobre el archivo combinado que dejó la última compilación
completa. Salida típica del servicio: `/out/target/product/redroid_x86_64/vendor/bin/hw/android.hardware.media.c2-vaapi-service`.

### Trampas aprendidas el 06/10/2026
- **Compilar siempre como `jgustavo`** (los scripts ya usan `docker exec -u jgustavo`). Como root, Soong ve otro
  `BUILD_USERNAME` y rehace TODO el análisis, y deja archivos de root en `/out` que luego bloquean al usuario normal.
- **El análisis de Soong se comía >37 GB** porque el recolector de basura de Go no conoce el tope del contenedor y deja
  crecer el heap hasta el doble de lo vivo. `build.sh` envuelve `soong_build` en un script que fija `GOMEMLIMIT=26GiB`
  (Soong lo lanza con `env -i`, así que no alcanza con exportarlo): el análisis pasó de morir a terminar en ~2,5 min.
  Igual conviene un tope de memoria en el contenedor (`docker update --memory 36g --memory-swap 36g ...`) para que, si algo
  se pasa, el kernel mate al build y no a otros procesos del host.
- **No usar `rsync --delete`** hacia el árbol de AOSP: borraría archivos que solo existen allá.
- **No recorrer `/out` con `find`** (105 GB): se cuelga.
- `docker exec` necesita `-i` para leer un script por stdin.
