const { execFile } = require('child_process');
const { promisify } = require('util');
const runtime = require('./dockerRuntime');

const execFileAsync = promisify(execFile);
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
};
