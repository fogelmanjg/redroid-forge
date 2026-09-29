// Cobertura de la Fase 4 (sistema de contrato de modulo). No levanta Docker
// ni contenedores redroid reales -- todo lo que toca esta capa es diseno y
// codigo puro (schema, registro de aceptacion, gating), ver docs/ROADMAP.md.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const manifests = require('../src/lib/moduleManifests');
const acceptance = require('../src/lib/moduleAcceptance');
const moduleGate = require('../src/lib/moduleGate');

// Aisla el registro de aceptacion en un archivo temporal por test, para no
// pisar backend/data/module-acceptances.json real ni depender de estado
// dejado por una corrida anterior.
function withTempAcceptanceStore(fn) {
  const tmpFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rf-acceptance-')), 'module-acceptances.json');
  acceptance._setStoreFileForTests(tmpFile);
  try {
    return fn();
  } finally {
    acceptance._setStoreFileForTests(null);
  }
}

// Fixtures de imagen -- no dependen de backend/images.json para no acoplar
// los tests al catalogo real, que puede cambiar.
const imgOficialConGappsYMagisk = { id: 'fixture-15-full', androidVersion: 15, gpuMode: 'host', hasGapps: true, hasMagisk: true, needsHwsimWifi: false };
const imgSinModulos = { id: 'fixture-15-plain', androidVersion: 15, gpuMode: 'host', hasGapps: false, hasMagisk: false, needsHwsimWifi: false };
const imgGappsAndroid11 = { id: 'fixture-11-gapps', androidVersion: 11, gpuMode: 'host', hasGapps: true, hasMagisk: false, needsHwsimWifi: false };
const imgGappsGuestNoSoportado = { id: 'fixture-99-gapps-guest', androidVersion: 99, gpuMode: 'guest', hasGapps: true, hasMagisk: false, needsHwsimWifi: false };
const imgHwEncCapable = {
  id: 'fixture-15-hwenc', androidVersion: 15, gpuMode: 'host', hasGapps: false, hasMagisk: false, needsHwsimWifi: false, hwEncCapable: true,
};

test('moduleManifests: el catalogo tiene los 6 modulos de la seccion 5 de REQUIREMENTS.md + hwenc', () => {
  // hwenc (Fase 5) vive en su propia carpeta (backend/src/modules/hwenc/
  // manifest.json), no en backend/src/modules/manifests/ como los otros
  // seis -- este test tambien cubre que moduleManifests.loadAll() descubre
  // las dos fuentes (ver comentario ahi).
  const ids = manifests.list().map((m) => m.id).sort();
  assert.deepEqual(ids, ['cpu-ram', 'device-profile', 'gapps', 'gpu-mode', 'hwenc', 'magisk', 'wifi-falso']);
});

test('moduleManifests: hwenc se descubre desde su propia carpeta, con etapa/entry', () => {
  const hwenc = manifests.get('hwenc');
  assert.ok(hwenc, 'el manifest de hwenc tendria que existir');
  assert.deepEqual(hwenc.etapa, [3, 4, 5, 6]);
  assert.equal(hwenc.entry, './integrate.js');
});

test('moduleManifests.moduleDir: resuelve la carpeta de un modulo plano y de uno con carpeta propia', () => {
  assert.match(manifests.moduleDir('gapps'), /modules[/\\]manifests$/);
  assert.match(manifests.moduleDir('hwenc'), /modules[/\\]hwenc$/);
  assert.equal(manifests.moduleDir('no-existe'), null);
});

test('moduleManifests: rechaza un manifest sin los campos requeridos', () => {
  assert.throws(() => manifests.validateManifest({ id: 'x' }, 'fixture'), /Manifest de modulo invalido/);
});

test('moduleManifests: un modulo de terceros no libre exige licencia y origen', () => {
  assert.throws(
    () => manifests.validateManifest({
      id: 'x', nombre: 'X', descripcion: 'd', esTerceroNoLibre: true,
      queToca: ['a'], compatibleCon: { androidVersion: [15], gpuMode: ['host'] }, version: 1,
    }, 'fixture'),
    /requieren "licencia"/,
  );
});

test('moduleManifests: acepta un manifest propio (no libre=false) sin licencia/origen', () => {
  assert.doesNotThrow(() => manifests.validateManifest({
    id: 'x', nombre: 'X', descripcion: 'd', esTerceroNoLibre: false,
    queToca: ['a'], compatibleCon: { androidVersion: [15], gpuMode: ['host'] }, version: 1,
  }, 'fixture'));
});

test('moduleManifests.isCompatible: compara androidVersion y gpuMode contra compatibleCon', () => {
  const manifest = manifests.get('gapps');
  assert.equal(manifests.isCompatible(manifest, imgOficialConGappsYMagisk), true);
  assert.equal(manifests.isCompatible(manifest, imgGappsGuestNoSoportado), false);
});

test('moduleManifests.incompatibilityReason: explica por que, no rompe en silencio', () => {
  const manifest = manifests.get('gapps');
  const reason = manifests.incompatibilityReason(manifest, imgGappsGuestNoSoportado);
  assert.match(reason, /Android 99/);
});

test('moduleAcceptance: sin registro previo, un modulo no esta aceptado', () => withTempAcceptanceStore(() => {
  assert.equal(acceptance.isAccepted('gapps', 1), false);
  assert.equal(acceptance.latestFor('gapps'), null);
}));

test('moduleAcceptance: aceptar la version actual la deja vigente', () => withTempAcceptanceStore(() => {
  acceptance.record({ moduleId: 'gapps', version: 1, instanceName: 'mi-instancia' });
  assert.equal(acceptance.isAccepted('gapps', 1), true);
  const latest = acceptance.latestFor('gapps');
  assert.equal(latest.instanceName, 'mi-instancia');
  assert.equal(latest.userId, 'local');
}));

test('moduleAcceptance: si el manifest sube de version, la aceptacion vieja deja de valer', () => withTempAcceptanceStore(() => {
  acceptance.record({ moduleId: 'gapps', version: 1 });
  assert.equal(acceptance.isAccepted('gapps', 1), true);
  assert.equal(acceptance.isAccepted('gapps', 2), false); // el manifest subio a v2 en algun punto
}));

test('moduleGate.check: bloquea (428) si la imagen requiere un modulo sin aceptar', () => withTempAcceptanceStore(() => {
  const result = moduleGate.check(imgOficialConGappsYMagisk);
  assert.equal(result.ok, false);
  assert.equal(result.httpStatus, 428);
  const ids = result.modules.map((m) => m.id).sort();
  assert.deepEqual(ids, ['gapps', 'magisk']);
}));

test('moduleGate.check: permite crear/arrancar una vez aceptados todos los modulos requeridos', () => withTempAcceptanceStore(() => {
  acceptance.record({ moduleId: 'gapps', version: manifests.get('gapps').version });
  acceptance.record({ moduleId: 'magisk', version: manifests.get('magisk').version });
  const result = moduleGate.check(imgOficialConGappsYMagisk);
  assert.equal(result.ok, true);
}));

test('moduleGate.check: una imagen sin modulos requeridos nunca queda bloqueada', () => withTempAcceptanceStore(() => {
  const result = moduleGate.check(imgSinModulos);
  assert.equal(result.ok, true);
}));

test('moduleGate.check: no ofrece/permite el modulo si la imagen no cumple compatibleCon', () => withTempAcceptanceStore(() => {
  // Aceptar el contrato no alcanza si la imagen es incompatible -- el gate
  // tiene que rechazar por compatibilidad (409) antes de mirar aceptacion.
  acceptance.record({ moduleId: 'gapps', version: manifests.get('gapps').version });
  const result = moduleGate.check(imgGappsGuestNoSoportado);
  assert.equal(result.ok, false);
  assert.equal(result.httpStatus, 409);
  assert.match(result.error, /no se puede usar la imagen/i);
}));

// Gate de la Fase 4 (docs/ROADMAP.md): activar GApps tiene que exigir leer y
// aceptar un contrato generado desde su manifest antes de que el backend
// ejecute nada. Este test reproduce ese flujo end-to-end a nivel de la logica
// pura (sin Docker real, ver nota arriba).
test('gate de la Fase 4: GApps queda bloqueado hasta aceptar su manifest, despues se habilita', () => withTempAcceptanceStore(() => {
  const antesDeAceptar = moduleGate.check(imgGappsAndroid11);
  assert.equal(antesDeAceptar.ok, false);
  assert.equal(antesDeAceptar.httpStatus, 428);
  assert.equal(antesDeAceptar.modules[0].id, 'gapps');

  acceptance.record({ moduleId: 'gapps', version: antesDeAceptar.modules[0].version, instanceName: 'mi-instancia-gapps' });

  const despuesDeAceptar = moduleGate.check(imgGappsAndroid11);
  assert.equal(despuesDeAceptar.ok, true);
}));

// Fase 5: hwenc pasa a requerirse igual que gapps/magisk/wifi-falso cuando la
// imagen declara hwEncCapable=true (ver moduleGate.requiredModuleIdsForImage)
// -- mismo flujo de consentimiento generico, aunque hwenc sea un modulo
// propio (esTerceroNoLibre=false) y no de terceros.
test('moduleGate.requiredModuleIdsForImage: suma "hwenc" cuando la imagen declara hwEncCapable', () => {
  assert.deepEqual(moduleGate.requiredModuleIdsForImage(imgHwEncCapable), ['hwenc']);
  assert.deepEqual(moduleGate.requiredModuleIdsForImage(imgSinModulos), []);
});

test('moduleGate.check: hwenc queda bloqueado hasta aceptar su manifest, igual que gapps/magisk', () => withTempAcceptanceStore(() => {
  const antesDeAceptar = moduleGate.check(imgHwEncCapable);
  assert.equal(antesDeAceptar.ok, false);
  assert.equal(antesDeAceptar.httpStatus, 428);
  assert.equal(antesDeAceptar.modules[0].id, 'hwenc');

  acceptance.record({ moduleId: 'hwenc', version: antesDeAceptar.modules[0].version });

  const despuesDeAceptar = moduleGate.check(imgHwEncCapable);
  assert.equal(despuesDeAceptar.ok, true);
}));
