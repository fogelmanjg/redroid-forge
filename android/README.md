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
| `android/build.sh <modulo>` | Agregaste un archivo fuente, un módulo o tocaste un `Android.bp` | **~20+ min y >30 GB de RAM** (análisis de Soong) |

`ninja.sh` salta Soong llamando a `ninja` directo sobre el archivo combinado que dejó la última compilación
completa. Salida típica del servicio: `/out/target/product/redroid_x86_64/vendor/bin/hw/android.hardware.media.c2-vaapi-service`.

### Trampas aprendidas el 06/10/2026
- **Compilar siempre como `jgustavo`** (los scripts ya usan `docker exec -u jgustavo`). Como root, Soong ve otro
  `BUILD_USERNAME` y rehace TODO el análisis, y deja archivos de root en `/out` que luego bloquean al usuario normal.
- **El análisis de Soong necesita >30 GB.** El contenedor debe tener un tope de memoria (`docker update --memory ...`)
  para que, si algo se pasa, el kernel mate al build y no a otros procesos del host. Con 20 GB murió; con 30 GB quedó al límite.
- **No usar `rsync --delete`** hacia el árbol de AOSP: borraría archivos que solo existen allá.
- **No recorrer `/out` con `find`** (105 GB): se cuelga.
- `docker exec` necesita `-i` para leer un script por stdin.
