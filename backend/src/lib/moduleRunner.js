const path = require('path');
const manifests = require('./moduleManifests');

// Orquestador generico de modulos con logica de ejecucion real (etapa/entry
// en su manifest, ver docs/ARQUITECTURA.md) -- Fase 5, generalizado a partir
// del unico caso real que existia (hwenc, cableado a mano en instances.js).
// A diferencia de moduleGate.js (que solo decide si un modulo *puede*
// activarse: compatibilidad + consentimiento), este archivo es el que
// efectivamente ejecuta el codigo del modulo en el momento del ciclo de vida
// que le corresponde.
//
// Convencion (documentada tambien en docs/ARQUITECTURA.md): un modulo que
// declara "etapa": [...] en su manifest expone, desde el archivo que declara
// en "entry" (resuelto relativo a LA CARPETA DEL MODULO, nunca a este
// archivo), una funcion con nombre fijo por cada etapa que le aplique. No
// hace falta exportar las etapas que no declara.
function log(msg) { console.log(`[moduleRunner] ${msg}`); }
function warn(msg) { console.warn(`[moduleRunner] ${msg}`); }

const STAGE_EXPORT_NAME = {
  // Etapa 3: antes de runtime.create(). Sync o async, sin argumentos --
  // "que necesita ESTE MODULO para poder crearse", no algo especifico de una
  // instancia puntual (ancho/alto/dpi/etc. los sigue armando instances.js).
  // Devuelve `{ binds?: string[], cmd?: string[] }`, puramente aditivo.
  3: 'prepareCreate',
  // Etapa 4: entre runtime.create() y runtime.start() -- unica ventana en la
  // que /vendor es escribible (ver ARQUITECTURA.md). Recibe el containerId
  // ya creado (todavia detenido).
  4: 'integrate',
  // Etapa 5: infraestructura companion del host, independiente de cualquier
  // instancia puntual (ej. el daemon VA-API de hwAccel.js). Sin argumentos,
  // idempotente por contrato del propio modulo.
  5: 'ensureHostInfraReady',
  // Etapa 6: contra una instancia ya arrancada. Recibe el containerId vivo.
  6: 'ensureRuntimeReady',
};

// Cache de `require()` por id de modulo -- mismo criterio que moduleManifests
// (los manifests/entries son archivos estaticos del repo, no datos de
// usuario). `_resetForTests()` la limpia para que un test pueda apuntar a un
// fixture nuevo bajo el mismo id sin arrastrar el require() de una corrida
// anterior.
const entryCache = new Map();

function loadEntry(manifest) {
  if (entryCache.has(manifest.id)) return entryCache.get(manifest.id);
  const dir = manifests.moduleDir(manifest.id);
  if (!dir) {
    throw new Error(`No se pudo resolver la carpeta del modulo "${manifest.id}" para cargar su entry ("${manifest.entry}")`);
  }
  // eslint-disable-next-line global-require, import/no-dynamic-require -- el
  // path es dinamico por diseno: cada modulo declara el suyo en su manifest.
  const entryModule = require(path.join(dir, manifest.entry));
  entryCache.set(manifest.id, entryModule);
  return entryModule;
}

// Modulos, de la lista de ids requeridos por la imagen (ver
// moduleGate.requiredModuleIdsForImage), que ademas declaran "etapa"/"entry"
// -- los modulos "puramente contrato" (gapps/magisk/wifi-falso hoy, sin
// logica de ejecucion propia todavia) no tienen "entry", y no rompe nada que
// no lo tengan: simplemente no participan de ninguna etapa de este runner.
function modulesForStage(requiredModuleIds, stage) {
  return requiredModuleIds
    .map((id) => manifests.get(id))
    .filter((m) => m && Array.isArray(m.etapa) && m.etapa.includes(stage) && m.entry);
}

function requireStageFn(manifest, stage) {
  const entryModule = loadEntry(manifest);
  const exportName = STAGE_EXPORT_NAME[stage];
  const fn = entryModule[exportName];
  if (typeof fn !== 'function') {
    throw new Error(
      `El modulo "${manifest.id}" declara etapa ${stage} en su manifest pero su entry `
      + `("${manifest.entry}") no exporta "${exportName}"`,
    );
  }
  return fn;
}

// Etapa 3 -- se llama ANTES de runtime.create(). En serie (no Promise.all):
// el orden en que varios modulos suman binds/cmd puede importar (ej. flags
// de boot que se pisan entre si), y son pocos modulos como para que el costo
// de paralelizar valga la pena.
async function prepareCreate(requiredModuleIds) {
  const binds = [];
  const cmd = [];
  for (const manifest of modulesForStage(requiredModuleIds, 3)) {
    const fn = requireStageFn(manifest, 3);
    // eslint-disable-next-line no-await-in-loop
    const result = (await fn()) || {};
    if (Array.isArray(result.binds)) binds.push(...result.binds);
    if (Array.isArray(result.cmd)) cmd.push(...result.cmd);
  }
  return { binds, cmd };
}

// Etapa 4 -- se llama DESPUES de runtime.create() y ANTES de runtime.start().
// Se awaitea en serie y de punta a punta: si un modulo falla, no se sigue con
// el siguiente ni se llega a start() -- mejor un create() a medio inyectar y
// visible en el error que un boot con la mitad de los modulos declarados sin
// aplicarse en silencio.
async function integrate(requiredModuleIds, containerId, ctx = {}) {
  for (const manifest of modulesForStage(requiredModuleIds, 4)) {
    const fn = requireStageFn(manifest, 4);
    log(`etapa 4: integrando modulo "${manifest.id}" en ${containerId}...`);
    // eslint-disable-next-line no-await-in-loop
    await fn(containerId, ctx);
  }
}

// Etapa 5 -- infraestructura del host, se llama antes de start/restart
// (mismo momento en que instances.js ya llamaba a hwAccel.ensureDaemonRunning
// a mano). Cada modulo es responsable de que su propio hook sea idempotente.
async function ensureHostInfraReady(requiredModuleIds) {
  for (const manifest of modulesForStage(requiredModuleIds, 5)) {
    const fn = requireStageFn(manifest, 5);
    // eslint-disable-next-line no-await-in-loop
    await fn();
  }
}

// Etapa 6 -- fixups post-boot contra una instancia ya arrancada. Fire-and-
// forget a proposito, mismo patron que scheduleWifiFixes/hwsimWifi.js: no
// bloquea la respuesta HTTP del start/restart, y un modulo que falla acá no
// tiene que tumbar el arranque de la instancia (ya esta viva igual, esto es
// un ajuste sobre algo que ya funciona, no una precondicion).
function scheduleRuntimeFixups(requiredModuleIds, containerId) {
  for (const manifest of modulesForStage(requiredModuleIds, 6)) {
    let fn;
    try {
      fn = requireStageFn(manifest, 6);
    } catch (e) {
      warn(e.message);
      // eslint-disable-next-line no-continue
      continue;
    }
    Promise.resolve(fn(containerId)).catch((e) => {
      warn(`etapa 6 del modulo "${manifest.id}" fallo para ${containerId}: ${e.message}`);
    });
  }
}

// Solo para tests.
function _resetForTests() { entryCache.clear(); }

module.exports = {
  prepareCreate, integrate, ensureHostInfraReady, scheduleRuntimeFixups, _resetForTests,
};
