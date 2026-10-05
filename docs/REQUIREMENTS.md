# redroid-forge — Documento de requerimientos y política del proyecto

> Borrador vivo. Se ajusta a medida que surgen más decisiones. Todo lo marcado
> **[PENDIENTE]** es una decisión abierta, no un supuesto.

## 1. Objetivo

Dar un cierre de punta a punta a los proyectos redroid que hoy funcionan por
separado, consolidándolos en una única aplicación independiente
(`redroid-forge`), con backend y frontend propios, que:

- Reemplaza la necesidad de tocar cada proyecto por separado para gestionar
  instancias redroid.
- Se puede embeber o mostrarse dentro de `jg-dashboard` y de Plenum, pero no
  depende de ninguno de los dos para funcionar standalone.
- Aspira a ser un proyecto público y popular, no una herramienta interna.

**Por qué "forge" y no solo "manager" o "hub":** el proyecto es más que un
punto central de gestión — personalización profunda por instancia (módulos,
perfiles de dispositivo, aceleración por hardware) y export/import de
instancias entre PCs distintas. Es una forja de instancias, no solo un
tablero de control.

## 2. Alcance v1

- **Redroid 15 es la única versión con soporte oficial** (todos los módulos
  validados: hwenc, nvidia, wifi falso, device profile). No es una
  restricción dura de código — otras versiones no quedan bloqueadas, quedan
  marcadas como **comunidad** (ver "Tiers de soporte por imagen" más abajo).
- Se porta **todo lo ya probado y funcionando**, no se rehace desde cero:
  - Encode por hardware VA-API (AMD/Intel) + decode NVDEC — de `redroid-hwenc`.
  - Aceleración 3D (Venus-proxy) + encode NVENC para NVIDIA — de `redroid-nvidia`.
  - Ciclo de vida de instancias (create/start/stop/restart/delete), Doctor de
    host de solo lectura, registro de Android ID/GApps — de `redroid-manager`.
  - WiFi falso (hwsim) y device profile spoofing — hoy repartidos entre
    `redroid-manager` y `jg-dashboard`.
  - Checklist de prerrequisitos de host (binder legacy/binderfs, `loop`,
    `ext4`) documentado para Debian/btrfs.
  - Todo lo reutilizable del módulo redroid de `plenum-redroid` (misma lógica
    de reuso que con `jg-dashboard`, ver sección 4).

### Tiers de soporte por imagen (no una restricción dura)

**Versiones mantenidas (decidido 05/10/2026):** se mantienen en el catálogo
las **imágenes oficiales de Redroid 11, 13 y 15, y probablemente también 12 y
14** — siempre la imagen oficial sin modificar (ver "Base de datos de
combinaciones conocidas" más abajo), nunca imágenes armadas a mano. **Solo
Redroid 15 tiene soporte completo** (tier "oficial"); el resto es tier
"comunidad": se ofrecen y corren, pero sin garantía de que los módulos
funcionen. Una versión sube de tier únicamente cuando una combinación
validada entra en la base de datos.

Redroid 11 y 13 andan para algunas cosas (11 arranca y corre instancias
básicas; 13 se probó y funciona en `gpuMode: guest`), pero sin el resto de
los módulos (hwenc, nvidia, wifi falso) validados sobre esas versiones —
nunca se probaron ahí. En vez de bloquear su uso, el catálogo y los módulos
declaran esto como metadata, no como código especial por versión:

- Cada imagen en el catálogo (`backend/images.json`, ya tiene
  `androidVersion`/`gpuMode` por entrada) suma un campo **`soporte`**:
  `"oficial"` (solo Redroid 15) o `"comunidad"` (11, 13, cualquier otra que
  se agregue), con una nota corta de qué se sabe que anda (ej. "13: solo
  `gpuMode: guest`, sin hwenc ni wifi falso probados").
- Cada módulo (manifest de la sección 5) declara **con qué es
  compatible** (versión de Android, modo GPU). Si la imagen elegida no
  cumple, el módulo simplemente no se ofrece para esa instancia — nunca se
  rompe en silencio, se explica por qué no está disponible.
- La UI/Doctor muestra el tier de la imagen elegida de forma visible (ej.
  "✅ Oficial" vs "⚠️ Comunidad, sin soporte completo") — mismo criterio de
  transparencia que rige el resto del proyecto: nunca ocultar limitaciones.

### Base de datos de combinaciones conocidas (decidido 05/10/2026)

**Regla de base:** redroid-forge parte **siempre de la imagen oficial de
Redroid 15, sin modificar**. GApps, Magisk, hwenc, wifi falso y demás se
integran **por instancia, al crearla, solo si hace falta**, como módulos.
No se usan imágenes prearmadas/personalizadas: atan el proyecto a un build
host, mezclan contenido no libre (GApps) dentro de una imagen redistribuible
y hacen imposible razonar sobre qué está realmente corriendo.

**Soporte = combinación conocida, no "imagen".** El proyecto mantiene una
base de datos de combinaciones **validadas**. Cada entrada fija:

- **Base:** imagen oficial identificada por **digest `sha256`**, no por tag
  (`15.0.0-latest` es un tag móvil: dos hosts pueden bajar cosas distintas).
- **Paquete GApps:** versión, origen y `sha256` conocidos.
- **Versión de Magisk** (si aplica): versión y `sha256`.
- **Módulos** y sus versiones de manifest validados sobre esa base.
- **Hardware** sobre el que se validó (tabla estilo `redroid-hwenc`: AMD
  Polaris/Vega, Intel Iris Xe, NVIDIA...) y fecha de validación.

Consecuencias:

- Una combinación presente en la base es **tier "oficial"**: es lo que el
  proyecto validó y a lo que responde ante un reporte de error. **No es una
  garantía** (software libre, sin garantías): significa "validada con
  evidencia verificable" — el usuario puede repetir los chequeos en su host
  (ver `docs/BASE-COMBINACIONES.md` §1.1). El primer
  filtro de cualquier reporte es "¿es una combinación conocida?".
- Una imagen base, paquete GApps o versión de Magisk **fuera de la base** no se
  bloquea (coherente con los tiers de arriba), pero queda **sin soporte** y
  con advertencia visible en UI/Doctor, y se ofrecen solo los módulos que
  puedan garantizarse sobre ella.
- Los binarios de terceros (GApps, Magisk) se **verifican contra el `sha256`
  de la base antes de usarse**; si no coincide, no se inyectan. Nunca se
  descarga "la última versión" sin fijar.
- El módulo GApps/Magisk recibe su origen y checksum **de la base**, no los
  trae hardcodeados en su manifest.

**La base vive en un repositorio externo**, separado del código de
redroid-forge, y es **actualizable** por el usuario:

- Cada release de redroid-forge **incluye un snapshot** de la base con lo
  último conocido al momento de liberarla (así funciona offline y es
  reproducible por versión).
- Opcionalmente (acción explícita del usuario, nunca silenciosa) se puede
  **actualizar la base** desde el repositorio externo para ver combinaciones
  validadas después de esa release, sin esperar una versión nueva.
- La base actualizada se **verifica** (firma o hash publicado) antes de
  reemplazar el snapshot; si falla, se conserva el anterior.
- **[PENDIENTE]** formato exacto (JSON/YAML), nombre y ubicación del
  repositorio, mecanismo de verificación (firma vs. hash), y cómo se aportan
  combinaciones nuevas (PR con evidencia de validación).

- **CIFI (watchdog de reapertura automática) migra de Redroid 11 a Redroid
  15.** Se había dejado en 11 por menor consumo de recursos frente al encoder
  por software que exigía 15 en ese momento — pero con aceleración 3D +
  decode + encode por hardware ya resueltos en 15 (`redroid-hwenc` +
  `redroid-nvidia`), la expectativa es que 15 consuma menos que 11 con
  software encoding. Ya confirmado que corre bien en 15. Sirve además como
  caso piloto real para el módulo de extensibilidad de usuario (sección 5).

## 3. Arquitectura

- **Monorepo.** Todo el código de los proyectos consolidados vive junto en
  `redroid-forge`, no como submódulos ni dependencias externas separadas.
- **Aplicación independiente** con su propio backend y frontend — no requiere
  Plenum ni `jg-dashboard` para operar (mismo principio que ya regía para
  `redroid-manager`: "un `docker compose up` y andás"). Esta separación de
  Plenum no fue nunca para evitar complejidad — es para que le sirva a
  cualquiera, no solo a instalaciones propias. Coherente con el objetivo de
  que el proyecto le pueda interesar a más gente, no solo al propio uso
  personal.
- **Integrable, no dependiente:** expone lo necesario (API, embed, SSO) para
  que Plenum o `jg-dashboard` lo muestren/orquesten si el usuario lo quiere,
  sin que esa integración sea obligatoria.
- **Stack técnico: Node.js + Express**, sin framework pesado ni build step
  obligatorio, `dockerode` para gestión de contenedores. Continuidad directa
  con `redroid-manager` (ya probado end-to-end) — se porta el código
  existente (`binder.js`, `hwsimWifi.js`, `androidIdentity.js`) en vez de
  reescribirlo. Frontend vanilla HTML/CSS/JS; si el modal de contrato de
  módulo (sección 5) necesita más interactividad, se sube un escalón liviano
  (ej. Alpine.js/htmx) antes que saltar a un framework SPA completo.

## 4. Relación con jg-dashboard y plenum-redroid (migración y convivencia)

- **`jg-dashboard` deja de tener redroid integrado y pasa a ser consumidor**
  de `redroid-forge` (vía su API/embed), en vez de tener su propio
  código de gestión de instancias redroid.
- Al portar, **se reutiliza todo lo posible** del código real que ya tiene
  `jg-dashboard` (ej. device profile spoofing —`DEVICE_PROFILES`,
  `buildDeviceProfileScript`, etc. en `redroid.service.ts`) en vez de
  reescribirlo.
- **`plenum-redroid` sigue la misma política que `jg-dashboard`**: deja de
  tener el módulo integrado, pasa a consumir `redroid-forge`, y se
  reutiliza lo posible de su lógica al portar.
- **Convivencia explícita durante la transición:** el código y las ventanas
  actuales de redroid en `jg-dashboard` y en `plenum-redroid` **no se tocan
  ni se quitan** hasta que `redroid-forge` esté totalmente funcional.
  Ambos caminos conviven en paralelo mientras dura la migración — recién
  cuando el reemplazo funciona de punta a punta se da de baja el código
  viejo.
- **Destino del código viejo (decidido 05/10/2026):** cuando `redroid-forge`
  lo reemplace, **todo el código de redroid de `jg-dashboard` y de
  `plenum-redroid` se elimina** de esos proyectos. No se mantiene ni se
  conserva como camino de compatibilidad. El código anterior queda **en GitHub
  como un proyecto viejo, muerto y reemplazado por `redroid-forge`** (solo como
  historial). Antes de eliminar, hay que **asegurar que ese código esté
  realmente en GitHub** (ver Fase 8 del `ROADMAP.md`; `plenum-redroid` ya se
  archivó en `fogelmanjg-plenum/plenum-redroid`, privado, como proyecto que no
  logró sus objetivos).
- **El visor web `ws-scrcpy` no se porta.** Está deprecado desde 2026-07-02
  (se creó cuando no se podía acceder a scrcpy desde Android; hoy se usa scrcpy
  directo y el visor ya no tiene sentido). Ninguna instancia del dashboard lo
  usa y su infraestructura (redis, secretos OAuth) ya no existe.
- `jg-escritorio` (xpra + Docker) **no es relevante para este proyecto por
  ahora** — queda fuera del alcance.

## 5. Modularidad y consentimiento explícito

Todo componente que no sea 100% software libre, o que dependa de una elección
del host, se trata como **módulo externo**, nunca como parte fija del core:

- CPU/RAM asignados a la instancia.
- Modo GPU: host vs soft (guest).
- WiFi falso (hwsim) sí/no.
- GApps sí/no.
- Magisk sí/no.

**Flujo obligatorio para cualquier módulo no libre o de terceros:**

1. El frontend muestra el **contrato** del módulo antes de activarlo: qué es,
   qué hace, qué permisos/recursos toca, y que **no es parte del proyecto**
   (aviso explícito).
2. El usuario acepta explícitamente.
3. Recién ahí el backend ejecuta el script o descarga/integra el componente.

Nada de esto se salta por usabilidad — la usabilidad se resuelve haciendo el
flujo fácil de aceptar, no haciéndolo invisible.

### Dos niveles de módulo

- **Módulos propios** (WiFi falso, device profile spoofing, elección de
  CPU/RAM, modo GPU host/soft) — código del proyecto, no de terceros. El
  contrato es puramente informativo: qué implica técnicamente y qué riesgos
  tiene, sin el disclaimer de "no es parte del proyecto".
- **Módulos de terceros no libres** (GApps, Magisk) — mismo contenido
  informativo, más el disclaimer obligatorio de la sección 6: licencia real,
  origen, y que no es parte de `redroid-forge`.

### Formato del contrato: manifest por módulo

Cada módulo se describe con un manifest estructurado (JSON/YAML), versionado,
leído genéricamente por el frontend para renderizar el mismo modal de
contrato sin programar una pantalla especial por módulo:

```yaml
id: gapps
nombre: "Google Apps (GApps)"
esTerceroNoLibre: true
licencia: "Propietaria (Google)"
origen: "https://opengapps.org"
descripcion: "Instala servicios de Google Play en la instancia."
queToca:
  - "modifica /system dentro del contenedor"
  - "descarga un paquete de un servidor externo (no controlado por este proyecto)"
compatibleCon:
  androidVersion: [15]
  gpuMode: ["host", "guest"]
version: 1
```

El backend solo ejecuta la integración del módulo si existe un registro de
"usuario aceptó manifest versión N"; si el manifest sube de versión (cambia
el disclaimer o lo que toca), se pide aceptación de nuevo. `compatibleCon`
es lo que decide si el módulo se ofrece o no para la imagen elegida (ver
"Tiers de soporte por imagen" en la sección 2) — si la imagen no cumple, el
módulo no aparece como opción, con una explicación de por qué.

### Extensibilidad: módulos definidos por el usuario

El catálogo de módulos **no es una lista cerrada** (GApps/Magisk/wifi/GPU/
CPU-RAM) — tiene que existir una convención genérica para que cualquiera
agregue su propio módulo sin tocar el core, del mismo tipo que un watchdog o
cualquier script de automatización por instancia.

**Caso de referencia real:** el watchdog de CIFI (reabre un juego que
crashea, taps por ADB, corre cada 15 min) hoy vive como script de cron +
`flock` suelto en el host, completamente afuera de cualquier app — exacto el
tipo de cosa que debería declararse como módulo en vez de vivir como
infraestructura ad hoc:

- Mismo manifest de la sección anterior (nombre, descripción, qué toca) más
  un **script/binario de entrada** que el backend invoca con contexto de la
  instancia (puerto ADB, serial, etc.).
- Ciclo de vida esperado: programable (periódico, como el cron actual) y
  expone al menos pause/resume/status — igual que ya tiene
  `cifi-watchdogctl.sh` hoy a mano.
- Al ser código del propio usuario (no del proyecto), pasa igual por el
  contrato de consentimiento — corre bajo su responsabilidad.

**[PENDIENTE]** convención exacta: qué variables de entorno/argumentos recibe
el script, cómo se registra el scheduling, si corre dentro del contenedor de
la instancia o fuera, en el proceso del backend. CIFI watchdog es el caso
piloto para validar esto en la práctica al portarlo.

**Referencias de otros proyectos, para cuando se retome (sin decisión tomada
todavía):** Home Assistant Add-ons (manifest + schema tipado de opciones +
declaración explícita de capacidades/permisos, UI de config auto-generada);
convención drop-in tipo `cron.d`/`sites-enabled` (carpeta autocontenida por
módulo, sin instalación); Docker CLI plugins (binario descubierto por
convención de nombre, contexto por flags/env); labels de Docker estilo
Traefik/Watchtower (módulo se engancha leyendo labels del propio contenedor).
Un "app store" comunitario estilo HACS queda para cuando haya comunidad, no
para v1.

## 6. Política de licencias y contenido de terceros

- **Nada de software de terceros dentro del código o las imágenes**, salvo que
  sea 100% libre (licencia FOSS real, no "gratis" ni "freeware").
- GApps, Magisk, y cualquier otro componente no libre **nunca se empaquetan**
  — se integran en runtime como módulo externo (ver sección 5), bajo
  consentimiento explícito del usuario, corriendo en su propia infraestructura.
- Ningún atajo legal por comodidad: si un módulo no es libre, pasa por el
  flujo de contrato + consentimiento sin excepción, sin importar cuánto
  complique la UX.
- **La regla es sobre el origen del binario, no sobre el empaquetado.** No
  alcanza con "no lo metemos en una imagen Docker" si el binario de todas
  formas sale de algo que aloja `redroid-forge` (un tarball propio, una
  imagen derivada, o — el caso real encontrado el 28/09 — el propio árbol
  fuente de AOSP que compilamos). El componente no libre siempre tiene que
  descargarse de su fuente oficial real, en el momento en que el usuario lo
  pide. Ver `ARQUITECTURA.md` para el modelo completo (las 6 etapas del
  ciclo de vida de una instancia) y el caso concreto de `vendor/gapps`
  mezclado en el source de AOSP que motivó esta aclaración.

## 7. Autenticación e integración con Plenum / jg-dashboard

- **Seguridad opcional** — el core funciona sin auth (para uso standalone
  simple), igual que `redroid-manager` hoy.
- Cuando se activa, puede consumir:
  - Keycloak directamente.
  - Keycloak a través de Plenum o `jg-dashboard` (SSO delegado).
  - O el reemplazo que se elija en el futuro (no atado a Keycloak por diseño).
- Es un *bolt-on* activado por configuración, no una dependencia oculta del
  core (mismo principio ya acordado para `redroid-manager` con Plenum).

## 8. Monetización

- **100% código abierto, licencia Apache License 2.0** — objetivo es
  adopción/popularidad, no proteger el código. Misma familia que usa redroid
  para su proyecto principal (consistencia con el upstream) y
  con grant de patentes explícito, relevante por el encode/decode de video
  por hardware (VA-API, NVENC) que toca el proyecto.
- **Nada oculto ni necesario-pero-no-disponible**: todo lo que hace falta
  para que el proyecto funcione completo está en el repo público.
- Monetización vía **donaciones** y **venta de soporte** (para lo difícil o lo
  que alguien no quiera hacer por su cuenta) — nunca features pagas, nunca
  código premium separado.
  - **No se avanza sobre esto todavía.** Se retoma recién en una beta 0.9,
    cuando el proyecto esté en un punto en que se pueda decir que es
    "razonablemente seguro" descargarlo e instalarlo.
- Ningún flujo hace sentir al usuario "usado" — sin telemetría oculta, sin
  fricción artificial para empujar a pagar.
- **Tampoco se puede sentir usado/atacado ningún proyecto upstream** (redroid
  y cualquier otro proyecto del que se use código o funcionalidad):
  - `redroid-forge` se posiciona explícitamente como **frontend/manager
    cómodo sobre lo que esos proyectos ya construyeron**, no como reemplazo
    ni competencia.
  - Reconocimiento y atribución clara y visible (README, créditos en la app,
    licencias originales preservadas) a cada proyecto de origen.
  - Colaborar con esos proyectos cuando tenga sentido (reportar bugs, mandar
    PRs, avisar del proyecto) en vez de solo consumir en silencio.

## 9. Decisiones ya tomadas

| Tema | Decisión |
|---|---|
| Estructura de código | Monorepo |
| Nombre | `redroid-forge` (verificado libre en GitHub, npm y Docker Hub — se descartó `jg-redroid-manager` por demasiado personal, y `redroid-manager` a secas por estar tomado y ser un espacio ya poblado) |
| Ubicación | Repo nuevo standalone en GitHub (no dentro de Plenum) |
| Visibilidad | **Público** (implicado por el objetivo de popularidad — ver sección 8) |
| Versión de Android objetivo | Imágenes oficiales 11, 13 y 15 (probablemente 12 y 14); soporte completo solo en 15 = tier "oficial"; el resto "comunidad", no bloqueadas (sección 2) |
| `jg-dashboard` | Deja de tener redroid integrado, pasa a consumir `redroid-forge`; código viejo convive hasta que el nuevo esté completo |
| `plenum-redroid` | Misma política que `jg-dashboard` |
| `jg-escritorio` | Fuera de alcance, no relevante para este proyecto |
| Donaciones/soporte | Se retoma en beta 0.9, no ahora |
| Licencia | Apache License 2.0 |
| Contrato de módulo | Manifest estructurado (JSON/YAML) versionado por módulo, ver sección 5 |
| Stack técnico | Node.js + Express + `dockerode`, sin build step; frontend vanilla HTML/CSS/JS |
| CIFI | Migra de Redroid 11 a 15; entra como caso piloto de módulo de extensibilidad de usuario |
| Imágenes base | Solo la imagen oficial de Redroid 15, sin modificar; GApps/Magisk/etc. se integran por instancia. Soporte = combinación conocida (base por digest + GApps + Magisk + módulos) en una base de datos en repo externo, actualizable, con snapshot por release (sección 2) |
| Catálogo de módulos | No es cerrado — existe convención para módulos definidos por el usuario, ver sección 5 |

## 10. Pendiente / abierto

- **[PENDIENTE] Base de datos de combinaciones conocidas** (sección 2, diseño
  en `docs/BASE-COMBINACIONES.md`). Decidido: repo externo `redroid-forge-db`,
  firma ed25519 (primera firma al liberar la primera versión usable
  completa), chequeo diario y al abrir la app (aplicar es explícito). Falta:
  formato final del archivo y el modelo de mantenimiento a escala (§6.1 del
  doc) cuando haya más colaboradores.
- **[PENDIENTE] Mecanismo de donaciones/soporte** — recién se decide en beta
  0.9 (GitHub Sponsors, Open Collective, contrato de soporte directo, etc.).
- **[PENDIENTE] Convención exacta de módulos definidos por el usuario**
  (sección 5) — contrato de script, scheduling, contexto de instancia.
- **[PENDIENTE] Otros proyectos "grandes" a leer más allá de los ya
  confirmados** (fake-wifi/android-identity, host prerequisites/doctor,
  `jg-dashboard`, `plenum-redroid`, CIFI watchdog).
