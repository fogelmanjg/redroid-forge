# Módulo: hwenc

Primer caso real de la convención de módulos descripta en `docs/ARQUITECTURA.md`
(etapas 4 y 5) y en la sección 5 de `docs/REQUIREMENTS.md`.

- **`manifest.json`** — contrato del módulo (qué toca, con qué es compatible),
  mismo schema que ya valida Fase 4 (`moduleManifests.js`), más dos campos
  nuevos que ese sistema todavía no lee: `etapa` (en qué momento del ciclo de
  vida de la instancia opera, ver `ARQUITECTURA.md`) y `entry` (el script que
  hace el trabajo real).
- **`integrate.js`** — la etapa 4: copia el componente Codec2 de VA-API
  dentro de `/vendor` de una instancia recién creada (todavía sin arrancar).
  Standalone, se puede correr suelto (`node integrate.js <containerId>`) o
  requerir desde el orquestador (`module.exports.integrate`).
- **La etapa 5 (el daemon corriendo en el host) no vive acá** — ya la
  resuelve `backend/src/lib/hwAccel.js` (`ensureDaemonRunning`), que este
  módulo no duplica. `integrate.js` solo deja los archivos listos del lado
  de la instancia; conectar el bind del socket y asegurar que el daemon esté
  arriba sigue siendo trabajo de `hwAccel.js` + `instances.js`.

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
  (con uid/gid=0 en los headers del tar) cuando esto se enganche al flujo
  real de creación de instancias en `instances.js`.
- El orquestador todavía no sabe leer `etapa`/`entry` del manifest ni
  invocar el script en el momento correcto (crear sin arrancar → inyectar →
  arrancar) — hoy se prueba a mano. Es el próximo paso real de esta pieza.
