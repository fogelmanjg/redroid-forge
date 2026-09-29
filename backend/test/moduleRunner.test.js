// Cobertura del runner generico de modulos (Fase 5, ver docs/ROADMAP.md y
// docs/ARQUITECTURA.md). No levanta Docker ni redroid real -- los modulos de
// prueba son fixtures puros (sin child_process/dockerode) que solo anotan
// que los llamaron y con que argumentos, para verificar el punto del ciclo
// de vida en el que el runner los invoca. El unico contacto con un modulo
// real es un smoke test de la etapa 3 de hwenc (ver mas abajo), elegido
// porque es la unica funcion de ese modulo que no toca child_process/docker.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const manifests = require('../src/lib/moduleManifests');
const moduleRunner = require('../src/lib/moduleRunner');

function baseManifestFields(id, etapa) {
  return {
    id,
    nombre: `Fixture ${id}`,
    descripcion: 'Modulo de prueba, no es un modulo real del proyecto.',
    esTerceroNoLibre: false,
    queToca: ['nada, es un fixture de test'],
    compatibleCon: { androidVersion: [15], gpuMode: ['host'] },
    version: 1,
    etapa,
    entry: './entry.js',
  };
}

// Arma `<root>/manifests/` (vacia, pero tiene que existir -- loadAll() la
// lee sin chequear si esta vacia) mas `<root>/<id>/{manifest.json,entry.js}`
// por cada fixture pedido, y deja moduleManifests apuntando a ese root
// mientras corre `fn`. `fixtures` es un array de { id, etapa, entryBody }.
// OJO: `fn` es async -- un `try { return fn(root); } finally { ... }` comun
// dispara el `finally` apenas `fn(root)` devuelve la promesa (sincronico),
// no cuando esa promesa resuelve, y el cleanup pisaria la raiz de fixtures
// mientras el cuerpo del test todavia esta corriendo entre awaits. Por eso
// se envuelve con Promise.resolve(...).finally(...) en vez de try/finally.
function withFixtureModules(fixtures, fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rf-modulerunner-'));
  fs.mkdirSync(path.join(root, 'manifests'));
  for (const { id, etapa, entryBody } of fixtures) {
    const dir = path.join(root, id);
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(baseManifestFields(id, etapa), null, 2));
    fs.writeFileSync(path.join(dir, 'entry.js'), entryBody);
  }
  manifests._setModulesRootForTests(root);
  moduleRunner._resetForTests();
  return Promise.resolve(fn(root)).finally(() => {
    manifests._setModulesRootForTests(null);
    moduleRunner._resetForTests();
  });
}

// Devuelve el mismo objeto de modulo que ya cargo moduleRunner (via
// require()) -- Node cachea por path resuelto, asi que pedirlo de nuevo con
// el mismo path absoluto da la misma instancia, con las anotaciones
// (`calls`) que dejo la corrida.
function requireFixtureEntry(root, id) {
  // eslint-disable-next-line global-require, import/no-dynamic-require
  return require(path.join(root, id, 'entry.js'));
}

test('moduleRunner.prepareCreate: llama a prepareCreate() de cada modulo de etapa 3 y junta binds/cmd', () => withFixtureModules([
  {
    id: 'fx-binds',
    etapa: [3],
    entryBody: `
      module.exports.calls = [];
      module.exports.prepareCreate = () => {
        module.exports.calls.push('prepareCreate');
        return { binds: ['/host/a:/guest/a'], cmd: ['androidboot.fx=1'] };
      };
    `,
  },
  {
    id: 'fx-sin-etapa3',
    etapa: [4], // no participa de la etapa 3 -- prepareCreate no deberia llamarlo
    entryBody: `
      module.exports.calls = [];
      module.exports.integrate = () => { module.exports.calls.push('integrate'); };
    `,
  },
], async (root) => {
  const result = await moduleRunner.prepareCreate(['fx-binds', 'fx-sin-etapa3']);
  assert.deepEqual(result, { binds: ['/host/a:/guest/a'], cmd: ['androidboot.fx=1'] });
  assert.deepEqual(requireFixtureEntry(root, 'fx-binds').calls, ['prepareCreate']);
  assert.deepEqual(requireFixtureEntry(root, 'fx-sin-etapa3').calls, []);
}));

test('moduleRunner.prepareCreate: un modulo que no requiere nada en el create no rompe nada', () => withFixtureModules([], async () => {
  const result = await moduleRunner.prepareCreate([]);
  assert.deepEqual(result, { binds: [], cmd: [] });
}));

test('moduleRunner.integrate: llama a integrate(containerId) de etapa 4 con el containerId, en orden', () => withFixtureModules([
  {
    id: 'fx-a',
    etapa: [4],
    entryBody: `
      module.exports.calls = [];
      module.exports.integrate = async (containerId) => { module.exports.calls.push(['a', containerId]); };
    `,
  },
  {
    id: 'fx-b',
    etapa: [4],
    entryBody: `
      module.exports.calls = [];
      module.exports.integrate = async (containerId) => { module.exports.calls.push(['b', containerId]); };
    `,
  },
], async (root) => {
  await moduleRunner.integrate(['fx-a', 'fx-b'], 'container123');
  assert.deepEqual(requireFixtureEntry(root, 'fx-a').calls, [['a', 'container123']]);
  assert.deepEqual(requireFixtureEntry(root, 'fx-b').calls, [['b', 'container123']]);
}));

test('moduleRunner.integrate: si un modulo declara etapa 4 pero su entry no exporta "integrate", falla claro', () => withFixtureModules([
  {
    id: 'fx-roto',
    etapa: [4],
    entryBody: 'module.exports = {};',
  },
], async () => {
  await assert.rejects(
    () => moduleRunner.integrate(['fx-roto'], 'container123'),
    /fx-roto.*etapa 4.*no exporta "integrate"/s,
  );
}));

test('moduleRunner.ensureHostInfraReady: llama al hook de etapa 5 sin argumentos', () => withFixtureModules([
  {
    id: 'fx-infra',
    etapa: [5],
    entryBody: `
      module.exports.calls = [];
      module.exports.ensureHostInfraReady = async () => { module.exports.calls.push('ready'); };
    `,
  },
], async (root) => {
  await moduleRunner.ensureHostInfraReady(['fx-infra']);
  assert.deepEqual(requireFixtureEntry(root, 'fx-infra').calls, ['ready']);
}));

test('moduleRunner.scheduleRuntimeFixups: llama al hook de etapa 6 con el containerId, fire-and-forget', () => withFixtureModules([
  {
    id: 'fx-fixup',
    etapa: [6],
    entryBody: `
      module.exports.calls = [];
      module.exports.ensureRuntimeReady = async (containerId) => { module.exports.calls.push(containerId); };
    `,
  },
], async (root) => {
  moduleRunner.scheduleRuntimeFixups(['fx-fixup'], 'containerXYZ');
  // Fire-and-forget: el runner no devuelve una promesa que esperar, asi que
  // el test cede el control (microtask) antes de verificar.
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(requireFixtureEntry(root, 'fx-fixup').calls, ['containerXYZ']);
}));

test('moduleRunner.scheduleRuntimeFixups: no tumba el proceso si el hook de etapa 6 rechaza', () => withFixtureModules([
  {
    id: 'fx-fixup-falla',
    etapa: [6],
    entryBody: `
      module.exports.ensureRuntimeReady = async () => { throw new Error('boom'); };
    `,
  },
], async () => {
  assert.doesNotThrow(() => moduleRunner.scheduleRuntimeFixups(['fx-fixup-falla'], 'containerXYZ'));
  // Deja que el rechazo se procese (y lo "atrape" el .catch interno) antes de
  // que termine el test -- si no estuviera atrapado, node --test lo marcaria
  // como unhandledRejection.
  await new Promise((resolve) => setImmediate(resolve));
}));

test('moduleRunner.scheduleRuntimeFixups: si el modulo no exporta el hook de etapa 6, avisa pero no rompe', () => withFixtureModules([
  {
    id: 'fx-sin-hook',
    etapa: [6],
    entryBody: 'module.exports = {};',
  },
], async () => {
  assert.doesNotThrow(() => moduleRunner.scheduleRuntimeFixups(['fx-sin-hook'], 'containerXYZ'));
}));

// A diferencia de los tests de arriba, estos dos usan el catalogo REAL de
// manifests (backend/src/modules/manifests/*.json + backend/src/modules/
// hwenc/) en vez de un root de fixtures -- se fuerza el reset a la raiz por
// defecto al principio para no depender de en que orden corrio node:test los
// tests anteriores de este archivo.
function withRealManifests(fn) {
  manifests._setModulesRootForTests(null);
  moduleRunner._resetForTests();
  return fn();
}

test('moduleRunner: un modulo requerido sin "entry" (los modulos puramente contrato de Fase 4) no participa de ninguna etapa', () => withRealManifests(async () => {
  // gapps/magisk/wifi-falso (manifests planos existentes) no declaran
  // etapa/entry -- pedirle al runner que corra sus etapas no tiene que
  // fallar, tiene que simplemente no hacer nada.
  const createReq = await moduleRunner.prepareCreate(['gapps']);
  assert.deepEqual(createReq, { binds: [], cmd: [] });
  await assert.doesNotReject(() => moduleRunner.integrate(['gapps'], 'containerX'));
  await assert.doesNotReject(() => moduleRunner.ensureHostInfraReady(['gapps']));
  assert.doesNotThrow(() => moduleRunner.scheduleRuntimeFixups(['gapps'], 'containerX'));
}));

// Smoke test contra el modulo hwenc REAL (no un fixture) -- unica funcion de
// ese modulo que no toca child_process/docker, asi que es segura de llamar
// tal cual en un test unitario (ver docs/ROADMAP.md: nada de esto se corrio
// contra Docker/redroid real). Cubre que la convencion de resolucion de
// "entry" relativo a la carpeta del modulo (moduleManifests.moduleDir())
// efectivamente encuentra y carga backend/src/modules/hwenc/integrate.js.
test('moduleRunner.prepareCreate: modulo hwenc real, etapa 3 (unico hook sin child_process/docker)', () => withRealManifests(async () => {
  const hwAccel = require('../src/lib/hwAccel');
  const { REQUIRED_BOOT_FLAGS } = require('../src/modules/hwenc/integrate');
  const result = await moduleRunner.prepareCreate(['hwenc']);
  assert.deepEqual(result, { binds: [hwAccel.daemonBind()], cmd: REQUIRED_BOOT_FLAGS });
}));
