const cp = require('child_process');
const runtime = require('./dockerRuntime');
const store = require('./store');

// A proposito NO es `promisify(execFile)` (como antes, ni resuelto una sola
// vez al importar ni por-llamada): `child_process.execFile` trae su propio
// simbolo `util.promisify.custom`, que sobrevive a `t.mock.method` -- asi que
// `promisify(cp.execFile)` en un test mockeado igual termina llamando a la
// implementacion real de Node por dentro, ignorando el mock (confirmado a
// mano). Envolver el callback de `cp.execFile` a mano evita ese atajo y hace
// que los tests puedan mockear `child_process.execFile` de verdad.
function execFileAsync(file, args) {
  return new Promise((resolve, reject) => {
    cp.execFile(file, args, (err, stdout, stderr) => {
      if (err) return reject(err);
      resolve({ stdout, stderr });
    });
  });
}

const HWSIM_RADIO_COUNT = process.env.HWSIM_RADIO_COUNT || '6'; // 2 radios/instancia

function log(msg) { console.log(`[hwsimWifi] ${msg}`); }
function warn(msg) { console.warn(`[hwsimWifi] ${msg}`); }

// Porta fake-wifi-networking.service.ts de plenum-redroid. Corre como root
// dentro del contenedor privilegiado --pid=host --network=host, así que los
// comandos actúan directo sobre el host sin necesitar sudo.

function parsePhyIfacePairs(iwDevOutput) {
  const pairs = [];
  let currentPhy = null;
  for (const line of iwDevOutput.split('\n')) {
    const phyMatch = line.match(/^phy#(\d+)/);
    if (phyMatch) { currentPhy = `phy${phyMatch[1]}`; continue; }
    const ifaceMatch = line.match(/^\s*Interface (\S+)/);
    if (ifaceMatch && currentPhy) {
      pairs.push({ phy: currentPhy, iface: ifaceMatch[1] });
      currentPhy = null;
    }
  }
  return pairs;
}

// Cola de serializacion para el reclamo de pares phy/iface de hwsim (bug
// conocido, ver docs/ROADMAP.md Fase 3 paso 4): sin esto, dos instancias que
// arrancan/reinician casi al mismo tiempo pueden llamar a ensureHwsimWifi en
// paralelo, las dos leer 'iw dev' antes de que ninguna haya reclamado nada,
// ver los mismos pares "libres", y las dos intentar moverlos -- una de las
// dos termina sin radios wifi ese boot. Encadenando cada intento a esta
// unica promesa a nivel de modulo (mismo patron que una cola con mutex: el
// intento N+1 ni siquiera arranca a leer 'iw dev' hasta que el intento N
// resolvio por completo, exito o fallo) se garantiza que nunca hay dos
// lecturas de 'iw dev' en vuelo al mismo tiempo.
let hwsimClaimTail = Promise.resolve();

// Techo de cada intento en la cola: sin esto, un solo comando de host
// colgado dentro de la seccion critica (ej. un `iw phy ... set netns` que
// nunca vuelve por una llamada netlink trabada) deja `hwsimClaimTail` sin
// avanzar nunca, y CUALQUIER instancia futura que necesite wifi falso en
// este host queda esperando para siempre -- un solo comando colgado pasaba
// de "esa instancia se jode este boot" a "el host entero deja de poder
// arrancar wifi falso hasta reiniciar el backend" (hallazgo real de code
// review, PR #3). El intento abandonado puede seguir corriendo en el fondo
// (no hay forma generica de matar lo que `fn` haya lanzado por dentro,
// incluye tanto execFileAsync como runtime.exec via dockerode) -- riesgo
// residual aceptado: un reclamo tardio corriendo en paralelo con el
// siguiente, mucho mas acotado que el deadlock total que reemplaza.
const HWSIM_CLAIM_TIMEOUT_MS = Number(process.env.HWSIM_CLAIM_TIMEOUT_MS) || 30000;

function runHwsimClaim(fn) {
  const attempt = hwsimClaimTail.then(() => new Promise((resolve, reject) => {
    let settled = false;
    // Si fn() gana la carrera (el caso normal, casi siempre) el timer tiene
    // que cancelarse -- sin esto queda un setTimeout de 30s vivo por cada
    // reclamo exitoso, sosteniendo el event loop y, si nadie mas lo referencia,
    // terminando en un reject() sin handler mas tarde (unhandled rejection).
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`runHwsimClaim: intento colgado mas de ${HWSIM_CLAIM_TIMEOUT_MS}ms, se abandona para no trabar la cola`));
    }, HWSIM_CLAIM_TIMEOUT_MS);
    fn().then(
      (value) => { if (settled) return; settled = true; clearTimeout(timer); resolve(value); },
      (err) => { if (settled) return; settled = true; clearTimeout(timer); reject(err); },
    );
  }));
  // El tail sigue avanzando aunque este intento haya fallado o se haya
  // abandonado por timeout -- un reclamo rechazado nunca debe trabar a los
  // que vienen atras en la cola. `attempt` (lo que se devuelve al llamador)
  // si conserva el resultado/error real.
  hwsimClaimTail = attempt.then(() => {}, () => {});
  return attempt;
}

// Solo para tests: la cola es un singleton a nivel de modulo, asi que sin
// esto un test podria arrancar con el tail todavia "sucio" de un test
// anterior (por ejemplo uno que dejo un mock a medio resolver).
function _resetHwsimClaimTailForTests() {
  hwsimClaimTail = Promise.resolve();
}

// Instancias que efectivamente tienen phys de hwsim asignados en este
// momento -- no alcanza con "el contenedor esta corriendo" (ver mas abajo).
// Se agrega cuando claimAndAssignHwsimPair() mueve al menos un phy al netns
// de esa instancia; una entrada vieja de un contenedor que ya murio se
// descarta sola la proxima vez que se la consulta (containerId nunca se
// reusa entre instancias, asi que no hay riesgo de falso positivo mientras
// tanto).
const instancesHoldingHwsim = new Set();

// Para decidir si es seguro recargar mac80211_hwsim cuando 'iw dev' no
// muestra ningun phy libre: si de verdad todos estan en uso por otra
// instancia que sigue corriendo, recargar el modulo se los robaria (ver la
// nuance portada de jg-dashboard/redroid.service.ts). Solo se recarga si
// NINGUNA otra instancia con wifi falso esta usando hwsim ahora mismo.
//
// OJO: "usando hwsim" es instancesHoldingHwsim, no "el contenedor esta
// corriendo" (info.State.Running) -- dos instancias A y B pueden arrancar
// casi juntas, ambas con su contenedor ya "Running" en Docker antes de que
// ninguna haya reclamado nada (el reclamo esta serializado por
// runHwsimClaim). Si A revisa esto mientras el reclamo de B TODAVIA esta en
// cola detras del de A, contar a B como "corriendo" alcanzaba para que A
// concluyera mal "alguien mas esta usando hwsim" y se salteara un reload que
// podria haber liberado radios para las dos (hallazgo real de code review,
// PR #3).
async function anyOtherInstanceUsingHwsim(excludeContainerId) {
  const others = store.readAll().filter((i) => i.needsHwsimWifi && i.containerId && i.containerId !== excludeContainerId);
  for (const other of others) {
    if (!instancesHoldingHwsim.has(other.containerId)) continue;
    try {
      const info = await runtime.inspect(other.containerId);
      if (info.State.Running) return true;
      instancesHoldingHwsim.delete(other.containerId); // murio, ya no tiene nada asignado
    } catch {
      instancesHoldingHwsim.delete(other.containerId); // el contenedor ya no existe
    }
  }
  return false;
}

// Seccion critica de ensureHwsimWifi, siempre corrida a traves de
// runHwsimClaim: elige un par phy/iface libre y lo mueve al netns de la
// instancia, incluyendo el renombrado de las interfaces ya dentro de ese
// netns. Nunca corre superpuesta con otro reclamo.
async function claimAndAssignHwsimPair(instanceId, containerId, pid) {
  // Un phy de un swap anterior puede seguir con el nombre "wlan0_fake".
  await execFileAsync('ip', ['link', 'set', 'wlan0_fake', 'down']).catch(() => {});
  await execFileAsync('ip', ['link', 'set', 'wlan0_fake', 'name', 'wlan0']).catch(() => {});

  let freePairs = [];
  try {
    const { stdout } = await execFileAsync('iw', ['dev']);
    freePairs = parsePhyIfacePairs(stdout);
  } catch (e) {
    warn(`'iw dev' fallo para ${instanceId}: ${e}`);
    return;
  }

  // Visto en la practica: a veces un phy no vuelve al netns default del host
  // cuando muere el contenedor que lo tenia -- directamente desaparece
  // (causa raiz nunca confirmada). Si NINGUNO esta libre, solo tiene sentido
  // recargar el modulo si ninguna otra instancia con wifi falso esta
  // corriendo ahora mismo -- si alguna lo esta, recargar le robaria los
  // radios que ya tiene asignados.
  if (freePairs.length === 0) {
    if (await anyOtherInstanceUsingHwsim(containerId)) {
      warn(`0 phys libres para ${instanceId} pero otra instancia esta usando hwsim -- no se recarga el modulo`);
    } else {
      warn(`0 phys libres para ${instanceId} y ninguna otra instancia usando hwsim -- recargando mac80211_hwsim`);
      try {
        await execFileAsync('rmmod', ['mac80211_hwsim']);
        await execFileAsync('modprobe', ['mac80211_hwsim', `radios=${HWSIM_RADIO_COUNT}`]);
        const { stdout } = await execFileAsync('iw', ['dev']);
        freePairs = parsePhyIfacePairs(stdout);
      } catch (e) {
        warn(`recarga de mac80211_hwsim fallo para ${instanceId}: ${e}`);
      }
    }
  }

  if (freePairs.length < 2) {
    warn(`solo ${freePairs.length} phy(s) libre(s) para ${instanceId} (necesita 2) — wifi no va a andar este boot`);
    return;
  }

  const [a, b] = freePairs;
  const targetNames = ['wlan0', 'wlan1'];
  const renamedOk = [];
  for (const [i, pair] of [a, b].entries()) {
    try {
      await execFileAsync('iw', ['phy', pair.phy, 'set', 'netns', pid]);
      // A partir de aca el phy ya esta fisicamente en el netns de esta
      // instancia (independiente de si el renombrado de la interfaz debajo
      // sale bien) -- se marca ya mismo, no solo si renamedOk termina en
      // true, porque instancesHoldingHwsim existe para "no le robes este
      // phy a esta instancia", no para "el renombrado le salio perfecto".
      instancesHoldingHwsim.add(containerId);
      if (pair.iface !== targetNames[i]) {
        let ok = false;
        for (let attempt = 0; attempt < 5 && !ok; attempt++) {
          await runtime.exec(containerId, ['ip', 'link', 'set', pair.iface, 'down']).catch(() => {});
          await runtime.exec(containerId, ['ip', 'link', 'set', pair.iface, 'name', targetNames[i]]).catch(() => {});
          try {
            await runtime.exec(containerId, ['ip', 'link', 'show', targetNames[i]]);
            ok = true;
          } catch {
            await new Promise((r) => setTimeout(r, 500));
          }
        }
        renamedOk.push(ok);
        if (!ok) warn(`no se pudo renombrar ${pair.iface}->${targetNames[i]} para ${instanceId}`);
      } else {
        renamedOk.push(true);
      }
    } catch (e) {
      warn(`no se pudo mover ${pair.phy} al netns de ${instanceId}: ${e}`);
      renamedOk.push(false);
    }
  }

  if (renamedOk.every(Boolean)) {
    log(`${a.phy} (${a.iface}->wlan0), ${b.phy} (${b.iface}->wlan1) movidos al netns de ${instanceId} (pid ${pid})`);
  } else {
    warn(`setup incompleto para ${instanceId} (pid ${pid})`);
  }
}

// Corre en cada start (Docker recrea el netns cada vez). Los phys de una
// instancia vuelven solos al netns del host cuando su contenedor muere.
async function ensureHwsimWifi(instanceId, containerId) {
  try {
    await execFileAsync('modprobe', ['mac80211_hwsim', `radios=${HWSIM_RADIO_COUNT}`]);
  } catch (e) {
    warn(`modprobe fallo para ${instanceId}: ${e}`);
  }

  let pid;
  try {
    pid = await runtime.getPid(containerId);
  } catch (e) {
    warn(`no se pudo obtener el PID de ${instanceId}: ${e}`);
    return;
  }

  await runHwsimClaim(() => claimAndAssignHwsimPair(instanceId, containerId, pid));
}

function scheduleHwsimWifiFix(instanceId, containerId) {
  ensureHwsimWifi(instanceId, containerId).catch((e) => warn(`scheduleHwsimWifiFix fallo para ${instanceId}: ${e}`));
}

// El HAL de wifi falso solo dispara cuando algo le pide a Android conectarse.
async function ensureWifiConnected(instanceId, containerId) {
  const MAX_ATTEMPTS = 6;
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    let status = '';
    try {
      status = await runtime.exec(containerId, ['su', '-c', 'cmd wifi status']);
    } catch (e) {
      warn(`chequeo de estado fallo para ${instanceId}: ${e}`);
    }
    if (status.includes('Wifi is connected')) return;

    try {
      await runtime.exec(containerId, ['su', '-c', 'svc wifi enable']);
      await new Promise((r) => setTimeout(r, 3000));
      await runtime.exec(containerId, ['su', '-c', 'cmd wifi connect-network jg-wifi open']);
    } catch (e) {
      warn(`intento ${i + 1} fallo para ${instanceId}: ${e}`);
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
  warn(`se agotaron los intentos para ${instanceId} — puede necesitar reconexion manual`);
}

function scheduleWifiConnectedFix(instanceId, containerId) {
  setTimeout(() => {
    ensureWifiConnected(instanceId, containerId).catch((e) => warn(`scheduleWifiConnectedFix fallo para ${instanceId}: ${e}`));
  }, 20000);
}

// Las imagenes wifi-falso ocultan eth0 de ConnectivityService, asi que netd
// nunca agrega una ip rule "lookup main" para esa interfaz — sin eso, eth0
// queda detras de la regla catch-all "unreachable" hasta que el swap de wifi
// ocurre, y ADB se vuelve poco confiable.
async function ensureEth0Routing(instanceId, containerId) {
  const script = "ip rule show | grep -q 'lookup main' || ip rule add priority 25000 lookup main";
  const MAX_ATTEMPTS = 8;
  const RETRY_DELAY_MS = 2000;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      await runtime.exec(containerId, ['su', '-c', script]);
    } catch (e) {
      warn(`ip rule add fallo para ${instanceId} (intento ${attempt}): ${e}`);
      await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
      continue;
    }

    const ip = await runtime.getBridgeIp(containerId).catch(() => undefined);
    if (!ip) { await new Promise((r) => setTimeout(r, RETRY_DELAY_MS)); continue; }

    try {
      await execFileAsync('ip', ['neigh', 'flush', ip]);
      await execFileAsync('ping', ['-c', '1', '-W', '1', ip]).catch(() => {});
    } catch (e) {
      warn(`neigh flush fallo para ${instanceId}: ${e}`);
    }

    try {
      const { stdout } = await execFileAsync('ip', ['neigh', 'show', ip]);
      if (/\b(REACHABLE|STALE|DELAY|PROBE)\b/.test(stdout)) {
        log(`vecino resuelto para ${instanceId} en el intento ${attempt}`);
        return;
      }
    } catch (e) {
      warn(`neigh show fallo para ${instanceId}: ${e}`);
    }

    await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
  }
  warn(`vecino sigue sin resolver para ${instanceId} tras ${MAX_ATTEMPTS} intentos`);
}

function scheduleEth0RoutingFix(instanceId, containerId) {
  setTimeout(() => {
    ensureEth0Routing(instanceId, containerId).catch((e) => warn(`scheduleEth0RoutingFix fallo para ${instanceId}: ${e}`));
  }, 20000);
}

module.exports = {
  ensureHwsimWifi, scheduleHwsimWifiFix,
  ensureWifiConnected, scheduleWifiConnectedFix,
  ensureEth0Routing, scheduleEth0RoutingFix,
  _resetHwsimClaimTailForTests,
};
