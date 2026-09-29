# redroid-forge — Cómo encajan las piezas

> Complementa `REQUIREMENTS.md` (qué y por qué) y `ROADMAP.md` (en qué
> orden). Este documento es el modelo mental: qué es cada pieza, dónde vive
> físicamente, y en qué momento del ciclo de vida de una instancia se toca.
> Pensado para cualquiera que llegue al proyecto sin el contexto de cómo se
> armó — la intuición de "esto es una carpeta a la que le agregás cosas" no
> es obvia hasta que se ve así, en capas.

## Principio de base: nunca alojamos binarios de terceros

Esto no es una preferencia de estilo — es la razón de ser de todo este
documento. `redroid-forge` (el repo, la imagen que se distribuye, cualquier
cosa que publiquemos) **nunca contiene ni redistribuye software de terceros
no libre** (GApps, Magisk, lo que sea). No alcanza con "no lo metemos en una
imagen Docker" — tampoco alcanza con "lo bajamos aparte y lo empaquetamos
como tarball nuestro". La regla real es: **el binario de un componente no
libre siempre tiene que salir de su fuente oficial real, en el momento en
que el usuario lo pide** — nunca de un servidor o repo nuestro.

Esto incluye el propio árbol fuente de Android que arma la imagen base: si
GApps (o cualquier otra cosa no libre) está mezclado en el código fuente que
compilamos, la imagen resultante ya viola esta regla aunque después la
manejemos "bien" con Docker — el problema no es dónde termina el archivo, es
de dónde salió. Ver "Encontrado el 28/09" más abajo para el caso real que
disparó esta aclaración.

## Una imagen Docker no es un archivo — es una carpeta

Antes de las 6 etapas, la base física: una imagen Docker es una pila de
capas, cada una un directorio real en el disco del host
(`/var/lib/docker/overlay2/<hash>/diff/`). Cuando se crea un contenedor,
Docker superpone esas capas en una vista única (`merged/`) que pasa a ser el
`/` del contenedor. No hay nada binario/opaco — son archivos comunes,
navegables con `ls`/`cat` como cualquier carpeta del host. `docker import`
toma un `.tar` y lo convierte en la primera capa; `docker commit` congela el
estado actual de un contenedor como una capa nueva encima.

## Las 6 etapas

### 1. Imagen redroid estándar

La imagen oficial de [`remote-android/redroid`](https://github.com/remote-android/redroid-doc),
tal cual la publica ese proyecto. `redroid-forge` no la aloja ni la
redistribuye — el usuario la baja directo de la fuente oficial (o Docker ya
la tiene en caché local si la bajó antes). Sin modificar.

### 2. Cosas que se agregan a esa carpeta antes de que exista cualquier instancia

Construir una **imagen derivada** (vía `docker commit` sobre un contenedor
ya parcheado) para reusarla en muchas instancias futuras, en vez de repetir
el trabajo cada vez. Es una optimización legítima para módulos 100% libres
o de contenido propio — **nunca** para algo no libre (ver el principio de
base). Ejemplo real (28/09): `redroid-jg-15:hwenc-poc`, una imagen con el
componente de aceleración por hardware ya inyectado, para no repetir la
inyección de ~50 archivos cada vez que se prueba.

### 3. Se crea la instancia

`docker create` (todavía sin arrancar) a partir de la imagen que sea — la
estándar del paso 1, o una derivada del paso 2.

### 4. Cosas que se agregan/modifican en esa instancia antes de arrancarla

Inyección puntual, solo para **esa** instancia — no se guarda en ninguna
imagen compartida. Acá vive la integración de módulos no libres (GApps,
Magisk): el script del módulo los descarga de su fuente oficial en este
momento y los coloca en el contenedor todavía detenido.

**Restricción técnica dura, confirmada en vivo el 28/09:** `/vendor` (y
probablemente `/system`/`/product`, sin confirmar todavía) se vuelve de
solo lectura casi al instante de que Android arranca por primera vez — la
ventana para escribir ahí es exactamente entre `docker create` y el primer
`docker start`, nunca después. Cualquier módulo que necesite tocar esas
particiones (el componente de hwenc, por ejemplo) tiene que declarar esto
en su manifest, para que el backend sepa que no puede crear la instancia ya
arrancada — tiene que pasar primero por esta etapa.

Los módulos que solo tocan `/data` (que sobrevive reinicios y es escribible
siempre) no tienen esta restricción — pueden aplicarse acá o directamente
en la etapa 6.

### 5. Cosas que corren en el host, de las que la instancia depende para comunicarse

Infraestructura del lado servidor, independiente de cualquier instancia
puntual — corre sola, esperando que algo se conecte. No es parte de ninguna
imagen ni de ningún contenedor. Ejemplo real: el daemon de VA-API
(`backend/native/vaapi-daemon/`) corriendo en el host, escuchando en
`/dev/vaapi-helper/socket`. Si no está corriendo, una instancia con el
componente de hwenc ya inyectado (etapa 4) arranca igual, pero no tiene con
quién hablar — el encoder queda ahí, mudo.

### 6. Cosas que se inyectan/ejecutan con la instancia ya corriendo

Acciones que el backend dispara **contra** una instancia que ya está viva
(vía `docker exec`/`adb shell`) — no archivos que quedan guardados de forma
permanente, sino comandos que se repiten cada vez que hacen falta. Ejemplos
reales ya portados: asignar los radios WiFi falsos (`ensureHwsimWifi`),
forzar la reconexión de WiFi (`ensureWifiConnected`, y su versión
persistente, el watchdog periódico). Esto se repite en cada boot de cada
instancia — no queda "guardado" en ningún lado por más veces que se corra.

## La distinción que más importa: etapa 4 vs. etapa 6

- **Etapa 4** = una vez, antes del primer boot, y persiste mientras esa
  instancia exista (es parte del filesystem del contenedor).
- **Etapa 6** = se repite cada vez que hace falta, y no deja rastro
  permanente si el proceso que lo dispara muere o el contenedor se recrea.

El manifest de un módulo (sección 5 de `REQUIREMENTS.md`) tiene que declarar
en qué etapa(s) opera — eso determina si el backend necesita crear la
instancia sin arrancarla (etapa 4) o si puede trabajar sobre una ya viva
(etapa 6).

## Fase 5: el runner genérico y la convención `etapa`/`entry`

Hasta Fase 4, "etapa" y "entry" eran campos del manifest que ningún código
todavía interpretaba — `hwenc` (el primer módulo con lógica de ejecución
real, ver `backend/src/modules/hwenc/`) estaba cableado a mano en
`instances.js`, con un `if (img.hwEncCapable)` explícito. Fase 5 generaliza
eso: `backend/src/lib/moduleRunner.js` es el orquestador que, para cualquier
módulo que declare `etapa`/`entry`, hace `require()` dinámico de su `entry`
(resuelto relativo a **la carpeta del propio módulo**, vía
`moduleManifests.moduleDir(id)` — nunca relativo a `moduleRunner.js`) y llama
a la función que le corresponde por convención de nombre fijo:

| Etapa | Nombre exportado       | Cuándo se llama                                   | Argumentos      |
|------:|-------------------------|----------------------------------------------------|-----------------|
| 3     | `prepareCreate`         | antes de `runtime.create()`                        | ninguno         |
| 4     | `integrate`              | entre `runtime.create()` y `runtime.start()`        | `containerId`   |
| 5     | `ensureHostInfraReady`   | antes de `start`/`restart` (create incluido)        | ninguno         |
| 6     | `ensureRuntimeReady`     | después de `start`/`restart`, fire-and-forget       | `containerId`   |

Un módulo sólo necesita exportar los hooks de las etapas que declara en su
manifest — los módulos "puramente contrato" (GApps/Magisk/WiFi falso, sin
lógica de ejecución propia todavía) no declaran `entry`, y el runner
simplemente no los toca; `moduleGate.js` sigue siendo quien decide si pueden
activarse en absoluto (compatibilidad + consentimiento), sin superponerse
con esto.

**Decisiones de diseño tomadas al generalizar (no estaban especificadas de
antemano, documentadas acá para que quede rastro de por qué):**

- **Etapa 3 es aditiva, no reemplaza nada:** `prepareCreate()` devuelve
  `{ binds?, cmd? }` y `instances.js` los concatena a los que ya arma para
  cualquier instancia (ancho/alto/dpi/fps/gpu\_mode) — un módulo nunca puede
  pisar lo que el core ya decidió, sólo sumar. Esto reemplaza el
  `REQUIRED_BOOT_FLAGS` de `hwenc`, que se exportaba desde Fase 2 pero nunca
  se leía en ningún lado (código muerto) hasta ahora.
- **Etapa 5 (infraestructura del host) vive en los exports del mismo
  `entry`, no en una convención aparte.** La alternativa —dejar que
  `instances.js` siguiera llamando a `hwAccel.ensureDaemonRunning()` a mano,
  gateado por `img.hwEncCapable`— hubiera dejado a `hwenc` como caso especial
  para siempre, exactamente lo que Fase 5 busca eliminar. En cambio,
  `hwenc/integrate.js` exporta `ensureHostInfraReady()` como un wrapper de
  una línea que delega en `hwAccel.js` (dueño real de esa lógica, sin
  duplicarla) — el runner no necesita saber que "hwenc" y "el daemon VA-API"
  tienen algo que ver entre sí, sólo que el módulo declaró etapa 5 y expone
  el hook con el nombre esperado. Ver `backend/src/modules/hwenc/README.md`
  para el detalle.
- **`requiredModuleIds` se persiste en la instancia al crearla**, no se
  recalcula desde el catálogo en cada start/restart — mismo criterio que ya
  usaba el campo `hwEncCapable` guardado por instancia antes de esta fase:
  si `images.json` cambia o la imagen se borra del catálogo después de
  crear una instancia, sus módulos ya inyectados siguen corriendo sus etapas
  5/6 igual (el gate de consentimiento, en cambio, sí se revalida contra el
  catálogo vigente — son dos preocupaciones distintas, ver
  `revalidateModulesIfImageKnown` en `instances.js`).
- **Descubrimiento de manifests en dos ubicaciones, no una.** Los manifests
  planos existentes (`backend/src/modules/manifests/*.json`) no se movieron
  a una carpeta por módulo — `moduleManifests.loadAll()` escanea esa carpeta
  Y `backend/src/modules/<id>/manifest.json` (usado por `hwenc`), validando
  unicidad de `id` entre ambas fuentes. Menor superficie de cambio y menos
  conflicto con otro trabajo tocando esos mismos archivos en paralelo.
- **Etapa 4 se corre en serie y de punta a punta** (no `Promise.all`): si un
  módulo futuro falla a mitad de inyectar archivos en `/vendor`, no tiene
  sentido seguir con el siguiente ni mucho menos arrancar la instancia con
  la mitad de los módulos aplicados en silencio.
- **Etapa 6 es fire-and-forget**, mismo patrón que ya usaban
  `scheduleWifiFixes`/`hwsimWifi.js`: un fixup post-boot que falla no tiene
  que tumbar un start/restart que por lo demás ya funcionó — la instancia ya
  está viva, esto es un ajuste sobre algo que ya arrancó, no una
  precondición para que arranque.

**[PENDIENTE]** nada de este runner se validó todavía contra un host real
con Docker/redroid corriendo — sólo hay cobertura de unit tests con fixtures
y mocks (`backend/test/moduleRunner.test.js`). Los pilotos de módulos de
usuario (CIFI, watchdog de WiFi falso — sección 5 de `REQUIREMENTS.md`,
"Extensibilidad: módulos definidos por el usuario") son un mecanismo
*distinto* (scheduling periódico + pause/resume/status) y siguen sin
diseñarse — este runner resuelve el ciclo de vida de creación/arranque de un
módulo, no scheduling continuo.

## Encontrado el 28/09: el propio árbol de AOSP tenía GApps mezclado

Al mapear estas etapas contra el proyecto real, apareció un caso concreto
del principio de base violado: `~/aosp-redroid-15/vendor/gapps` es un
proyecto GApps completo (estilo MindTheGapps, con sus propios
`proprietary-files*.txt`) **mezclado directamente en el código fuente de
Android**, compilado como parte del mismo `m` que arma el resto del
sistema. Las imágenes `redroid-jg-15:gapps-official`/`wifi-v3` (y cualquier
imagen derivada de ese build, incluida `hwenc-poc`) ya tienen GApps adentro
desde la primerísima capa — sin importar qué se haga después con
`docker commit`/inyección por instancia.

**Implicación para v1 de `redroid-forge`:** la imagen "estándar" (etapa 1)
tiene que salir de un build de AOSP **sin** `vendor/gapps` mezclado, o
directamente usar la imagen oficial de `remote-android/redroid` sin build
propio de por medio. El módulo de GApps (etapa 4) tiene que bajar los
`.apk` de la fuente real (MindTheGapps/OpenGApps, lo que se elija) en el
momento, nunca desde algo que `redroid-forge` aloje. **[PENDIENTE]**
decisión de cuál fuente de GApps usar y si esto se aplica en la próxima
build de AOSP o se resuelve completamente por inyección post-build.
