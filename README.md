# redroid-forge

App standalone (frontend + backend en un solo contenedor) para manejar instancias
[redroid](https://github.com/remote-android/redroid-doc) en cualquier PC que solo tenga Docker,
sin depender de ninguna otra infraestructura.

> Proyecto en construcción — consolida en un solo lugar varios proyectos separados
> (`redroid-manager`, `redroid-hwenc`, `redroid-nvidia`, y lo que hoy vive repartido en
> `jg-dashboard`/`plenum-redroid`). Ver [`docs/REQUIREMENTS.md`](docs/REQUIREMENTS.md) (qué y por
> qué) y [`docs/ROADMAP.md`](docs/ROADMAP.md) (en qué orden) para el panorama completo. Lo que
> hay hoy corresponde a las **Fases 0, 1 y 4** del roadmap: el port íntegro de
> `redroid-manager`, tiers de soporte por imagen, y el sistema de contrato de módulo genérico.

Resuelve dos cosas:

1. **Ciclo de vida de instancias**: crear, arrancar, parar, reiniciar y borrar contenedores
   redroid desde una UI web, incluyendo lo que no viaja con la imagen (dispositivos `binderfs`
   por instancia, y el wiring de `mac80211_hwsim` para las imágenes con WiFi falso).
2. **Doctor**: diagnóstico del host — muestra qué falta configurar y el comando exacto para
   arreglarlo. Nunca ejecuta nada solo, solo diagnostica.

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
(WiFi falso, y a futuro device profile/modo GPU/CPU-RAM) se declara con un **manifest**
versionado (`backend/src/modules/manifests/*.json`) en vez de tener su propia lógica de
habilitación. El backend nunca crea ni arranca una instancia que requiera un módulo sin una
aceptación vigente de su manifest — si falta, responde `428` con el contrato pendiente, el
frontend lo muestra (mismo diálogo genérico para todos, `frontend/contracts.js`), y solo tras
aceptarlo se reintenta. Ver la tab **Módulos** en la UI y la sección 5 de
[`docs/REQUIREMENTS.md`](docs/REQUIREMENTS.md) para el detalle completo (incluye
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

## Estructura

```
backend/src/server.js    Express, sirve /api/* y el frontend estático
backend/src/lib/          dockerRuntime, binder, hwsimWifi, androidIdentity, doctor, store,
                           portAllocator, moduleManifests, moduleAcceptance, moduleGate
backend/src/routes/       instances, doctor, images, modules
backend/src/modules/      manifests/*.json — manifest de cada módulo (sección 5 de REQUIREMENTS.md)
backend/images.json       catálogo de imágenes redroid disponibles
backend/data/             estado persistente (instances.json, module-acceptances.json)
backend/test/             tests del sistema de contrato de módulo (node --test, sin deps nuevas)
frontend/                 frontend vanilla (sin build step); contracts.js = modal de contrato genérico
docs/                     REQUIREMENTS.md (qué y por qué) y ROADMAP.md (en qué orden)
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
