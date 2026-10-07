# redroid-forge — Roadmap de fases

> Complementa `REQUIREMENTS.md` (qué y por qué). Este documento es el cómo y
> en qué orden — sin tiempos estimados, cada fase con sus pasos concretos y
> una dificultad relativa. El **gate** es la condición para pasar a la
> siguiente fase, no una fecha.

## Fase 0 — Bootstrap del repo

**Dificultad: Baja** — todo el código ya existe y funciona, es reacomodo.

**Pasos:**
1. Crear el repo público en GitHub como `redroid-forge` (nombre confirmado —
   verificado libre en GitHub, npm y Docker Hub; ya alojado en
   `~/redroid-forge` localmente).
2. Agregar `LICENSE` (Apache-2.0), README mínimo, sección de créditos/
   atribución a redroid y a los proyectos de origen.
3. Armar la estructura de monorepo (`backend/`, `frontend/`, `docs/`).
4. Portar `redroid-manager` tal cual a esa estructura, sin reescribir
   lógica: ciclo de vida de instancias, Doctor, registro Android ID/GApps,
   `binder.js`/`hwsimWifi.js`/`androidIdentity.js`.

**Gate:** `docker compose up` en el repo nuevo da el mismo comportamiento
que `redroid-manager` hoy, corriendo desde la nueva ubicación.

## Fase 1 — Redroid 15 como tier oficial + tiers de soporte

**Dificultad: Baja** — es sumar un campo de metadata y checks ya
documentados, no descubrir nada nuevo. Ya no es "restringir", es declarar.

**Pasos:**
1. Agregar el campo `soporte` (`oficial`/`comunidad`) a cada entrada de
   `backend/images.json`. ✅ hecho.
2. Portar el checklist de prerrequisitos de host (binder legacy/binderfs,
   `loop`, `ext4`) como checks nuevos del Doctor. ✅ hecho (ext4 nuevo; el
   fix de binderfs ahora también documenta el fallback de binder legacy).
3. Mostrar el tier de la imagen elegida en la UI (badge oficial/comunidad).
   ✅ hecho, en el selector de creación de instancia.
4. Validar que el catálogo y el Doctor devuelven el tier correcto contra
   Docker real, y que ninguna imagen queda bloqueada por versión. ✅ hecho.
5. `compatibleCon` en el manifest de módulo (versión de Android, modo GPU)
   **se difiere a la Fase 4** — no tiene sentido construirlo antes de que
   exista el propio sistema de manifest/contrato que va a leerlo.

**Gate:** ciclo de vida completo de una instancia Redroid 15 (tier oficial)
funcionando de punta a punta solo con la nueva app; una instancia de
Redroid 11/13 (tier comunidad) se puede seguir creando sin bloqueo, con el
tier visible en la UI.

## Fase 2 — Aceleración por hardware (hwenc + nvidia)

**Dificultad: Alta** — dos daemons nativos ya complejos de por sí
(VA-API multi-vendor, Venus-proxy, NVENC), con quirks de driver ya
conocidos (ej. el artefacto de scanline en la 4060 con el driver
595.91.07) que hay que preservar/no reintroducir al integrar.

**Pasos:**
1. Portar `redroid-hwenc` (encode VA-API AMD/Intel + decode NVDEC) como
   componente que el backend puede lanzar/monitorear por instancia.
2. Portar `redroid-nvidia` (Venus-proxy 3D + NVENC) de la misma forma.
3. Sumar selección de modo GPU (host/soft) y detección de vendor al flujo
   de creación de instancia.
4. Validar en un host AMD/Intel real y en un host NVIDIA real.
   - ✅ **AMD Polaris (RX 480, jgustavo46) validado el 05/10/2026** con la
     imagen oficial `redroid/redroid:15.0.0-latest` + módulo hwenc: Doctor
     verde (binder legacy), daemon elige solo el import VA-API pre-modificador
     (Tier 5.12), encoder `c2.hardware.encoder.h264` registrado, `screenrecord`
     5 s = 74 frames H.264 con imagen correcta.
   - ✅ **Intel Iris Xe (TigerLake-LP, n02) validado el 05/10/2026**, misma
     imagen oficial + hwenc, binder legacy slot 0, instancia 1000x600 con tope
     de 3 GB (uso real ~1,6 GB): daemon con `iHD`, `screenrecord` a MP4 = 209
     frames H.264 válidos. Dos bugs reales encontrados y corregidos acá:
     (1) la imagen del backend no traía `intel-media-driver` (solo
     `mesa-va-gallium`, que cubre AMD/nouveau) y el daemon moría en
     `vaInitialize`; (2) `iHD` emite start codes Annex-B de **3 bytes** y
     radeonsi de 4, y el parser de CSD de `MPEG4Writer` exige 4 (abortaba con
     `FORTIFY: write: count -1`); el daemon ahora normaliza a 4 bytes. Falta NVIDIA.
5. **Decodificación por hardware (VA-API) en AMD e Intel** — objetivo
   agregado el 05/10/2026 (no es un port: es trabajo nuevo), con el alcance
   ampliado el 06/10/2026.

   **Principio (decidido 06/10/2026): cada instancia usa por hardware todo lo
   que el hardware del host ofrezca.** No hay un paquete único de capacidades:
   un host con Iris Xe decodifica H.264, HEVC (8/10/12 bits), VP9 y VP8; uno con
   Polaris, H.264 y HEVC; uno con Vega/Cezanne, H.264, HEVC y VP9; hardware más
   nuevo irá sumando (AV1, etc.). Eso es normal y se declara, no se oculta: el
   Doctor muestra qué códecs decodifica el host por hardware, y solo se
   registran en Android los decoders que el host soporta de verdad (mismo
   criterio que `compatibleCon` de los módulos). **El encode no se toca por
   ahora: se retoma después de terminar la primera versión.**

   Hoy el daemon en AMD/Intel **solo codifica**; el único decode que existe es
   el de NVIDIA (NVDEC vía `nvidia-vaapi-driver`, validado bit a bit solo en una
   GTX 1050 Ti) y solo decodifica **un frame intra suelto** (SPS + PPS + un slice
   IDR por pedido: sin referencias ni B-frames), o sea que es una prueba del
   mecanismo, no un decoder. Punto de partida, verificado leyendo el código:
   - `decode_h264_init()` fuerza `LIBVA_DRIVER_NAME=nvidia` y abre
     `/dev/dri/renderD128` fijo: en AMD/Intel nunca inicializa.
   - El módulo `hwenc` solo registra el encoder en `media_codecs.xml`, y su
     manifest solo se ofrece para hosts `amd`/`intel` (el componente
     `VaapiDecComponent` existe en el proyecto viejo, pero forge no lo conecta).

   **Medido el 06/10/2026** (ffmpeg + VA-API, decode puro, `-threads 1` en
   software; 0 frames distintos contra software en todos los casos):
   720p30 High con B-frames: Polaris 1,77 s de CPU por software contra 0,33 s por
   hardware; Iris Xe 4,56 s contra 0,49 s. 2160p30 10 bits (5 s): HEVC Main10 HDR10
   Polaris ×14, Iris Xe ×22, 5700G ×7,5 (server01 cargado); VP9 perfil 2 Iris Xe
   ×17, 5700G ×10; **VP9 no soportado en Polaris** (sin bloque de hardware). Por
   software, 4K necesita 2 a 2,7 núcleos para ir en tiempo real; por hardware,
   0,1 a 0,26.

   **Enfoque (decidido 06/10/2026): libavcodec con hwaccel VA-API dentro del
   daemon**, no un parser H.264 propio. Cubre High, B-frames, varios slices y,
   donde el hardware lo soporta, HEVC y VP9, sin escribir un parser por códec
   (extender el parser propio habría sido ~1.500–2.500 líneas y solo H.264).
   **Licencia:** el FFmpeg de Alpine se compila con `--enable-gpl
   --enable-version3`; enlazarlo haría de la imagen una obra GPLv3, incompatible
   con publicar una imagen Apache-2.0. Por eso el `Dockerfile` **compila su
   propio libavcodec mínimo (LGPL, `--disable-gpl`)**, solo con los decoders y el
   hwaccel VA-API necesarios, desde un tarball fijado por versión y `sha256`.

   Sub-pasos: (1) ✅ **hecho el 06/10/2026**: sesión de decode vendor-agnóstica con
   libavcodec (`backend/native/vaapi-daemon/hwdec.c`, aún sin cablear al daemon),
   probada solo en el host con un cliente de línea de comandos. **12 de 12 casos
   soportados dan frames idénticos al software** (H.264 High con B-frames en 720p y
   1080p, HEVC Main10 4K HDR10 y VP9 perfil 2 4K, en Polaris, Iris Xe y el 5700G), y
   el único caso sin hardware (VP9 en Polaris) se rechaza sin caer a software.
   Detalle y cómo repetirlo en el README del daemon. Pendiente de este sub-paso:
   probar AV1 y VP8 (Iris Xe los anuncia) y medir el CPU real del decode; (2) protocolo v2 con una sesión por stream (conexión persistente atendida en su
   propio hilo del daemon, para no bloquear al encode), un access unit por pedido, salida de
   0 a N frames ya reordenados, flush y fin de stream, más un comando para que el backend
   pregunte qué decodifica el host. **(2a) ✅ hecho el 06/10/2026**, solo en el host:
   `protocol.h` (`VAAPI_CMD_HWDEC`, `VAAPI_CMD_HWDEC_CAPS`), el daemon compilado con
   `HWDEC=1` y un cliente de referencia en C (`hwdec_client.c`) que sirve de guía para el
   componente de Android. Verificado en Polaris, Iris Xe y el 5700G: todos los clips
   soportados dan frames idénticos al software **a través del daemon**, dos streams
   simultáneos corren a la vez, y un códec sin hardware (VP9 en Polaris) se rechaza.
   **(2b) frames sin copia: pendiente, y solo si hace falta.** Los frames hoy viajan como
   bytes (NV12/P010 compactos): hasta 1080p es barato (~93 MB/s en NV12, unos pocos % de un
   núcleo); el copiado solo duele en 4K de 10 bits (~25 MB por frame, ~750 MB/s a 30 fps).
   Con una pantalla de 720p o 1080p, YouTube pocas veces pide 4K, así que se mide antes de
   construirlo. La vía natural es la inversa de la del encoder: que Android asigne el
   buffer de salida y le pase su fd al daemon, que decodifica y blitea con VPP ahí;
   (3) del lado de Android, componente Codec2 con salida demorada para
   los B-frames, recompilado con AOSP, y registro dinámico en `media_codecs.xml`
   según lo que el host soporte; (4) validar bit a bit contra software y medir
   CPU en Polaris, Iris Xe y 5700G, con contenido real (SmartTube); (5) anotar
   las capacidades por códec en la base de combinaciones (un `chequeo` por
   códec, p. ej. `hwdec.h264`, `hwdec.hevc10`, `hwdec.vp9`).

   **Dificultad: Alta** — con VA-API quien decodifica tiene que armar los
   buffers de cada frame y manejar referencias y reordenamiento, y el componente
   Codec2 pasa de un pedido-un frame a salida demorada. **Gate propio** (no
   bloquea el de abajo): reproducir H.264 High de 720p/1080p, y VP9/HEVC donde
   el hardware lo soporte, en una instancia sobre AMD y sobre Intel con decode
   por hardware, con salida equivalente a la de software y un uso de CPU
   claramente menor.

   **Resultados en n02 (Iris Xe) con SmartTube, 06/10/2026** (decoders por hardware en la
   instancia, pantalla 1280x720, scrcpy conectado a la vez): 720p y 1080p a 24 fps fluidos
   (0 frames descartados), 720p a 60 fps AVC fluido, un H.264 a 60 fps de mayor resolución con
   tirones (más de la mitad de los frames descartados), 2160p VP9 no llega, y **HDR (VP9
   perfil 2, 10 bits) falla** porque el componente rechaza salida de 10 bits. El camino
   actual hace GPU→RAM→socket→copia a gralloc→compositor (que reescala a la pantalla)
   →conversión→encode, todo en un hilo por stream.

   **Hallazgo crítico (06/10/2026): P010 reinicia Android entero en redroid.** El servicio allocator
   de gralloc (`gralloc_gbm_bo_create`, gralloc.gbm.so) muere con SIGFPE (división por cero) al
   asignar un buffer P010, y como el allocator es crítico, zygote y system_server se reinician: en la
   instancia de n02 (Iris Xe) scrcpy quedó apuntando al sistema viejo y parecía colgado. Lo disparaba
   `getHalPixelFormatForBitDepth10` / `isHalPixelFormatSupported`, que asignan un buffer de prueba. El
   componente ya **no pide ni consulta P010**: la salida de 10 bits (HEVC Main10, VP9 perfil 2) se
   entrega como YV12 de 8 bits con los 8 bits altos (verificado bit a bit contra ffmpeg en Polaris).
   Sin HDR real ni rango de 10 bits, que scrcpy tampoco conserva. Pendiente: los decoders de software
   de Android hacen la misma consulta con VP9 de 10 bits y probablemente tiren el sistema abajo en esta
   imagen (sin probar); es un bug de gralloc de redroid para reportar upstream.

   **Limitación conocida de esta etapa (decidida 06/10/2026):** SmartTube sigue ofreciendo en su menú
   formatos UHD y HDR aunque la pantalla de la instancia sea de 720p y no declare HDR (no filtra por
   pantalla). Solución provisoria: fijar en SmartTube la calidad máxima por defecto (p. ej. 1080p 60 fps
   VP9 sin HDR), que el reproductor respeta. El HDR no se oculta a propósito: el decoder lo acepta y lo
   entrega como 8 bits, mientras que quitar esos perfiles mandaría el video a decoders de software que
   probablemente reinicien Android. Se revisa cuando esté el límite de resolución anunciada (punto 3).

   **Medición por etapa (06/10/2026, Polaris en jgustavo46, por la ruta completa de Android;
   `REDROID_FORGE_HWDEC_STATS=1` imprime estos promedios al cerrar cada sesión).** Milisegundos por frame, lado daemon:

   | clip | MB/frame | espera GPU (decode) | descarga GPU→RAM | copia compacta | armar cola | escritura al socket | total daemon |
   |---|---|---|---|---|---|---|---|
   | H.264 720p60 | 1,4 | 0,5 | 2,5 | 0,1 | 0,6 | 1,2 | ~5,2 (31 % de un core a 60 fps) |
   | H.264 1080p | 3,1 | 0,7 | 4,3 | 0,2 | 0,9 | 3,2 | ~9,6 |
   | HEVC 4K | 12,4 | 2,6 | 13,6 | 1,6 | 2,9 | 4,6 | ~26 (techo ~38 fps) |

   **Lo que domina es la descarga GPU→RAM (50-55 %), no el decode** (0,5-2,6 ms, el GPU va sobrado). 12,4 MB en
   13,6 ms son ~0,9 GB/s: lectura lenta de memoria de video, típica de mapear la superficie con
   `vaDeriveImage` en una GPU discreta (la ruta de `av_hwframe_transfer_data`). Siguen las copias en CPU
   (cola + socket + conversión en Android, en serie en un hilo) y, por último, el decode. A 60 fps el
   presupuesto es 16,7 ms por frame: 720p y 1080p entran, 4K no. No se midió Intel (n02 pausada por RAM) ni
   el lado Android (lectura del socket y copia al bloque), que suma al total.

   **Descarga GPU→RAM mejorada (06/10/2026, Polaris).** Se comparó `av_hwframe_transfer_data` (ffmpeg) contra
   `vaGetImage`, `vaDeriveImage` + copia normal y `vaDeriveImage` + cargas no temporales SSE4.1
   (`REDROID_FORGE_HWDEC_DOWNLOAD=ffmpeg|getimage|derive|derive-sse`). Los tres modos directos dan frames
   idénticos a ffmpeg. Descarga + copia compacta por frame y fps de punta a punta por Android:
   720p60 2,4→1,0 ms (160→188 fps), 1080p 4,3→1,9 ms (82→134 fps), 4K 14,6→8,3 ms (31→37 fps).
   **`derive-sse` queda por defecto**, con una autoverificación: el primer frame de cada sesión se baja
   también por ffmpeg y se compara byte a byte; si la descarga directa falla o difiere (tiling de Intel,
   otro driver) la sesión vuelve al camino de ffmpeg y lo avisa por stderr. **Sin probar en Intel (Iris Xe)
   ni en el 5700G**: ahí puede caer a ffmpeg, o ganar menos, y hay que medirlo.
   Con esto lo que queda más caro del daemon son la cola y el socket (~3 ms por frame a 1080p).

   **Frames por memoria compartida (06/10/2026, Polaris).** El daemon crea un memfd por sesión (512 MiB
   virtuales, solo ocupa lo que escriben los frames), lo manda por SCM_RIGHTS en la respuesta de apertura
   (`HwDecOpenRequest.flags = VAAPI_HWDEC_OPEN_SHM`) y baja cada frame directamente ahí; el componente lo mapea
   de solo lectura y copia de ahí al bloque de gralloc. Quedan dos copias menos por frame (la cola del daemon y
   el `write`/`read` por el socket) y el tiempo de cola + socket pasa de ~3 ms a ~0. Sin el flag el protocolo
   sigue siendo el inline de antes. Frames idénticos a la referencia en todos los clips (8 y 10 bits).
   Rendimiento puro (`NO_HASH=1`, sin verificar píxeles), hardware contra el decoder de software de Android en
   la misma máquina: H.264 720p60 431 vs 298 fps, H.264 1080p 222 vs 125, HEVC 1080p 196 vs 196, HEVC 4K 55 vs 70.
   **El valor es el CPU que deja libre, no los fps:** CPU total del host por cada 100 frames (incluye la
   herramienta y el framework en los dos casos): H.264 1080p 0,64 s con hardware contra 2,44 s con software
   (3,8x menos), HEVC 1080p 0,72 contra 2,14 (3,0x menos), HEVC 4K 1,69 contra 5,62 (3,3x menos).
   Pendiente: el `.policy` de seccomp ahora lleva `recvmsg` (no se aplica en redroid, pero sí en un dispositivo
   real); y medir Intel y el 5700G.

   **Siguiente tanda del hwdecode (orden decidido 06/10/2026):**
   1. ✅ Medir tiempo por etapa (tabla de arriba). Falta el lado Android y Intel.
   2. ✅ Salida de 10 bits en el componente: HEVC Main10 y VP9 perfil 2, como 8 bits (ver hallazgo de arriba).
   3. **Límite de resolución anunciada = el escalón estándar (240/360/480/720/1080/1440/2160p)
      más grande que quepa en la pantalla de la instancia, redondeando hacia abajo, con piso
      en 720p**, y nunca por encima de lo que el hardware decodifique (eso lo informa el
      daemon). Se aplica al crear la instancia (`media_codecs.xml` y límite de tamaño de la
      interfaz Codec2); un cambio de pantalla pide recrear o reparchear. A comprobar con
      SmartTube: los decoders de software siguen declarando 4K y un player que mire el
      máximo entre todos podría seguir ofreciendo UHD.
   4. Ganancias baratas según la medición (✅ descarga por `vaDeriveImage`+SSE hecha; ✅ memoria compartida hecha; faltan los hilos
      en etapas y SIMD en U/V): etapas en hilos (decodificar el N+1 mientras se
      baja y envía el N), `vaCopy` en vez de leer memoria de video con la CPU, memoria
      compartida (memfd) en vez de socket, SIMD en la separación de U/V.
   5. Si no alcanza, 2b (zero-copy): mantiene el frame en el GPU de punta a punta; el
      compositor lo reescala sin pasar por la CPU. Riesgo: que el gralloc de redroid acepte el
      formato y modificador de tiling.
   Escalar dentro del daemon antes de bajar el frame ahorra copia pero cambia el tamaño que
   ve la app: solo como opción explícita, nunca por defecto.

   **HDR (anotado 06/10/2026): no se conserva por scrcpy hoy, y no bloquea nada.**
   La pantalla de redroid no declara HDR (`supportedHdrTypes=[]`, sin wide color),
   scrcpy 4.1 no tiene opciones de HDR/10 bits, y el encoder es H.264 de 8 bits:
   el video HDR llega como SDR. Conservarlo de punta a punta sería otro proyecto
   (display con HDR en Android, encode HEVC Main10, un scrcpy y un cliente que lo
   manejen). **scrcpy cambia rápido:** es un punto a **revisar periódicamente**,
   porque una versión nueva podría cubrir parte de esto. El valor de este
   objetivo es el ahorro de CPU y la compatibilidad de códecs, no la fidelidad HDR.

**Gate:** una instancia creada desde `redroid-forge` reproduce el mismo
comportamiento de aceleración ya validado por separado, en al menos un host
AMD/Intel y uno NVIDIA reales.

## Fase 3 — WiFi falso + device profile spoofing

**Dificultad: Media** — código ya escrito y probado en otro lado
(`jg-dashboard`), el trabajo es portarlo y adaptar las rutas de
`build.prop` que ya se sabe que varían por imagen.

**Pasos:**
1. Portar `DEVICE_PROFILES`/`buildDeviceProfileScript` de `jg-dashboard`
   (`redroid.service.ts`) al nuevo backend. ✅ hecho —
   `backend/src/lib/deviceProfile.js` (perfil `samsung`, revert a `redroid`
   restaurando desde backup), cableado en
   `POST /instances/:id/device-profile` (gateado por su manifest, ver
   `assertDeviceProfileReady` en `routes/instances.js` — es opt-in por
   request, no un modulo requerido por ninguna imagen, así que no pasa por
   `moduleGate.check` sino por `moduleAcceptance.isAccepted` directo).
   Cobertura en `backend/test/deviceProfile.test.js`.
2. Confirmar que el WiFi falso portado en la Fase 0 sigue íntegro. ✅ hecho —
   mismo comportamiento y mensajes de log que antes, cubierto por los tests
   existentes de `hwsimWifi.js` más los nuevos de concurrencia (paso 4).
3. Validar aplicar/revertir un perfil (ej. `samsung`) desde la UI nueva.
   **[PENDIENTE]** — no se sumó UI todavía (esta ronda de trabajo se limitó
   al endpoint HTTP), y de cualquier forma esto necesita un host con Docker
   real para validarse, no disponible en el entorno donde se hizo este
   port.
4. **Arreglar la race condition conocida de `ensureHwsimWifi`**. ✅ hecho en
   código — `hwsimWifi.js` ahora serializa cada reclamo de par phy/iface a
   través de una cola de promesas a nivel de módulo (`hwsimClaimTail`/
   `runHwsimClaim`), con la misma nuance de "no recargar `mac80211_hwsim` si
   otra instancia todavía tiene phys en uso". **Corrección sobre esta misma
   entrada:** al escribir el código se buscó el método de referencia
   `claimHwsimPhyPair`/`hwsimClaimTail` que esta entrada decía que ya existía
   en `jg-dashboard/redroid.service.ts` — **no existe ahí** (se clonó el repo
   y se revisó el archivo completo). Lo que sí existe en ese archivo es la
   nuance de "0 phys libres, ¿alguna otra instancia los está usando?" dentro
   de `ensureHwsimWifi` (sin cola/serialización — ese archivo tiene la misma
   race hoy) y el patrón general de cola-de-promesas a nivel de servicio
   (`bootQueueTail`, usado para otra cosa, el orden de arranque). El fix acá
   se diseñó aplicando ese mismo patrón al problema de hwsim, no copiando un
   método que no existe. **Validado solo con test unitario mockeado**
   (`backend/test/hwsimWifiConcurrency.test.js` — mockea
   `child_process.execFile`/`dockerRuntime`, simula 2 llamadas concurrentes
   contra un estado de host compartido y verifica reclamos disjuntos);
   **todavía no probado contra una race real de arranque dual de instancias
   en hardware**, eso queda pendiente antes de confiar en esto en producción.

**Gate:** el spoof de perfil se puede aplicar/revertir desde la UI nueva,
con los archivos de `build.prop` correctos según la imagen, y reiniciar dos
o más instancias con WiFi falso al mismo tiempo no deja ninguna sin radios.
**Parcial:** el fix de concurrencia y el spoof de perfil (vía API) están
hechos y con test unitario; falta la UI (paso 3) y la validación en
hardware real con dos instancias arrancando/reiniciando a la vez para poder
cerrar el gate por completo.

## Fase 4 — Sistema de contrato de módulo (genérico)

**Dificultad: Media** — diseño nuevo, pero acotado: un schema de manifest,
un modal genérico, y un registro de versión aceptada. No hay ambigüedad de
alcance, solo hay que construirlo.

**Pasos:**
1. Definir el schema del manifest (sección 5 de `REQUIREMENTS.md`). ✅ hecho
   — validador a mano (sin sumar dependencia de JSON Schema) en
   `backend/src/lib/moduleManifests.js`, un manifest JSON por módulo en
   `backend/src/modules/manifests/`.
2. Construir el modal de contrato genérico que lo renderiza (frontend). ✅
   hecho — `frontend/contracts.js`, un solo diálogo para los 6 módulos.
3. Implementar el registro de aceptación por versión en el backend, y el
   bloqueo de ejecución sin aceptación vigente. ✅ hecho —
   `backend/src/lib/moduleAcceptance.js` (registro) +
   `backend/src/lib/moduleGate.js` (bloqueo), enganchado en
   create/start/restart de `routes/instances.js`. Sin auth todavía (Fase 6),
   la aceptación vale para toda la instalación, no por usuario.
4. Retrofit: pasar GApps, Magisk, WiFi falso, device profile, modo GPU,
   CPU/RAM a este contrato genérico en vez de toggles ad hoc. ⚠️ parcial —
   GApps y WiFi falso (que sí tenían lógica de habilitación ad hoc atada a
   flags de imagen) están retrofiteados y gateados; Magisk suma su flag
   (`hasMagisk`) y pasa por el mismo gate por primera vez. Device profile,
   modo GPU y CPU/RAM **no tenían ninguna lógica de ejecución portada
   todavía** (siguen pendientes de las Fases 2/3) — tienen su manifest y ya
   son consultables via `GET /api/modules` (incluyendo `compatibleCon`),
   listos para engancharse a `moduleGate` en cuanto exista su ejecución real.
5. Implementar `compatibleCon` (diferido de la Fase 1): el manifest declara
   versión de Android/modo GPU compatible, y el backend no ofrece el módulo
   si la imagen elegida no cumple. ✅ hecho —
   `moduleManifests.isCompatible`/`incompatibilityReason`, reutilizando los
   campos `androidVersion`/`gpuMode` que el catálogo ya tiene desde la Fase
   1 (sin duplicar esa metadata). `moduleGate.check` lo aplica antes de
   crear/arrancar; `GET /api/modules?imageId=` lo expone para que un futuro
   selector de módulos opcionales lo consulte.

**Gate:** activar GApps (caso de referencia no libre) exige leer y aceptar
un contrato generado desde manifest antes de que el backend ejecute nada.

## Fase 5 — Módulos definidos por el usuario + piloto CIFI

**Dificultad: Alta** — no hay convención previa dentro del proyecto para
esto (es diseño desde cero, aunque con referencias externas), y el caso
piloto (CIFI) es un script con bugs sutiles ya conocidos (herencia de lock
de `adb` tras reboot) que hay que no reintroducir al migrarlo.

**Pasos:**
0. ⬜ Abierto — **Base de datos de combinaciones conocidas + módulos
   GApps/Magisk sobre la imagen oficial** (decisión 05/10/2026, ver
   `REQUIREMENTS.md` sección 2). Reemplaza a las imágenes custom del catálogo
   (`gapps-official`, `wifi-v3`): la base es la imagen oficial fijada por
   digest, y GApps/Magisk se inyectan por instancia desde paquetes con
   versión y `sha256` conocidos, verificados antes de usarse. Incluye: formato
   de la base, snapshot incluido en cada release, actualización opcional desde
   el repo externo con verificación, y tier "sin soporte" para lo que no esté
   en la base.
   Diseño en `docs/BASE-COMBINACIONES.md` (plan de 7 sub-pasos). Sub-paso 1
   ✅ hecho: núcleo puro `backend/src/lib/knownDb.js` (validación, resolución
   de soporte, `serial` anti-rollback, firma ed25519) + snapshot semilla
   `backend/db/snapshot.json` + tests. **Todavía no está cableado** a la
   creación de instancias. Sub-paso 2 ✅ hecho: API de solo lectura
   (`/api/db`, `/api/db/combinaciones`), carga por `serial` con fallback
   (`knownDbStore.js`) y check en el Doctor; snapshot en `serial` 2 con la
   validación de Intel Iris Xe. Sub-paso 3 ✅ hecho: descarga + verificación de firma
   ed25519 + anti-rollback + actualización atómica (`knownDbUpdate.js`) y
   herramienta de firma `backend/scripts/db-sign.js`. Clave del mantenedor
   generada el 05/10/2026 (`backend/db/trusted-keys.json`) y repo
   `fogelmanjg/redroid-forge-db` creado; sin claves de confianza no se consulta
   ni aplica nada. Las imágenes que usa el redroid de `jg-dashboard` se siguen
   manteniendo allá, pero no son relevantes para `redroid-forge`: son
   proyectos separados y no tienen que ser compatibles entre sí.
1. ✅ **Hecho, parcial** — Diseñada e implementada la convención para
   módulos con lógica de ejecución ligada al **ciclo de vida de una
   instancia** (etapas 3-6, ver `docs/ARQUITECTURA.md` sección "Fase 5: el
   runner genérico y la convención `etapa`/`entry`"): manifest con
   `etapa`/`entry`, `entry` resuelto relativo a la carpeta del módulo, un
   nombre de export fijo por etapa (`prepareCreate`/`integrate`/
   `ensureHostInfraReady`/`ensureRuntimeReady`). **No** es todavía la
   convención de "módulo de usuario" que pide este paso originalmente
   (schedule periódico tipo cron + pause/resume/status, referencia CIFI) —
   esa sigue sin diseñarse. Lo que se resolvió es el caso más urgente y ya
   real del proyecto: `hwenc` (Fase 2) tenía lógica de integración escrita
   pero cableada a mano en `instances.js`, sin ningún punto de enganche
   genérico.
2. ✅ **Hecho para el mecanismo de ciclo de vida, abierto para scheduling
   persistente** — `backend/src/lib/moduleRunner.js` orquesta las etapas
   3-6 desde `instances.js` (create/start/restart), reemplazando el casing
   especial de `hwenc`/`hwAccel` que existía ahí. Lo que sigue sin
   implementar: el mecanismo de **scheduling periódico** (correr cada N
   minutos, pause/resume/status persistente) que pide este paso para
   watchdogs tipo CIFI — el runner de esta fase resuelve "qué corre en el
   momento de crear/arrancar una instancia", no "qué corre en loop mientras
   la instancia vive".
3. ⬜ Abierto — Portar el watchdog de CIFI sobre Redroid 15 usando la
   convención de scheduling (todavía sin diseñar, ver paso 2), en reemplazo
   del script de cron + `flock` actual. **No** se tocó en esta iteración.
4. ⬜ Abierto — Validar en vivo varios días sin reaparición del bug de lock
   heredado. Requiere hardware real y días de observación; no intentado acá.
5. ⬜ Abierto — Segundo piloto, mismo mecanismo: el watchdog persistente de
   reconexión de WiFi falso (hoy vive hardcodeado en `jg-dashboard`, ver
   `claimHwsimPhyPair`/`wifiWatchdogs` en `redroid.service.ts`) migra a
   módulo-script en vez de portarse tal cual.

**Además de lo pedido originalmente en los pasos 1-2** (efecto colateral
positivo de dejar el runner de ciclo de vida bien genérico, no ad hoc para
hwenc): `moduleGate.requiredModuleIdsForImage` ahora también deriva `hwenc`
desde `img.hwEncCapable`, así que activar una imagen con ese flag exige
aceptar su contrato igual que GApps/Magisk/WiFi falso. Ninguna imagen del
catálogo (`backend/images.json`) declara ese flag todavía, así que esto no
cambia el comportamiento observable de nada hoy.

**[PENDIENTE] nada de lo hecho en los pasos 1-2 se validó contra un host
real con Docker/redroid** — sólo hay cobertura de unit tests con
fixtures/mocks (`backend/test/moduleRunner.test.js`,
`backend/test/moduleContract.test.js`). Antes de usar esto con hardware
real, correr el flujo completo (crear → inyectar en `/vendor` → arrancar →
fixup post-boot) contra la imagen oficial de redroid en un host AMD/Intel.

**Gate:** CIFI corre como módulo dentro de `redroid-forge` (pause/
resume/status desde la app, no edición manual de cron), validado en vivo
sin que reaparezca el bug conocido. **No cumplido todavía** — los pasos 3-5
siguen abiertos.

## Fase 6 — Autenticación opcional (Keycloak)

**Dificultad: Media** — el patrón ya está acordado y probado en otros
proyectos propios (Keycloak admin API, bolt-on opcional con Plenum), no es
terreno desconocido.

**Pasos:**
1. Implementar el bolt-on de auth: Keycloak directo, o delegado vía Plenum/
   `jg-dashboard`.
2. Confirmar que con la variable de entorno apagada el comportamiento es
   idéntico a hoy (cero auth).

**Gate:** con auth apagado, comportamiento idéntico a hoy; con auth
prendido, Keycloak filtra el acceso.

## Fase 7 — `jg-dashboard` y `plenum-redroid` pasan a consumidores

**Dificultad: Media-Alta** — son dos integraciones reales contra dos
codebases distintas (Angular/NestJS en un caso, el módulo federado de
Plenum en el otro), y hay que coordinar la migración sin downtime real
sobre instancias que están en uso.

**Aclaración (05/10/2026):** `redroid-forge` y el redroid de `jg-dashboard`
se tratan como **dos proyectos separados que no tienen que ser compatibles
entre sí** (ni imágenes, ni instancias, ni estado). Por eso las pruebas de
`redroid-forge` se hacen en `jgustavo46` y no en server01. Cuando
`redroid-forge` esté funcionando, el redroid del dashboard se **quita y se
reemplaza** por `redroid-forge`; recién en ese momento se vuelve a server01.
No hay migración de imágenes ni de instancias del dashboard viejo.

**Pasos:**
1. `jg-dashboard` pasa a llamar a la API/embed de `redroid-forge` en
   vez de usar su propio `redroid.service.ts`.
2. `plenum-redroid` hace lo mismo.
3. El código viejo en ambos sigue presente sin tocarse (política de
   convivencia, sección 4) durante todo el período de rodaje.

**Gate:** ambos operan instancias reales exclusivamente a través de
`redroid-forge` durante un período de rodaje, sin regresiones.

## Fase 8 — Baja del código viejo + pulido público

**Dificultad: Baja** — es limpieza y documentación, no trabajo técnico
nuevo.

**Pasos:**
1. **Asegurar el código viejo en GitHub antes de borrar nada.** ✅ Hecho el
   05/10/2026: se pusheó `jg-dashboard` (los 2 commits pendientes, incluido
   `27bd149`, el último trabajo de redroid) y `plenum-redroid` —que no era un
   repo git ni existía en GitHub— se subió, congelado, a
   `fogelmanjg-plenum/plenum-redroid` (privado, con un README que lo marca como
   archivado y reemplazado por `redroid-forge`; sin `.env` ni datos de
   ejecución). **Falta**, justo antes de borrar: volver a commitear/pushear
   cualquier cambio nuevo de redroid en `jg-dashboard` (hoy tiene archivos sin
   commitear no relacionados con esta decisión) y dejar un tag en el último
   commit (ej. `redroid-legacy-<fecha>`) para encontrarlo fácil.
2. Quitar **todo** el código de redroid de `jg-dashboard` y `plenum-redroid`
   (recién acá, nunca antes del gate de la Fase 7), incluido el código muerto
   del visor `ws-scrcpy`/oauth2-proxy. Decisión (05/10/2026): ese código queda
   en GitHub como proyecto viejo, muerto y reemplazado por `redroid-forge`; no
   se porta nada como compatibilidad.
3. Escribir README/CONTRIBUTING/atribución definitivos, issue templates.

**Gate:** proyecto en condición de llamarse **beta 0.9** — a partir de acá
se retoma el mecanismo de donaciones/soporte (sección 8 de
`REQUIREMENTS.md`), no antes.

## Fuera de fases (bajo demanda, no bloquean nada de lo de arriba)

- Otros proyectos "grandes" a leer que puedan sumar algo (pendiente en
  `REQUIREMENTS.md` sección 10) — se evalúan e insertan en la fase que
  corresponda cuando se identifiquen, no generan una fase propia por sí
  solos.
- **Bloqueador de publicidad configurable (idea, 04/10/2026).** A nivel
  sistema y por aplicación. Encaja como módulo de usuario de la Fase 5
  (manifest + script), no como parte del core. Diseño a decidir; opciones
  vistas:
  - *Cliente VPN local* (NetGuard probado a mano, no necesita root): permite
    reglas por app (uid). Requisito de plataforma: Android abre `/dev/tun`,
    no `/dev/net/tun`; el contenedor debe crearse con
    `--device /dev/net/tun:/dev/tun` (o `mknod /dev/tun c 10 200`, que no
    sobrevive a recrear el contenedor). Sin ese nodo `Vpn.jniCreate` falla
    con "Cannot create interface" y la VPN nunca se establece.
  - *Efecto colateral a resolver:* la VPN también captura a `adbd` (uid
    2000); con bloqueo activo el adb TCP queda inalcanzable. El módulo debe
    permitir `com.android.shell` por defecto.
  - *Alternativa sin VPN:* DNS privado / filtrado a nivel red del host
    (bloqueo por dominio, sin granularidad por app).
  - Reglas por app: definir si se guardan en el manifest del módulo o por
    instancia.
- **Más códecs de audio (idea, 06/10/2026).** Hoy el audio por scrcpy solo
  anda con `--audio-codec=aac`; el default (opus) falla. scrcpy ofrece opus,
  aac, flac y raw, así que el límite está en los encoders que la imagen
  Android expone, no en scrcpy. No es para la primera versión.
  - *Chequeo previo (~5 min, en la instancia de jgustavo46):* log de scrcpy
    con opus y `dumpsys media.codec`, para confirmar por qué falla. Hipótesis
    sin verificar: el `media_codecs.xml` de la imagen oficial no registra el
    encoder `c2.android.opus.encoder` (AOSP lo trae por software), igual que
    pasaba con los decoders.
  - *Si es eso:* se registra desde el módulo de integración al crear la
    instancia (mismo mecanismo que `addCodecsToXml` para los decoders), sin
    imagen custom. Con opus como default (menos latencia y bitrate que aac).
  - `raw` no necesita encoder (más ancho de banda; sirve por LAN y para
    diagnóstico). `flac` es encoder por software de AOSP: probar si está
    registrado.
  - Sin aceleración por hardware: el costo de CPU del audio es despreciable.
