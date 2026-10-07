# Base de datos de combinaciones conocidas — diseño

Estado: **borrador de diseño (05/10/2026)**. Implementa la decisión de
`REQUIREMENTS.md` sección 2 ("Base de datos de combinaciones conocidas") y el
paso 0 de la Fase 5 del `ROADMAP.md`. Pendiente de decidir: ver
§10 de `REQUIREMENTS.md`.

## 1. Qué problema resuelve

`redroid-forge` parte siempre de la imagen oficial de Redroid y le integra
GApps, Magisk, hwenc, etc. por instancia. Eso genera combinaciones
(base × GApps × Magisk × módulos × hardware) y **soporte solo puede
prometerse sobre las que alguien validó**. Esta base de datos es la lista de
las validadas, y el mecanismo que decide, para cada instancia, si el usuario
está en terreno conocido o no.

Principios (ya decididos):

- Soporte = **combinación conocida**, no "imagen".
- Fuera de la base: **no se bloquea**, queda "sin soporte" con advertencia.
- Base de datos en **repositorio externo**, con **snapshot dentro de cada
  release** y **actualización opcional y explícita**.
- La base **no redistribuye** binarios de terceros: guarda *punteros*
  (URL de origen + `sha256`), nunca el contenido de GApps/Magisk.

## 1.1 Alcance de la promesa: verificable, no garantizada

redroid-forge es software libre, sin garantías (Apache-2.0), y **no puede
asegurar que la base de datos sea correcta**. Lo que sí ofrece es que
**cualquiera pueda comprobar por sí mismo** lo que la base afirma:

- **Firma = autenticidad, no corrección.** La firma (4.3) prueba quién
  publicó la base y que no fue alterada. No dice que las combinaciones
  funcionen. La UI y la documentación no presentan la firma como un sello de
  calidad.
- **"Oficial" significa "validada con evidencia", no "garantizada".** Es la
  etiqueta de las combinaciones que el proyecto probó y de las que puede
  mostrar evidencia (validaciones con hardware, fecha y resultado). El texto
  visible dice "validada por el proyecto" y enlaza a esa evidencia; nunca
  "soportado" o "seguro" a secas.
- **Verificación local.** Cada combinación declara una lista de *chequeos
  automáticos reproducibles* (ej. hwenc: el encoder `c2.hardware.encoder.h264`
  está registrado y `screenrecord` produce N frames H.264; GApps: el Android ID
  se registra; Magisk: `su` responde). El usuario puede **correrlos en su
  host** y ver el resultado (sub-paso 8 del plan). Así la afirmación "esto
  anda" deja de ser un acto de fe: se puede repetir.
- **Todo lo comprobable lo es sin confiar en nadie:** el `digest` de la base se
  compara contra lo que el usuario realmente tiene, el `sha256` de cada
  paquete contra lo que realmente bajó, y las validaciones enlazan a su
  evidencia pública.
- **Los reportes de la comunidad entran como lo que son:** evidencia de un
  tercero, que un mantenedor puede decidir promover o no (6.1).

## 2. Modelo de datos

Un solo documento JSON (`schemaVersion` 1) con cuatro colecciones. Se separa
en archivos por entidad en el repo externo y se **compila a un único
`database.json`** en cada release de la base (así el snapshot y la descarga
son un archivo, y la firma cubre todo).

```jsonc
{
  "schemaVersion": 1,
  "serial": 12,                       // entero monotónico: anti-rollback
  "generatedAt": "2026-10-05T00:00:00Z",
  "minForgeVersion": "0.1.0",         // redroid-forge mínimo que entiende esta base
  "bases": [ ... ],
  "paquetes": [ ... ],
  "combinaciones": [ ... ]
}
```

### 2.1 `bases` — imágenes oficiales

```jsonc
{
  "id": "redroid-15-2025-06-27",
  "androidVersion": 15,
  "imagen": "redroid/redroid",        // repositorio
  "tag": "15.0.0-latest",             // SOLO informativo/para pull; no identifica
  "digest": "sha256:8188985244…c991ad", // identifica de verdad (RepoDigest)
  "arch": "amd64",
  "construidaEn": "2025-06-27T15:38:04Z",
  "estado": "vigente"                 // vigente | reemplazada | retirada
}
```

El **digest** es lo que se compara contra lo que hay en el host
(`docker image inspect` → `RepoDigests`). El tag se usa únicamente para
bajar la imagen. Una imagen sin `RepoDigests` (construida local, importada
con `docker load` sin repo) **no matchea nunca** una base → sin soporte.

### 2.2 `paquetes` — GApps y Magisk (punteros, no binarios)

```jsonc
{
  "id": "gapps-<nombre>-<version>-<arch>",
  "tipo": "gapps",                    // gapps | magisk
  "nombre": "…", "version": "…",
  "androidVersion": [15], "arch": "x86_64",
  "origen": "https://…",              // de dónde se baja, tal cual publica el autor
  "sha256": "…", "tamano": 123456789,
  "licencia": "Propietaria (Google)",
  "integracion": "zip-flashable"      // tipo de empaquetado; define qué módulo lo sabe aplicar
}
```

`sha256` es **obligatorio**. Un paquete sin hash no entra a la base.

### 2.3 `combinaciones` — la unidad de soporte

```jsonc
{
  "id": "redroid15-hwenc",
  "base": "redroid-15-2025-06-27",
  "gapps": null,                      // id de paquete, o null
  "magisk": null,                     // id de paquete, o null
  "modulos": { "hwenc": 3 },          // id de módulo -> versión de manifest validada
  "soporte": "oficial",               // oficial | comunidad
  "validaciones": [
    {
      "hardware": { "vendor": "amd", "gpu": "Radeon RX 480 (Polaris10)",
                    "driver": "radeonsi" },
      "fecha": "2026-10-05",
      "forgeVersion": "0.1.0",
      "resultado": "ok",              // ok | parcial | falla
      "chequeos": [                   // reproducibles por el usuario (ver 1.1)
        { "id": "doctor", "resultado": "ok" },
        { "id": "hwenc.encoder-registrado", "resultado": "ok" },
        { "id": "hwenc.screenrecord-frames", "resultado": "ok", "detalle": "74 frames" }
      ],
      "notas": "Doctor verde (binder legacy), encoder c2 registrado, 74 frames H.264.",
      "evidencia": "https://github.com/fogelmanjg/redroid-forge/pull/4"
    }
  ],
  "problemasConocidos": []
}
```

- `soporte: "oficial"` exige **al menos una validación `ok`**.
- Una combinación puede ser `oficial` para un hardware y no estar probada en
  otro: por eso las validaciones llevan hardware, y el resolutor lo cruza con
  el vendor del host (ver 3).
- Las combinaciones `comunidad` documentan "se sabe que arranca/anda
  parcialmente" (ej. Redroid 13 solo `gpuMode: guest`), sin promesa.

## 3. Resolución: ¿esta instancia es "conocida"?

Entrada: lo que el usuario eligió al crear la instancia + lo que hay en el
host. Salida: un **veredicto** que el backend guarda en la instancia y la UI
muestra.

```
resolver({ baseDigest, gappsId, magiskId, modulos, hostGpuVendor }) -> {
  nivel: "oficial" | "comunidad" | "sin-soporte",
  combinacion: <id> | null,
  motivos: [ "…" ]          // en lenguaje de usuario, nunca vacío si nivel != oficial
}
```

Reglas, en orden:

1. **Base desconocida** (digest no está en `bases`, o `estado: retirada`) →
   `sin-soporte`, motivo "imagen base no reconocida".
2. **Paquete desconocido** (GApps/Magisk elegido que no está en `paquetes`) →
   `sin-soporte`, motivo con el paquete.
3. Existe una **combinación exacta** (misma base, mismos paquetes, mismo
   conjunto de módulos con las versiones de manifest validadas):
   - con validación `ok` en el **vendor del host** → su `soporte`
     (normalmente `oficial`);
   - validada solo en **otro vendor** → `comunidad`, motivo "validada en AMD,
     tu host es Intel";
   - sin validación `ok` → `comunidad`.
4. Todo conocido por separado pero **sin combinación exacta** → `comunidad`,
   motivo "cada pieza es conocida pero esta combinación no se validó junta".
5. `base.estado == "reemplazada"` degrada a `comunidad` con motivo
   "hay una base más nueva validada".

El resolutor es **puro** (sin I/O): recibe la base ya cargada, para poder
testearse sin Docker.

## 4. Ciclo de vida del archivo

### 4.1 Dónde vive

| Ubicación | Qué es | Confianza |
|---|---|---|
| `backend/db/snapshot.json` (en el repo/imagen) | snapshot de la release | por venir **dentro del release**: no necesita firma propia |
| `backend/data/db/database.json` (volumen persistente) | última base descargada y verificada | exige firma válida |

Al cargar se usa la de **mayor `serial`** (si la cacheada es más vieja que el
snapshot de una release nueva, gana el snapshot — así actualizar redroid-forge
nunca deja una base vieja pisando una más nueva).

### 4.2 Detección y actualización

- **Detección (decidido 05/10/2026):** redroid-forge **consulta si hay una
  base nueva una vez al día y al abrir la app**. Es solo una consulta liviana
  (`serial` publicado), no descarga ni aplica nada; si hay una más nueva se
  avisa en la UI/Doctor. Se puede desactivar por configuración (para quien no
  quiera que la app haga ninguna conexión por su cuenta).
- **Aplicar** es siempre **explícito**: `POST /api/db/update` (botón en UI).
  Nunca se aplica en segundo plano.

1. Descarga `database.json` + `database.json.sig` de la URL configurada
   (por defecto, la release más reciente del repo externo; configurable para
   quien mantenga un espejo).
2. **Verifica la firma** (ed25519, ver 4.3). Falla → se descarta, no se toca
   nada.
3. Verifica `schemaVersion` soportado y `minForgeVersion` ≤ versión
   instalada. Si la base exige un redroid-forge más nuevo: se informa, no se
   aplica.
4. Verifica **`serial` mayor** que el actual (evita que alguien con acceso al
   canal sirva una base vieja y válida para reintroducir una combinación
   retirada).
5. Reemplazo **atómico** (escribe a temporal + `rename`), conservando la
   anterior como `database.prev.json`.

### 4.3 Verificación de integridad: firma, no solo hash

Un hash publicado junto al archivo, en el mismo lugar, no aporta nada si ese
lugar se compromete. Se propone **firma ed25519 del `database.json`**:

- La clave pública va **embebida en redroid-forge**; la privada la tiene
  quien libera la base.
- Soporta **más de una clave pública** (lista) para poder rotar.
- Se verifica con `crypto` de Node (ed25519 nativo): **sin dependencias
  nuevas**, coherente con la decisión de stack.

**Decidido (05/10/2026):** la clave se genera y se **firma por primera vez al
liberar la primera versión usable completa** de redroid-forge, no antes (hasta
entonces la base viaja solo como snapshot dentro de la release, que no
necesita firma).

**Clave dedicada, no una existente (decidido 05/10/2026).** No se reutiliza la
clave SSH de ningún servidor: esa clave es una identidad de acceso a máquinas y
a GitHub (si se filtra o se rota, se rompe el acceso; si la de firma se filtra,
habría que rotar el acceso), vive en un servidor siempre encendido al alcance
de procesos y agentes, y su comentario (`usuario@host`) quedaría publicado en
un proyecto público. La clave de firma es nueva, con **passphrase**, y la
privada vive **solo en la máquina de quien libera** (nunca en un servidor
compartido ni en CI, ver 6.1). La herramienta `backend/scripts/db-sign.js`
(`keygen`/`sign`/`verify`, sin dependencias) la genera y firma; se mudará al
repo `redroid-forge-db`. Las claves **públicas** autorizadas van en
`backend/db/trusted-keys.json`. **La clave del mantenedor se generó el
05/10/2026** (`mantenedor-2026-10`, con passphrase; la privada vive en
`~/.redroid-forge-keys/` de quien libera, fuera de cualquier repo). Un fork o
espejo propio usa su lista con `REDROID_FORGE_DB_TRUSTED_KEYS_FILE`; si la
lista queda vacía, la app no consulta ni aplica bases descargadas. Las bases se
publican en el repo **`fogelmanjg/redroid-forge-db`** (ver su `RELEASING.md`). Al principio se firma a mano; el modelo para cuando haya más
colaboradores está en 6.1.

### 4.4 Descarga de paquetes (GApps/Magisk)

El módulo correspondiente recibe `origen`+`sha256` **de la base**, nunca de
su propio manifest:

1. Cache direccionado por contenido: `backend/data/paquetes/<sha256>`. Si
   existe, se **re-verifica el hash** igual (no se confía en el disco).
2. Si no existe, se descarga a temporal, se calcula `sha256` mientras baja,
   y **solo si coincide** se mueve al cache. Si no coincide: se borra y se
   aborta la creación con un error claro (qué se esperaba, qué llegó).
3. **Importación manual:** si el origen desapareció (los enlaces mueren), el
   usuario puede dar un archivo local; se acepta **solo si su `sha256`
   coincide** con un paquete de la base.
4. Sin red y sin cache → la instancia no se crea con ese paquete; mensaje
   explícito, nunca un fallback silencioso a "la última versión".

## 5. Integración con el resto del sistema

- **Catálogo (`images.json`)**: pasa a derivarse de `bases` (una entrada por
  base vigente, con `tag` para el pull). `soporte`/`notaSoporte` dejan de
  escribirse a mano.
- **Creación de instancia** (`routes/instances.js`): elige base + paquetes →
  llama al resolutor → guarda `veredicto` en la instancia. Si no es
  `oficial`, la API lo devuelve y la UI lo muestra de forma visible (mismo
  criterio de transparencia que los tiers de la sección 2).
- **Módulos GApps/Magisk** (`etapa 4`, ver `ARQUITECTURA.md`): reciben el
  paquete resuelto (ruta en cache ya verificada). Sus manifests dejan de
  llevar `origen` hardcodeado como fuente de descarga (siguen declarándolo
  para el contrato mostrado al usuario).
- **Doctor**: nuevo check "Base de datos de combinaciones" — versión
  (`serial`/fecha), origen (snapshot o actualizada), y si el
  chequeo diario (4.2) detectó una base más nueva. Es un aviso: nunca falla
  por eso.
- **API de solo lectura** para la UI: `GET /api/db` (estado/estadísticas),
  `GET /api/db/combinaciones`.

## 6. Repositorio externo

Nombre: **`redroid-forge-db`** (confirmado 05/10/2026). Estructura:

```
bases/*.json          una por imagen base
paquetes/*.json       una por paquete GApps/Magisk
combinaciones/*.json  una por combinación + sus validaciones
schema/               JSON Schema (referencia; el backend valida a mano)
tools/build.js        compila todo a database.json (+ valida referencias)
tools/sign.js         firma (ed25519)
```

Contribuir = **PR con evidencia** (qué hardware, qué resultado, logs o
enlace). La CI del repo valida: schema, que las referencias existan
(`combinacion.base` ∈ bases, etc.), que `soporte: oficial` tenga una
validación `ok`, y que cada `origen` de paquete **todavía descargue al
`sha256` declarado** (detecta enlaces muertos o cambiados).

## 6.1 Mantenimiento a escala (quién actualiza la lista)

Si nadie usa redroid-forge, esto es trivial; si lo usa mucha gente, **no
puede depender de una sola persona haciendo todo a mano**. El diseño busca
que el trabajo humano no crezca linealmente con los usuarios:

1. **Degradación elegante.** Si la base queda desactualizada o sin
   mantenedor, nada se rompe: lo desconocido cae en "comunidad"/"sin
   soporte" y la app sigue funcionando. Lo único que se pierde es que haya
   menos combinaciones "oficiales".
2. **Dos niveles de confianza para entrar a la base:**
   - **`comunidad`**: entra con checks **automáticos** (schema, referencias,
     hashes de paquetes descargables). Revisión humana mínima.
   - **`oficial`**: requiere revisión de un mantenedor (hay una promesa de
     soporte detrás). Es el cuello de botella intencional, y el único.
3. **Reportes generados por la propia app.** Un botón "reportar combinación
   validada" arma el JSON (digests, versiones de módulos, hardware, resultado
   del Doctor y de los chequeos automáticos) listo para abrir un PR/issue. El
   contribuyente no escribe a mano ni se equivoca de formato; el mantenedor
   revisa evidencia estructurada en vez de texto libre.
4. **Bots para lo repetitivo.** Un job programado en el repo detecta nuevos
   digests de las imágenes oficiales y abre un PR "base nueva sin validar";
   revisa que los `origen` de paquetes sigan descargando al `sha256`
   declarado y abre un issue si no.
5. **Más de un mantenedor para firmar.** El verificador ya acepta una *lista*
   de claves públicas: cada mantenedor firma con su clave y se puede revocar
   una sola sin invalidar las demás. Costo: cada clave de la lista puede
   publicar cualquier base, por eso la lista se mantiene corta y vive dentro
   del código de la release (no se actualiza desde la propia base).
6. **Firma en CI, solo cuando valga la pena.** Con varios mantenedores y
   volumen real se puede firmar en CI con la clave como secreto protegido
   (ramas protegidas + revisión obligatoria antes del release). Es un
   trade-off consciente contra el riesgo de 4.3; no se hace antes de
   necesitarlo.

## 6.2 Riesgos conocidos

- **Enlaces de origen que mueren o cambian de contenido.** Mitigación:
  el hash lo detecta; la importación manual lo cubre; la CI del repo lo
  vigila. Espejar los binarios no es opción (licencia).
- **Una base `oficial` que se vuelve falsa** (un driver nuevo rompe algo).
  Mitigación: `problemasConocidos` + `estado` y publicar una base con
  `serial` mayor; el usuario ve la degradación al actualizar.
- **Mantenimiento.** La base es trabajo continuo de validación; por eso el
  modelo de contribuciones con evidencia y la tabla de hardware estilo
  `redroid-hwenc`.

## 7. Plan de implementación (pasos chicos, cada uno mergeable)

1. ✅ **Este documento + seed + núcleo puro** (`knownDb.js`: validar
   documento, resolver, comparar `serial`, verificar firma) con tests. Sin
   tocar el flujo de creación.
2. ✅ **Hecho (05/10/2026)** API de solo lectura (`GET /api/db`,
   `GET /api/db/combinaciones`) + check "Base de datos de combinaciones
   conocidas" en el Doctor. Carga con `backend/src/lib/knownDbStore.js`: elige
   por `serial` entre el snapshot y una copia descargada (todavía no existe
   quién la descargue), ignora con aviso una copia inválida/rollback/que exija
   un forge más nuevo, y nunca tumba la app por eso. El snapshot pasó a
   `serial` 2: suma la validación de **Intel Iris Xe** y los `chequeos` de ambas
   validaciones.
   **`serial` 4 (07/10/2026, sin firmar todavía):** el módulo hwenc pasa a la versión 4
   (decode por hardware) y las dos validaciones suman chequeos de decode por
   códec (`hwenc.decode-h264`, `-hevc`, `-hevc-10bit`, `-vp9`, `-vp9-10bit`,
   `hwenc.decoders-registrados`), con sus mediciones, y la combinación declara
   `problemasConocidos` (timeout intermitente del VCE de Polaris, encoder sin
   control de bitrate, 10 bits/HDR como 8 bits). Un chequeo `omitido` significa
   que el hardware no lo ofrece (VP9 en Polaris).
3. ✅ **Hecho (05/10/2026)** Descarga y actualización con verificación
   completa (`backend/src/lib/knownDbUpdate.js`): la **firma se verifica sobre
   los bytes descargados antes de parsear nada**, luego forma + `serial`
   (anti-rollback) + `minForgeVersion`, y recién ahí se escribe (atómico, la
   anterior queda como `database.prev.json`). `GET /api/db` informa el estado;
   `POST /api/db/check` consulta (solo `latest.json`); `POST /api/db/update`
   aplica (siempre acción explícita). Chequeo automático al abrir y cada 24 h
   (solo consulta), desactivable con `REDROID_FORGE_DB_CHECK=0`; URL
   configurable con `REDROID_FORGE_DB_URL` (espejos). Sin claves de confianza no
   hay consultas de red.
4. Cache y verificación de paquetes (descarga, `sha256`, import manual).
5. Cableado en creación de instancia: `veredicto` persistido y mostrado;
   `images.json` derivado de `bases`.
6. Módulos GApps y Magisk reales sobre la imagen oficial (consumen 4).
7. Repo externo `redroid-forge-db` + herramientas de build/firma + primera
   release firmada.
8. **Verificación local** (1.1): cada módulo declara sus chequeos
   reproducibles; la app los corre sobre una instancia y compara contra los
   `chequeos` de la combinación. Sin esto, "validada" es solo una afirmación
   del repo; con esto, el usuario la puede repetir.
