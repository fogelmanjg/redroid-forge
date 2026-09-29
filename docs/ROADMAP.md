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

**Gate:** una instancia creada desde `redroid-forge` reproduce el mismo
comportamiento de aceleración ya validado por separado, en al menos un host
AMD/Intel y uno NVIDIA reales.

## Fase 3 — WiFi falso + device profile spoofing

**Dificultad: Media** — código ya escrito y probado en otro lado
(`jg-dashboard`), el trabajo es portarlo y adaptar las rutas de
`build.prop` que ya se sabe que varían por imagen.

**Pasos:**
1. Portar `DEVICE_PROFILES`/`buildDeviceProfileScript` de `jg-dashboard`
   (`redroid.service.ts`) al nuevo backend.
2. Confirmar que el WiFi falso portado en la Fase 0 sigue íntegro.
3. Validar aplicar/revertir un perfil (ej. `samsung`) desde la UI nueva.

**Gate:** el spoof de perfil se puede aplicar/revertir desde la UI nueva,
con los archivos de `build.prop` correctos según la imagen.

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
1. Diseñar la convención de módulo de usuario (manifest + script de
   entrada + contexto que recibe + cómo se agenda), usando como referencia
   Home Assistant Add-ons y/o el patrón drop-in tipo `cron.d`.
2. Implementar el mecanismo de scheduling/ciclo de vida (pause/resume/
   status) en el backend.
3. Portar el watchdog de CIFI sobre Redroid 15 usando esta convención, en
   reemplazo del script de cron + `flock` actual.
4. Validar en vivo varios días sin reaparición del bug de lock heredado.

**Gate:** CIFI corre como módulo dentro de `redroid-forge` (pause/
resume/status desde la app, no edición manual de cron), validado en vivo
sin que reaparezca el bug conocido.

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
1. Quitar el código de redroid de `jg-dashboard` y `plenum-redroid` (recién
   acá, nunca antes del gate de la Fase 7).
2. Escribir README/CONTRIBUTING/atribución definitivos, issue templates.

**Gate:** proyecto en condición de llamarse **beta 0.9** — a partir de acá
se retoma el mecanismo de donaciones/soporte (sección 8 de
`REQUIREMENTS.md`), no antes.

## Fuera de fases (bajo demanda, no bloquean nada de lo de arriba)

- Otros proyectos "grandes" a leer que puedan sumar algo (pendiente en
  `REQUIREMENTS.md` sección 10) — se evalúan e insertan en la fase que
  corresponda cuando se identifiquen, no generan una fase propia por sí
  solos.
