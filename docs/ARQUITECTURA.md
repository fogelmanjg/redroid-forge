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
