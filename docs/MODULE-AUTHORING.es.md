# Escribir un módulo

Esta es la referencia única para "quiero agregar un módulo" — nativo vs. módulo
vs. módulo de usuario, el schema del manifiesto, y el contrato completo de
hooks etapa por etapa. La política detrás de todo esto vive en `REQUIREMENTS.md`
§5 y §6; la narrativa de diseño (por qué se tomó cada decisión, en orden
cronológico) vive en `ARCHITECTURE.md`. Este documento solo repite lo necesario
para **construir** algo, sacado del validador de schema real (`moduleManifests.js`)
y del runner (`moduleRunner.js`), no de prosa.

## 1. ¿Nativo, módulo propio, o módulo de usuario?

Tres cosas distintas se llaman "un módulo" sueltamente en la conversación. No
son la misma decisión, y confundirlas es como se termina hinchando el núcleo o
sobre-ingenierizando un simple flag.

| | **Nativo (núcleo)** | **Módulo propio** | **Módulo de usuario** |
|---|---|---|---|
| Quién lo escribe | El proyecto | El proyecto | Cualquiera, afuera del repo |
| ¿Opcional? | No — existe para todo deployment, la política sí puede apagar su *comportamiento* (ej. modo single-user/sin login) | Sí — una instancia se puede crear sin él | Sí, por construcción |
| Ejemplo | auth/usuarios/OIDC, el motor de capabilities, el ciclo de vida de la instancia en sí | fake WiFi, device profile spoofing, elección de CPU/RAM, modo GPU, hwenc/hwdec, arm-translation, redroid-gralloc-fix, GApps, Magisk | el watchdog de CIFI (caso piloto) |
| ¿Pasa por el contrato de consentimiento? | No | Sí (§5) | Sí (§5) — explícitamente "corre bajo su propia responsabilidad" |
| Mecanismo | código plano, sin manifiesto | manifiesto + `etapa`/`entry` opcional (§2 abajo) | exactamente la misma convención de manifiesto + `etapa`/`entry` que un módulo propio |

**El criterio para "nativo vs. módulo" no es "esto es opcional en principio" —
es "¿necesita otro código depender de que esto exista, independientemente de
si está prendido?"** Auth es el ejemplo canónico (decidido el 27/10/2026): toda
ruta necesita *alguna* decisión del motor de capabilities, incluso cuando esa
decisión es "permitir, no hay login configurado" — así que la columna vertebral
del enforcement es nativa, y single-user/sin-login es un flag de política
encima de eso, no un módulo faltante. Un módulo, en cambio, es algo cuya
ausencia completa es una configuración válida y común (una instancia sin
override de modo GPU, sin GApps, sin watchdog — la mayoría de las instancias
se saltan la mayoría de los módulos).

**El criterio para "propio vs. de usuario" es autoría/confianza, no mecanismo.**
Un módulo de usuario usa el mismo contrato de manifiesto/`etapa`/`entry` que un
módulo propio — nada en el runner ni en el gate los distingue. Lo que difiere
es que no fue escrito ni revisado por el proyecto, así que la pantalla de
consentimiento lleva el mismo encuadre "esto no es parte del proyecto" que
reciben los módulos de terceros no libres (§5, "Dos niveles de módulo"), aunque
el módulo en sí sea software libre. Si estás escribiendo algo para el catálogo,
es un módulo propio. Si estás escribiendo algo solo para tu propia instancia,
es un módulo de usuario — mismo formato, lo dejás en `backend/src/modules/<id>/`
(o apuntás la carga estilo `MANIFESTS_DIR` ahí, ver `moduleManifests.loadAll()`)
y funciona igual.

## 2. El manifiesto

Un manifiesto por módulo, `backend/src/modules/<id>/manifest.json` si tiene
`entry`, o un archivo plano en `backend/src/modules/manifests/<id>.json` si es
un módulo de "puro contrato" sin lógica de ejecución propia (ver §4). Ambas
ubicaciones se escanean igual — este split existe solo para evitar conflictos
de merge entre módulos no relacionados, no porque el schema sea distinto.

Los nombres de campo están en español — este es el formato real y validado, no
una capa de traducción (`nombre`, `descripcion`, `queToca`=qué toca,
`licencia`, `origen`, `compatibleCon`).

```json
{
  "id": "mi-modulo",
  "nombre": "Nombre legible para humanos",
  "esTerceroNoLibre": false,
  "descripcion": "Qué hace esto, para la pantalla de consentimiento.",
  "queToca": [
    "una viñeta por cada cosa concreta que toca — archivos, procesos, llamadas de red"
  ],
  "compatibleCon": {
    "androidVersion": [15],
    "gpuMode": ["host", "guest"]
  },
  "version": 1,
  "etapa": [4],
  "entry": "./integrate.js",
  "i18n": { "es": { "nombre": "...", "descripcion": "...", "queToca": ["..."] } }
}
```

**Obligatorio en todo manifiesto** (lo valida `moduleManifests.validateManifest`,
tira error y se niega a cargar si no está): `id`, `nombre`, `descripcion`
(strings no vacíos), `esTerceroNoLibre` (booleano), `queToca` (array no vacío),
`compatibleCon.androidVersion` y `compatibleCon.gpuMode` (arrays no vacíos),
`version` (entero ≥ 1). `id` tiene que ser único entre ambas ubicaciones de
manifiesto combinadas — un duplicado tira error al cargar.

**Obligatorio solo si `esTerceroNoLibre: true`:** `licencia`, `origen` — esto es
lo que llena el disclaimer obligatorio de terceros (§6 de `REQUIREMENTS.md`).
Un módulo propio o de usuario libre debería dejar esto en `false`.

**Opcional:**
- `compatibleCon.hostGpuVendor` (array, ej. `["amd", "intel"]`) — solo se
  chequea si está presente; dispara una detección real de `lspci`
  (`hwAccel.detectGpuVendor()`) la primera vez que algún módulo requerido de una
  instancia lo declara, cacheada para ese chequeo.
- `etapa` + `entry` — ver §3/§4. Un módulo sin ninguno de los dos es un módulo
  de "puro contrato": muestra la pantalla de consentimiento y nada más, el
  runner nunca lo toca.
- `i18n.es.*` — traducciones al español de `nombre`/`descripcion`/`queToca`,
  usadas por el modal de consentimiento del frontend. No se valida como
  obligatorio, pero todo módulo publicado lo tiene.

**Versionado:** subí `version` cada vez que cambie `queToca` o algún campo
relevante al disclaimer. `moduleGate.check()` compara la versión actual del
manifiesto contra la última aceptación registrada del usuario
(`moduleAcceptance.isAccepted`) — un bump de versión vuelve a disparar el
consentimiento en el próximo create/start, no se pregunta una sola vez para
siempre.

## 3. Las 7 etapas

Las etapas 1-2 son sobre **imágenes** (la imagen oficial de redroid, y una
imagen derivada construida una vez vía `docker commit` para reusar entre
instancias) — no hay hook por módulo para ellas, un módulo que quiere vivir ahí
es un paso de build, no un hook en runtime. Las etapas 3-7 son las que el array
`etapa` de un manifiesto puede declarar, cada una con un nombre de export fijo
que el runner busca en `entry` por convención — nada se registra por nombre en
ningún otro lado:

| Etapa | Nombre exportado | Cuándo se llama | Argumentos | Ejecución |
|------:|---|---|---|---|
| 3 | `prepareCreate()` | antes de `docker create` | ninguno | serial, awaited; devuelve `{ binds?, cmd? }`, puramente aditivo (deduplicado, nunca pisa lo que ya decidió el núcleo) |
| 4 | `integrate(containerId, ctx)` | entre `docker create` y `docker start` | `containerId`, `ctx = { display: { width, height } }` | serial, awaited de punta a punta — una falla acá corta todo el create, nada después se ejecuta |
| 5 | `ensureHostInfraReady()` | antes de start/restart (create incluido) | ninguno | serial, awaited; tiene que ser idempotente — se llama en cada start, no solo el primero |
| 6 | `ensureRuntimeReady(containerId)` | después de start/restart | `containerId` | fire-and-forget — no bloquea la respuesta HTTP, una falla acá no puede tumbar el arranque de la instancia |
| 7 | `runTick(instanceId, containerId)` | cada `schedule.intervalMs`, mientras la instancia corre | `instanceId`, `containerId` | awaited por el scheduler (para status), pero un error tirado se captura y se registra, nunca se propaga — un tick malo no puede parar el timer |

**Por qué 4 vs. 6 es la distinción que más importa:** la etapa 4 corre una sola
vez, antes del primer boot, y persiste como parte del filesystem del contenedor
(esta es la única ventana en la que `/vendor` —y probablemente `/system`/
`/product`— es escribible; queda de solo lectura casi inmediatamente después
del primer boot). La etapa 6 corre cada vez que hace falta y no deja rastro
permanente — si el contenedor se recrea, simplemente vuelve a correr en el
próximo boot. Elegí 4 para "escribir archivos dentro de la imagen", 6 para
"arreglar algo de una instancia que ya está corriendo".

**Campo extra de manifiesto para la etapa 7:** `"etapa": [7]` requiere
`"schedule": { "intervalMs": N }` en el mismo manifiesto — la única etapa sin
un punto sensato del ciclo de vida al cual defaultear, así que
`validateManifest` lo hace obligatorio. El scheduler (`moduleScheduler.js`)
mantiene un `setInterval` por par `(instanceId, moduleId)`, arrancado
inmediatamente después de la etapa 6 en create/start/restart y limpiado en
stop/delete. Pausar/reanudar es un flag real y persistido
(`GET`/`POST /api/instances/:id/watchdogs`) — sobrevive un reinicio del
backend; un tick pausado igual *dispara* en su horario pero se saltea antes de
llamar a `runTick`, así que el módulo en sí nunca tiene que saber que se lo
saltearon.

**Un módulo solo exporta los hooks de las etapas que declara.** No se rompe
nada si un módulo de solo-etapa-4 no tiene `runTick` — el runner nunca lo busca.

**Hablale a una instancia corriendo vía `dockerRuntime.exec()` (dockerode),
nunca un proceso `adb` real lanzado desde tu módulo.** No es una preferencia de
estilo — el watchdog original de CIFI, basado en cron, tuvo un incidente real y
documentado donde un `adb start-server` lanzado heredó un file descriptor de
lock y nunca lo liberó después de un reinicio del host. Pasar por la API exec
de dockerode (lo que ya usa todo hook de etapa 3-7) esquiva esa clase entera de
bug.

## 4. Módulos de puro contrato (sin `entry`)

Si tu módulo es solo "mostrá esta pantalla de consentimiento, y después prendé
un flag que el núcleo ya lee" (GApps, Magisk, el toggle de fake WiFi hoy) — sin
`etapa`, sin `entry`. `moduleGate.js` lo sigue gateando igual (compatibilidad +
consentimiento), simplemente nunca llega a `moduleRunner.js`. Agregá lógica de
ejecución real (`etapa`/`entry`) recién cuando haya un hook de verdad que
correr; no agregues un `entry` no-op "por consistencia".

## 5. Hacerlo elegible por instancia

Declarar un manifiesto no alcanza para que alguien pueda pedir tu módulo en
`POST /api/instances {"modules": ["mi-modulo"]}` — hay que agregarlo a
`OPTIONAL_PER_INSTANCE` en `moduleGate.js`. Un módulo también puede (o en vez
de eso) **atarse a imágenes específicas del catálogo** vía
`requiredModuleIdsForImage()` en el mismo archivo, leyendo flags que ya están
en `backend/images.json` (el patrón que siguen `hasGapps`/`needsHwsimWifi`/etc.)
— ese es el lugar correcto para "esta imagen no funciona en absoluto sin X", a
diferencia de "el usuario puede querer X".

## 6. Si tu módulo depende de otro módulo/motor

Declaralo en tu propio manifiesto para que entre en el mismo contrato de
consentimiento que ya ve el usuario — nunca un `require()` plano que meta algo
de forma invisible. (Decidido el 22/10/2026, todavía no mecanizado — no existe
un campo `dependeDe` en el validador todavía; si te topás con esto, la política
está fija, el nombre del campo no.)

## 7. Implementaciones de referencia, leer en este orden

1. **`backend/src/modules/manifests/magisk.json`** — el caso más simple
   posible: puro contrato, tercero no libre, sin `entry` en absoluto.
2. **`backend/src/modules/cifi/`** (`manifest.json` + `watchdog.js`) — el
   ejemplo más limpio de una sola etapa: solo etapa 7, `schedule` real,
   pausar/reanudar real. El mejor punto de partida si estás escribiendo un
   módulo con forma de watchdog (propio o de usuario).
3. **`backend/src/modules/hwenc/`** (`manifest.json` + `integrate.js` +
   `README.md`) — el ejemplo más profundo, las cuatro etapas 3/4/5/6 en un
   solo módulo, más una explicación trabajada de por qué la etapa 5 es un
   wrapper delgado alrededor de lógica que en realidad vive en otro lado
   (`hwAccel.js`). Leé su README después de este documento, no en vez de él.

## 8. Scaffold mínimo

```
backend/src/modules/mi-modulo/
├── manifest.json      # id, nombre, descripcion, queToca, compatibleCon,
│                       # version, etapa, entry
└── integrate.js        # module.exports = { integrate(containerId, ctx) { ... } }
```

Después: agregá `mi-modulo` a `OPTIONAL_PER_INSTANCE` en `moduleGate.js` (§5
arriba) si debería poder pedirse por instancia, o cableálo en
`requiredModuleIdsForImage()` si una imagen del catálogo debería requerirlo
siempre. Nada más necesita saber que tu módulo existe — sin cambios en
`instances.js`, sin casos especiales en el runner. Esa genericidad es todo el
punto de la Fase 5.
