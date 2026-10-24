# Tips de scrcpy — los problemas típicos de arranque y los atajos que vale la pena conocer

**Idiomas:** [English](SCRCPY-TIPS.md) | Español

Los docs de scrcpy son la referencia real — esta página solo señala lo poco que efectivamente
molesta la primera vez, específicamente contra una instancia redroid, más los atajos que de verdad
se usan. Referencia completa:
[shortcuts.md](https://github.com/Genymobile/scrcpy/blob/master/doc/shortcuts.md),
[audio.md](https://github.com/Genymobile/scrcpy/blob/master/doc/audio.md),
[video.md](https://github.com/Genymobile/scrcpy/blob/master/doc/video.md).

## Problemas típicos de arranque

| Síntoma | Por qué | Solución |
|---|---|---|
| Sin audio, o scrcpy imprime `Failed to initialize audio/opus` | El codec de audio default de scrcpy es **Opus**, y redroid no tiene encoder de Opus | Agregar `--audio-codec=aac` (ya es el default en `scripts/connect.sh`/`.ps1`) |
| El audio anda y después se corta solo, el video sigue | La captura de audio falló después de arrancar; por defecto scrcpy no lo trata como error fatal | Agregar `--require-audio` si preferís que falle en vez de seguir sin sonido |
| Nada de audio, con ningún codec | La captura de audio necesita Android 11+; está deshabilitada en imágenes más viejas | Nada que hacer — usar `--no-audio` y no perseguirlo |
| Video entrecortado, errores de decodificación, o scrcpy cae solo a software | El decode por hardware (`--hwdec=auto`, el default) falló para esa combinación de GPU/driver | Probar `--hwdec=disabled` (decode por software directo) |
| Imagen pixelada/bloques, o la conexión no llega | El bitrate default es 8 Mbps — demasiado para un link lento/compartido | `--video-bit-rate=4M` o `2M` (los scripts de conexión ya lo ofrecen como opción de menú) |
| Latencia alta, se siente demorado | H.265 cuesta más latencia que H.264 por una ganancia de calidad marginal acá | Quedarse con el default `--video-codec=h264` |

**Verificado en instancias redroid reales** (con `scrcpy --list-encoders`, chequeado contra una
imagen Android 11 y una Android 15): los únicos encoders de audio presentes son **AAC** y
**FLAC** — no hay ningún encoder de Opus ni Vorbis, en ninguna de las dos versiones. Si
`--audio-codec=aac` no alcanza por algún motivo, `--audio-codec=raw` (PCM sin comprimir) es un
fallback que no necesita ningún encoder del dispositivo, a costa de ancho de banda. Encoders de
video presentes: `h264`, `vp8`, `vp9` (sin h265/av1).

## Atajos que vale la pena conocer (MOD = Alt izquierdo **o** Super/Win izquierdo, por defecto)

| Atajo | Acción |
|---|---|
| `MOD+F` | Pantalla completa |
| `MOD+H` o clic del medio | HOME |
| `MOD+B`, `MOD+Backspace`, o clic derecho | BACK (el clic derecho también despierta la pantalla si está apagada) |
| `MOD+S` | Apps recientes |
| `MOD+Up` / `MOD+Down` | Subir / bajar volumen |
| `MOD+O` / `MOD+Shift+O` | Apagar / encender la pantalla del dispositivo (el espejado sigue andando igual — útil para ahorrar energía sin desconectar) |
| `MOD+R` | Rotar el dispositivo |
| `MOD+C` / `MOD+V` | Copiar / pegar el portapapeles entre la compu y el dispositivo |
| `MOD+G` | Redimensionar la ventana 1:1 (pixel-perfect) |
| Arrastrar un archivo a la ventana | Lo instala si es un APK, lo sube al dispositivo si no |

No existe un atajo de "sacudir el dispositivo" en scrcpy — si pensabas en eso, probablemente sea un
gesto propio de alguna app de Android (el "sacudir para deshacer" nativo) que scrcpy simplemente
reenvía como movimiento normal, o una confusión con otra cosa; decinos qué era exactamente y lo
documentamos bien. Lo más parecido que trae scrcpy son `MOD+Shift+Left`/`Right` (espejar
horizontal) y `MOD+Shift+Up`/`Down` (espejar vertical) — eso cambia la vista de scrcpy, no el
dispositivo real.

La lista completa (simulación de gestos pinch-to-zoom/inclinación, modo cámara, teclado/gamepad
HID, etc.) está en
[shortcuts.md](https://github.com/Genymobile/scrcpy/blob/master/doc/shortcuts.md).
