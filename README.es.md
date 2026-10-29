# redroid-forge

[![version](https://img.shields.io/github/v/release/fogelmanjg/redroid-forge?label=version)](https://github.com/fogelmanjg/redroid-forge/releases)
[![support](https://img.shields.io/badge/support-Android_15_(official)-brightgreen)](docs/KNOWN-COMBINATIONS.es.md)

**Idiomas:** [English](README.md) | Español

> El idioma oficial de este proyecto es el **inglés**. Este archivo se ofrece por comodidad y
> puede no estar perfectamente actualizado o traducido — ante cualquier duda, [README.md](README.md)
> (inglés) es la fuente de verdad.

App standalone (frontend + backend en un solo contenedor) para manejar instancias
[redroid](https://github.com/remote-android/redroid-doc) en cualquier PC que solo tenga Docker,
sin depender de ninguna otra infraestructura.

> Proyecto en construcción — consolida en un solo lugar varios proyectos separados
> (`redroid-manager`, `redroid-hwenc`, `redroid-nvidia`, y lo que hoy vive repartido en
> `jg-dashboard`/`plenum-redroid`). Ver [`docs/REQUIREMENTS.es.md`](docs/REQUIREMENTS.es.md) (qué y por
> qué), [`docs/ARCHITECTURE.es.md`](docs/ARCHITECTURE.es.md) (cómo encajan las piezas — imagen base,
> módulos, y en qué momento del ciclo de vida de una instancia se toca cada uno),
> [`docs/MODULE-AUTHORING.es.md`](docs/MODULE-AUTHORING.es.md) (cómo escribir un módulo — nativo vs.
> módulo propio vs. módulo de usuario, el schema del manifiesto, el contrato de las 7 etapas) y
> [`docs/ROADMAP.md`](docs/ROADMAP.md) (en qué orden; solo en inglés) y
> [`CHANGELOG.md`](CHANGELOG.md) (releases etiquetados, política de versionado; solo en inglés) para
> el panorama completo. Lo que hay hoy corresponde a las **Fases 0 a 7, más la Fase 9** (port-knocking,
> hecha fuera de orden porque no depende de la Fase 8) del roadmap — todo lo de la tabla de Features
> más abajo — con la Fase 8 (federación con `jg-dashboard`/Plenum) como próximo paso. Ver
> [`CHANGELOG.md`](CHANGELOG.md) para el detalle, tag `v0.3.0`.

## Features

Qué hace hoy, y qué sigue pendiente. "Oficial" vs. "comunidad" abajo es la distinción de tier de
soporte propia del proyecto (ver [`docs/KNOWN-COMBINATIONS.es.md`](docs/KNOWN-COMBINATIONS.es.md)):
oficial significa validado con evidencia en hardware real, no una garantía.

| | Estado | |
|---|---|---|
| **Ciclo de vida de instancias** | ✅ | Crear/arrancar/parar/reiniciar/borrar desde una UI web. Resize de CPU/RAM en vivo (sin restart). Cambios de resolución/DPI/FPS/modo GPU recrean el contenedor pero conservan sus datos. |
| **Encode de video por hardware** | ✅ AMD · Intel | VA-API, validado en hardware real Polaris/Vega/Iris Xe. "Cada instancia usa en hardware todo lo que ofrece la GPU del host" — nada escondido detrás de un tier fijo de capacidad. |
| **Decode de video por hardware** | ✅ AMD · Intel | H.264/HEVC/VP9/VP8 según lo que realmente soporte la GPU del host (Doctor muestra cuáles). |
| | 🧪 NVIDIA | NVENC/NVDEC existen como prueba del mecanismo (un solo frame intra, sin B-frames) — todavía no para uso real. |
| **Base de combinaciones conocidas** | ✅ | Base firmada, versionada, anti-rollback de qué combinaciones imagen+módulo están realmente validadas. Se chequea sola, se muestra por instancia, nunca bloquea — una combinación no validada igual corre, solo queda marcada "comunidad". |
| **Módulos opcionales, con consentimiento** | ✅ | Google Apps/Play Store, traducción ARM (apps arm64 en x86), WiFi falso, device profile spoofing, modo GPU — cada uno detrás de un diálogo de contrato explícito la primera vez que se usa, nunca habilitado en silencio. |
| | 📝 planeado | Magisk (el manifest existe, falta la integración real). |
| **Watchdogs definidos por el usuario** | ✅ piloto | Scripts periódicos por instancia (pause/resume/status desde la UI, sin cron para editar a mano) — CIFI (la lógica de reconexión de un juego puntual) ya portado y corriendo como primer caso; el mecanismo es genérico para sumar más. |
| **Backup y restore** | ✅ | Backup/restore de toda la instancia (tar.gz vía un contenedor descartable), reset opcional del Android ID, un aviso (nunca un bloqueo) al restaurar sobre una instancia con módulos/versión de GApps distinta. |
| **Control de acceso** | ✅ | Tres roles (admin/operator/viewer) con ownership por instancia. Pluggable: `none` (default, sin fricción), `local` (cuentas propias), `oidc` (cualquier cantidad de identity providers a la vez — Keycloak, Google, Plenum, otra federación, ... — roles asignados acá, nunca leídos del proveedor), `both` (local y OIDC en la misma pantalla de login). Una cuenta local también puede entrarse por una identidad OIDC vinculada (opt-in, probado logueándose de ambos lados a la vez — nunca por matchear un email declarado). Un asistente crea el primer admin en caliente desde modo `none`, y un guard de auto-bloqueo evita que `local`/`both` se conviertan en una puerta cerrada para siempre. |
| **Control de exposición de red** | ✅ | La app y cada instancia bindean a `127.0.0.1` solamente, por defecto — redroid en sí no tiene ningún control de acceso propio. Se puede optar por cualquier interfaz específica (o todas) por instancia y para la app en sí, desde la UI; las interfaces internas de Docker/contenedores (`docker0`, `br-*`, `veth*`, ...) quedan filtradas de ese selector por defecto, con override de admin. |
| **Doctor** | ✅ | Diagnóstico del host con el comando exacto para arreglar lo que falta — solo diagnostica, nunca ejecuta nada solo. |
| **Visualización de pantalla** | ✅ | Scripts de conexión scrcpy (`connect.sh`/`connect.ps1`), un puerto para ver desde un dispositivo Android mismo, sin visor web embebido por diseño (ver abajo). |
| **Federación** | 📝 planeado | `jg-dashboard` y Plenum pasando a consumir esta app vía `oidc`, reusando el identity provider que cada host ya tiene en vez de un login aparte. |
| **Port knocking** | ✅ hecho | Gate SPA (`fwknop`) por instancia y por interfaz para el puerto ADB/scrcpy, encima de los controles de red de arriba -- se abre desde la UI por una sesión ya autenticada, nunca por el dispositivo que se conecta. |

## Casos de uso

**Jugar un juego Android en Linux, con aceleración real de GPU.** Crear una instancia con
`gpuMode: host` y GApps habilitado, instalar el juego desde Play Store, conectarse con scrcpy
(ver ["Ver la pantalla desde otra PC"](#ver-la-pantalla-desde-otra-pc-scrcpy--ej-una-tv-con-una-notebook-vieja)
más abajo) y jugar — la misma GPU del host que correría un emulador Android nativo maneja el
render real, no un fallback por software.

**Revivir una tablet o celular viejo como cliente liviano.** El dispositivo en sí casi no hace
nada: solo necesita una app con scrcpy (ver [ScrcpyForAndroid](https://github.com/Miuzarte/ScrcpyForAndroid)
más abajo) y un camino de red hasta el puerto ADB de la instancia. La instancia — y todo lo que
necesita para andar bien — vive en la PC que realmente tenga el CPU/GPU para eso, así que
hardware demasiado débil para correr Android moderno él mismo sigue siendo de sobra para solo
mostrarlo.

**Conectar a una TV, con una notebook vieja como "consola".** Misma idea, pensada para el living:
la notebook solo corre un cliente scrcpy (mucho más liviano que correr Android localmente), la
instancia real corre en un servidor con recursos de verdad, y la TV solo muestra lo que esa
notebook manda por HDMI. Ver los scripts de conexión más abajo para que esto sea un lanzamiento de
un solo comando en vez de tipear el par `adb connect`/`scrcpy` a mano cada vez.

**Montar una granja para testeo o automatización.** Todo acá pasa por una API HTTP plana
(`GET`/`POST /api/instances`, …) — levantar y tirar abajo instancias desde un script, correr el
mismo APK en varias versiones de Android, o manejar una instancia sin humano de por medio (nadie
abriendo nunca una ventana de scrcpy) para un job de CI o un bot. El mecanismo de **watchdog
definido por el usuario** (CIFI hoy) está pensado justo para esto: un chequeo/acción periódico por
instancia sin cron para editar a mano por host, y el mismo mecanismo de **backup/restore** que
protege los datos de guardado de una instancia personal también sirve para sacarle una foto a un
entorno de test conocido-bueno y restaurarlo entre corridas.

## ⚠️ Imágenes con GApps: registrar el Android ID dentro de las 48hs

Las imágenes con Google Apps (`hasGapps: true` en el catálogo) reciben un Android ID (GSF) de
Google apenas bootean. **Si ese ID no se registra a mano en
[google.com/android/uncertified](https://www.google.com/android/uncertified) dentro de las 48hs
del primer boot, Google bloquea el acceso a GApps en esa instancia** — es un dispositivo no
certificado (redroid + Magisk), y ese registro es la forma de evitar el bloqueo. No es algo que
el código pueda hacer solo, es un paso humano.

La app ayuda a que no se pase por alto:
- La tab **Instancias** muestra el Android ID de cada instancia con GApps, con un link directo
  para registrarlo y un botón "Ya lo registré" una vez hecho.
- La tab **Doctor** lista como pendiente (⚠️, y ❌ si ya venció el plazo) cualquier instancia con
  GApps sin registrar.

## Módulos de terceros / no libres: contrato antes de activarlos

Todo lo que no es 100% software libre (GApps, Magisk) o depende de una elección del host
(WiFi falso, device profile, modo GPU) se declara con un **manifest** versionado (un
`manifest.json` por módulo bajo `backend/src/modules/`) en vez de tener su propia lógica de
habilitación. El backend nunca crea ni arranca una instancia que requiera un módulo sin una
aceptación vigente de su manifest — si falta, responde `428` con el contrato pendiente, el
frontend lo muestra (mismo diálogo genérico para todos, `frontend/contracts.js`), y solo tras
aceptarlo se reintenta. Ver la tab **Módulos** en la UI y la sección 5 de
[`docs/REQUIREMENTS.es.md`](docs/REQUIREMENTS.es.md) para el detalle completo (incluye
`compatibleCon`: un módulo no se ofrece si la imagen elegida no lo soporta).

## Requisitos del host

- Docker instalado y el daemon corriendo.
- Kernel con soporte de `binder` (estándar en kernels de Ubuntu recientes) y `binderfs`
  montable en `/dev/binderfs`.
- Si vas a usar imágenes con WiFi falso (`needsHwsimWifi`): módulo `mac80211_hwsim` cargable.
- Si querés aceleración de GPU (`gpuMode=host`): drivers de GPU instalados en el host.

No hace falta instalar Node, sudoers especiales, ni nada más en el host — el propio contenedor
de `redroid-forge` corre `--privileged --pid=host --network=host` y hace todo desde ahí.

## Llevar la imagen redroid a esta PC

Si la imagen se armó en otra máquina:

```bash
docker save <imagen> | gzip > imagen.tar.gz
# copiar el archivo a esta PC, después:
gunzip -c imagen.tar.gz | docker load
```

Si está pusheada a un registry propio:

```bash
docker pull <tu-registry>/<imagen>
```

El catálogo de imágenes conocidas vive en [`backend/images.json`](backend/images.json) —
agregar ahí cualquier imagen nueva (id, tag Docker, label, `gpuMode`, `needsHwsimWifi`).

## Levantar la app

```bash
docker compose up -d --build
```

La UI queda en `http://<ip-de-esta-pc>:8080` (o el puerto que pongas en `PORT`, ya que corre en
`network_mode: host`). Entrar a la tab **Doctor** primero: te dice exactamente qué falta en este
host y el comando para resolverlo antes de crear la primera instancia.

## Ver la pantalla desde otra PC (scrcpy) — ej. una TV con una notebook vieja

Repo de scrcpy: https://github.com/Genymobile/scrcpy

Cada instancia expone su puerto ADB en el host (`adbPort` en la respuesta de
`GET /api/instances`, el mismo que se ve en la columna "ADB" de la UI). Desde cualquier otra
máquina en la red que tenga scrcpy y `adb`:

```bash
adb connect <ip-del-server>:<adbPort>
scrcpy -s <ip-del-server>:<adbPort> --audio-codec=aac
```

Esto sirve para el caso de reusar una notebook vieja + TV como "cliente" liviano: la notebook
solo corre `scrcpy` (mucho menos exigente que correr Android localmente), mientras la
instancia real corre en un servidor con más recursos. Si la notebook es vieja y su distro trae
una versión desactualizada de `scrcpy` en los repos (Debian, por ejemplo, solo tiene una versión
vieja en `backports`), bajar el binario oficial más nuevo desde
[GitHub Releases](https://github.com/Genymobile/scrcpy/releases) suele ser más simple que
compilarlo — ojo que la versión de `scrcpy-server` tiene que coincidir exacto con la del
cliente `scrcpy`.

### Desde un celular/tablet Android en vez de una PC

Si el cliente que tenés a mano es un dispositivo Android (no una PC/notebook), existe un puerto
de scrcpy que corre como app Android: **ScrcpyForAndroid**
(https://github.com/Miuzarte/ScrcpyForAndroid). Conceptualmente es lo mismo: la app se conecta
por red al puerto ADB de la instancia (`<ip-del-server>:<adbPort>`) y decodifica el video ahí,
sin necesitar una PC de por medio.

### Un script de conexión, en vez de tipear el comando de arriba cada vez

`scripts/connect.sh` (Linux/macOS) y `scripts/connect.ps1` (Windows PowerShell) leen
`GET /api/instances` solos, muestran un menú con las instancias corriendo (o los dispositivos USB
de esta PC), recuerdan tu última elección, y lanzan `scrcpy` ya con los flags de arriba aplicados:

```bash
scripts/connect.sh                                          # default http://localhost:8080
REDROID_FORGE_URL=http://<ip-del-server>:8080 scripts/connect.sh  # redroid-forge en otra PC
```

```powershell
powershell -File scripts\connect.ps1
```

Deliberadamente **no hay ningún visor web embebido** (sin Caddy, sin reverse proxy, sin stack de
auth que armar) — el script de conexión más un cliente de scrcpy es toda la dependencia. Si
preferís un cliente interactivo más prolijo (además de, o en vez de, estos scripts), mirá
[**scrcpy-manager**](https://git.liaima.dev/liaima/scrcpy-manager) (una interfaz de terminal con
mouse, perfiles de conexión guardados, y varias sesiones de scrcpy en vivo a la vez) — un proyecto
aparte que no empaquetamos, pero una de sus ideas (recuperar un puerto ADB fijo tras reiniciar el
dispositivo) está reflejada en estos scripts.

¿Primera vez que te choca un problema de scrcpy (sin audio, video entrecortado, bitrate mal)? Ver
[`docs/SCRCPY-TIPS.es.md`](docs/SCRCPY-TIPS.es.md) — los problemas que de verdad aparecen, más los
atajos que vale la pena conocer, sin el manual completo.

## Estructura

```
backend/src/server.js    Express, sirve /api/* y el frontend estático
backend/src/lib/          dockerRuntime, binder, hwsimWifi, androidIdentity, doctor, store,
                           portAllocator, moduleManifests, moduleAcceptance, moduleGate, hwAccel,
                           knownDb*, permissions, userStore, session, oidc, auth, accountLinks,
                           roleAssignments, quotas, networkInterfaceFilter, settings
backend/src/routes/       instances, doctor, images, modules, db, settings, backups, network, auth
backend/src/modules/      manifests/*.json (contrato de cada módulo, sección 5 de REQUIREMENTS.md)
                           + una carpeta por módulo real (hwenc/, hwdec/, gapps/,
                           arm-translation/, wifi-interno/, redroid-gralloc-fix/, cifi/):
                           script de integración, no solo manifest
backend/native/           vaapi-daemon — daemon host de los módulos hwenc/hwdec (ver docs/ARCHITECTURE.es.md)
backend/db/               semilla incluida de la base de combinaciones conocidas + claves de firma de confianza
backend/images.json       catálogo de imágenes redroid disponibles
backend/data/             estado persistente (instances.json, settings.json, users.json, ...)
backend/test/             tests (node --test, sin dependencias nuevas)
android/                  componentes Codec2 (encoder y decoders por hardware) y sus herramientas de prueba
frontend/                 frontend vanilla (sin build step); contracts.js = modal de contrato genérico,
                           authUi.js = gate de login + oculta/deshabilita UI por capacidad (Fase 7)
scripts/                 connect.sh / connect.ps1 -- scripts de conexión scrcpy para el usuario final
                          (no confundir con backend/scripts/, que es tooling dev/admin)
docs/                     REQUIREMENTS (qué y por qué), ARCHITECTURE (cómo encajan las
                          piezas), MODULE-AUTHORING (cómo escribir un módulo),
                          KNOWN-COMBINATIONS, ROADMAP (en qué orden) y SCRCPY-TIPS
                          (troubleshooting del lado cliente)
CHANGELOG.md              releases etiquetados, política de versionado (solo en inglés, igual que ROADMAP)
```

## Créditos y atribución

Este proyecto es un frontend/manager sobre lo que otros proyectos ya construyeron — no un
reemplazo ni una competencia. Reconocimiento explícito:

- **[redroid](https://github.com/remote-android/redroid-doc)** (remote-android) — el propio
  Android-en-Docker sobre el que corre todo esto. Licencia Apache License 2.0 (módulos de
  kernel bajo GPL v2).
- La lógica de `binder.js` y `hwsimWifi.js` está portada de `plenum-redroid`
  (`host-resource-allocator.service.ts` y `fake-wifi-networking.service.ts`), simplificada: sin
  los supuestos de convivencia con `jg-dashboard v1` (offset de puertos fijo, fallback de hwsim
  deshabilitado) que no aplican en un deploy de un solo propósito como este.

## Licencia

Apache License 2.0 — ver [`LICENSE`](LICENSE).
