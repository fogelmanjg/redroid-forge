# Módulo: hwenc

Primer caso real de la convención de módulos con lógica de ejecución
descripta en `docs/ARQUITECTURA.md` (etapas 3, 4, 5 y 6) y en la sección 5 de
`docs/REQUIREMENTS.md`. Desde Fase 5, además, es el primer módulo que corre
a través del runner genérico (`backend/src/lib/moduleRunner.js`) en vez de
estar cableado a mano en `instances.js` — cualquier módulo futuro con la
misma forma (`etapa`/`entry` en su manifest) se integra sin tocar
`instances.js`.

- **`manifest.json`** — contrato del módulo (qué toca, con qué es compatible),
  mismo schema que ya valida Fase 4 (`moduleManifests.js`), más dos campos
  que ese sistema descubre pero no interpreta: `etapa` (en qué momento del
  ciclo de vida de la instancia opera, ver `ARQUITECTURA.md`) y `entry` (el
  script que hace el trabajo real, resuelto relativo a esta misma carpeta).
  Vive en `backend/src/modules/hwenc/manifest.json` (no en
  `backend/src/modules/manifests/`) — `moduleManifests.js` escanea las dos
  ubicaciones, ver el comentario de `loadAll()` ahí.
- **`integrate.js`** — expone un hook por etapa, con el nombre fijo que
  `moduleRunner.js` espera para cada una (ver `STAGE_EXPORT_NAME` ahí):
  - `prepareCreate()` (etapa 3): qué sumarle a `binds`/`cmd` antes de
    `docker create` — el bind del socket del daemon VA-API y el boot flag
    `androidboot.use_redroid_c2=1`. Antes vivía hardcodeado a mano en
    `instances.js`; `REQUIRED_BOOT_FLAGS` se exportaba pero nadie lo leía.
  - `integrate(containerId)` (etapa 4): copia el componente Codec2 de VA-API
    dentro de `/vendor` de una instancia recién creada (todavía sin
    arrancar). También se puede correr suelto para debug manual
    (`node integrate.js <containerId>`).
  - `ensureHostInfraReady()` (etapa 5): delega en
    `backend/src/lib/hwAccel.js` (`ensureDaemonRunning`) — la lógica real del
    daemon sigue viviendo ahí, sin duplicarse acá. Este hook es sólo el punto
    de enganche que el runner genérico necesita para llamarlo en el momento
    correcto (antes de `start`/`restart`), sin que `instances.js` tenga que
    saber que hwenc existe.
  - `ensureRuntimeReady(containerId)` (etapa 6): el `setprop` +
    reinicio de `mediaserver` que antes había que correr a mano después de
    cada boot fresco (se llamaba `ensureHwencReady` antes de esta
    convención). El runner lo agenda fire-and-forget después del `start`,
    mismo patrón que `scheduleWifiFixes`/`hwsimWifi.js`.

## Decisión de diseño: ¿por qué la etapa 5 se expone acá si ya vive en hwAccel.js?

Para que el runner genérico sea realmente genérico, no puede saber que
"hwenc" necesita "el daemon VA-API" — sólo sabe llamar a la función que el
manifest de un módulo declara para la etapa que corresponde. La alternativa
(que `instances.js` siguiera llamando a `hwAccel.ensureDaemonRunning()` a
mano, gateado por `img.hwEncCapable`) hubiera dejado a hwenc como caso
especial para siempre. En cambio, `ensureHostInfraReady()` es un wrapper de
una línea que delega en `hwAccel.js` — no se mueve ni se duplica lógica, sólo
se le pone el nombre que la convención espera.

## Por qué esto no viola la política de licencias (sección 6 de REQUIREMENTS.md)

El componente que este módulo integra es código propio (`redroid-hwenc`,
Apache-2.0, mismo autor) — no es GApps/Magisk. La restricción de "nunca
alojar el binario" es sobre software de terceros no libre; esto es libre y
nuestro, así que en principio se podría empaquetar sin problema legal. La
única razón por la que igual se baja como artefacto separado en vez de
compilarse en el build normal de `redroid-forge` es técnica: son binarios
Android/bionic que necesitan el toolchain completo de AOSP, no algo que un
`docker build` de una imagen Node/Alpine pueda hacer.

## Pendiente

- `REDROID_HWENC_ARTIFACTS_DIR` hoy apunta a una carpeta local de build de
  AOSP (`~/aosp-out-redroid15/...`) — cuando `redroid-hwenc` publique un
  release, este módulo debería descargarlo de ahí.
- `integrate.js` usa el CLI de `docker` vía `child_process` — válido para
  probar desde el host, pero el backend real de `redroid-forge` corre en una
  imagen Alpine sin ese CLI instalado. Portar a `dockerode`'s `putArchive()`
  (con uid/gid=0 en los headers del tar) sigue pendiente; ya está enganchado
  al flujo real de creación de instancias (Fase 5), así que este es ahora un
  blocker real para correrlo en producción, no una limitación teórica.
- Ninguno de los cuatro hooks (`prepareCreate`/`integrate`/
  `ensureHostInfraReady`/`ensureRuntimeReady`) se validó todavía contra un
  host real con Docker/redroid corriendo — sólo hay cobertura de unit tests
  con mocks (`backend/test/moduleRunner.test.js`). Antes de mergear a algo
  que se vaya a usar en vivo, correr el flujo completo (crear → integrar →
  arrancar → fixup) contra la imagen oficial de redroid en un host AMD/Intel.
- Ninguna imagen de `backend/images.json` declara `hwEncCapable: true`
  todavía — hasta que una lo haga, el gate nunca exige este módulo ni el
  runner nunca lo ejecuta en la práctica.
