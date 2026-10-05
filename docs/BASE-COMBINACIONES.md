# Base de datos de combinaciones conocidas — diseño

Estado: **borrador de diseño (05/10/2026)**. Implementa la decisión de
`REQUIREMENTS.md` sección 2 ("Base de datos de combinaciones conocidas") y el
paso 0 de la Fase 5 del `ROADMAP.md`. Lo marcado **[DECIDIR]** necesita
confirmación antes de implementarse.

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

### 4.2 Actualización (siempre explícita)

`POST /api/db/update` (botón en UI). Nunca en segundo plano ni al arrancar.

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

**[DECIDIR]** quién custodia la clave privada y cómo se firma (a mano al
liberar vs. paso de CI con secreto). Recomendación: a mano al principio —
la base cambia poco y se evita un secreto en CI.

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
  (`serial`/fecha), origen (snapshot o actualizada), edad. Aviso suave si
  tiene más de N días **[DECIDIR N]**; nunca falla por eso.
- **API de solo lectura** para la UI: `GET /api/db` (estado/estadísticas),
  `GET /api/db/combinaciones`.

## 6. Repositorio externo

Nombre tentativo **`redroid-forge-db`** **[DECIDIR]**. Estructura:

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

## 6.1 Riesgos conocidos

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
2. API de solo lectura (`/api/db`) + check en el Doctor.
3. Cargar snapshot/cache con elección por `serial`; `POST /api/db/update`
   con verificación completa.
4. Cache y verificación de paquetes (descarga, `sha256`, import manual).
5. Cableado en creación de instancia: `veredicto` persistido y mostrado;
   `images.json` derivado de `bases`.
6. Módulos GApps y Magisk reales sobre la imagen oficial (consumen 4).
7. Repo externo `redroid-forge-db` + herramientas de build/firma + primera
   release firmada.
