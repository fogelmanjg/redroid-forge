// Regresion de la Fase 3 (docs/ROADMAP.md, paso 4): dos instancias que
// arrancan/reinician casi al mismo tiempo no deben poder reclamar el mismo
// par phy/iface de mac80211_hwsim. No levanta Docker/hardware real -- mockea
// child_process.execFile (usado por hwsimWifi.js para 'iw dev'/'iw phy ...
// set netns') y dockerRuntime (getPid/exec/inspect) via t.mock, siguiendo el
// mismo estilo sin dependencias nuevas que moduleContract.test.js.
//
// IMPORTANTE (ver descripcion del PR): esto valida el modelo de concurrencia
// mockeado, no una race real de arranque dual de instancias contra Docker --
// eso todavia hay que probarlo en hardware real antes de mergear.
const test = require('node:test');
const assert = require('node:assert/strict');
const cp = require('node:child_process');

const runtime = require('../src/lib/dockerRuntime');
const store = require('../src/lib/store');
const hwsimWifi = require('../src/lib/hwsimWifi');

// Simula el estado real del host: un phy que "iw phy X set netns" mueve de
// verdad deja de aparecer en la proxima lectura de 'iw dev'. A diferencia de
// darle a cada llamada su propia fixture independiente (eso no probaria
// nada: cada instancia veria sus propios pares libres y nunca podrian
// pisarse), esta lista la comparten AMBAS llamadas concurrentes, tal como
// comparten el mismo netns default del host en la realidad. `claimedBy`
// registra que instancia se quedo con cada phy, y `collisions` marca si
// alguna vez dos reclamos intentaron mover el mismo phy -- eso es lo que
// hace fallar el test si la cola de serializacion no esta.
function makeSharedHostState(pairs) {
  return { free: pairs.map((p) => ({ ...p })), claimedBy: {}, collisions: [] };
}

function iwDevOutput(pairs) {
  return pairs.map((p) => `${p.phy.replace('phy', 'phy#')}\n\tInterface ${p.iface}`).join('\n');
}

// Reproduce la mecanica async real de dockerode/execFile (nunca resuelve en
// el mismo tick) -- sin esto, dos llamadas a ensureHwsimWifi podrian correr
// en un orden serializado por pura casualidad del scheduler de microtasks,
// sin que la cola de runHwsimClaim tenga nada que ver.
function tick() {
  return new Promise((resolve) => setImmediate(resolve));
}

function mockExecFile(t, hostState, instanceIdByPid) {
  t.mock.method(cp, 'execFile', (file, args, cb) => {
    (async () => {
      await tick();
      if (file === 'modprobe' || file === 'rmmod') {
        return cb(null, '', '');
      }
      if (file === 'ip' && args[0] === 'link') {
        // "ip link set wlan0_fake ..." -- no existe en este fixture.
        return cb(new Error('no such device'));
      }
      if (file === 'iw' && args[0] === 'dev') {
        return cb(null, iwDevOutput(hostState.free), '');
      }
      if (file === 'iw' && args[0] === 'phy') {
        const phy = args[1];
        const pid = args[4];
        const idx = hostState.free.findIndex((p) => p.phy === phy);
        if (idx === -1) {
          // Ya lo tiene otra instancia -- es exactamente la colision que
          // este test existe para detectar.
          hostState.collisions.push({ phy, wantedBy: instanceIdByPid[pid], heldBy: hostState.claimedBy[phy] });
          return cb(new Error(`${phy} ya no esta libre en el host (doble reclamo)`));
        }
        hostState.free.splice(idx, 1); // se mueve al netns del contenedor -> deja de estar libre
        hostState.claimedBy[phy] = instanceIdByPid[pid];
        return cb(null, '', '');
      }
      return cb(null, '', '');
    })();
  });
}

function mockRuntime(t, pidByContainer) {
  t.mock.method(runtime, 'getPid', async (containerId) => {
    await tick();
    return pidByContainer[containerId];
  });
  t.mock.method(runtime, 'exec', async () => {
    await tick();
    return ''; // alcanza para que "ip link show wlanX" no tire error y renamedOk de true
  });
}

test('ensureHwsimWifi: dos llamadas concurrentes nunca reclaman el mismo par phy', async (t) => {
  hwsimWifi._resetHwsimClaimTailForTests();
  t.mock.method(store, 'readAll', () => []); // sin otras instancias registradas para la nuance de reload

  const hostState = makeSharedHostState([
    { phy: 'phy0', iface: 'wlan0' },
    { phy: 'phy1', iface: 'wlan1' },
    { phy: 'phy2', iface: 'wlan2' },
    { phy: 'phy3', iface: 'wlan3' },
  ]);
  const pidByContainer = { 'container-a': '1001', 'container-b': '2002' };
  const instanceIdByPid = { 1001: 'instance-a', 2002: 'instance-b' };
  mockExecFile(t, hostState, instanceIdByPid);
  mockRuntime(t, pidByContainer);

  await Promise.all([
    hwsimWifi.ensureHwsimWifi('instance-a', 'container-a'),
    hwsimWifi.ensureHwsimWifi('instance-b', 'container-b'),
  ]);

  assert.deepEqual(hostState.collisions, []);
  // Los 4 phys del fixture alcanzan exactamente para las 2 instancias (2 cada
  // una) -- si sobra alguno, alguna se quedo corta sin necesidad.
  assert.equal(hostState.free.length, 0);

  const claimedPairs = Object.entries(hostState.claimedBy).reduce((acc, [phy, owner]) => {
    (acc[owner] ||= []).push(phy);
    return acc;
  }, {});
  assert.equal(claimedPairs['instance-a']?.length, 2);
  assert.equal(claimedPairs['instance-b']?.length, 2);
  // Los reclamos son disjuntos: ningun phy aparece en las dos listas.
  const overlap = claimedPairs['instance-a'].filter((phy) => claimedPairs['instance-b'].includes(phy));
  assert.deepEqual(overlap, []);
});

test('ensureHwsimWifi: con 3 phys libres para 2 instancias, ninguna se pisa aunque una se quede sin wifi', async (t) => {
  hwsimWifi._resetHwsimClaimTailForTests();
  t.mock.method(store, 'readAll', () => []);

  const hostState = makeSharedHostState([
    { phy: 'phy0', iface: 'wlan0' },
    { phy: 'phy1', iface: 'wlan1' },
    { phy: 'phy2', iface: 'wlan2' },
  ]);
  const pidByContainer = { 'container-a': '1001', 'container-b': '2002' };
  const instanceIdByPid = { 1001: 'instance-a', 2002: 'instance-b' };
  mockExecFile(t, hostState, instanceIdByPid);
  mockRuntime(t, pidByContainer);

  // No debe rechazar ninguna de las dos -- a la que le toca menos de 2 phys
  // libres, ensureHwsimWifi loguea un warning y devuelve sin lanzar.
  await assert.doesNotReject(Promise.all([
    hwsimWifi.ensureHwsimWifi('instance-a', 'container-a'),
    hwsimWifi.ensureHwsimWifi('instance-b', 'container-b'),
  ]));

  assert.deepEqual(hostState.collisions, []);
  // El unico phy sobrante (no alcanza para armar un segundo par) queda sin
  // asignar -- lo importante es que nunca se intento mover el mismo phy dos
  // veces (eso hubiera quedado registrado en collisions arriba).
  assert.equal(hostState.free.length, 1);
});
