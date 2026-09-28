const runtime = require('./dockerRuntime');
const store = require('./store');

// Porta android-identity.service.ts de plenum-redroid. El Android ID (GSF) lo
// asigna Google Play Services solo en cualquier boot, sin que este codigo
// intervenga — lo unico que hace esto es LEERLO desde el gservices.db que ya
// vive en el volumen /data, para poder mostrarlo. Hay que registrarlo a mano
// en https://www.google.com/android/uncertified dentro de las 48hs del primer
// boot con GApps: si no, Google bloquea el acceso a GApps en esa instancia
// (ver [[reference_redroid_...]] — dispositivo "no certificado").
function log(msg) { console.log(`[androidIdentity] ${msg}`); }

async function fetchFromVolume(volumeName) {
  const pyScript = [
    'import sqlite3',
    'paths = ["/data/data/com.google.android.gsf/databases/gservices.db", "/data/data/com.google.android.gms/databases/gservices.db"]',
    'result = ""',
    'for p in paths:',
    '    try:',
    '        c = sqlite3.connect(p)',
    '        r = c.execute("select value from main where name=\'android_id\'").fetchone()',
    '        if r and r[0]:',
    '            result = r[0]',
    '            break',
    '    except Exception:',
    '        pass',
    'print(result, end="")',
  ].join('\n');

  try {
    const out = await runtime.runEphemeral(
      'python:3.12-alpine',
      ['python3', '-c', pyScript],
      [`${volumeName}:/data:ro`],
    );
    const raw = out.trim();
    return raw || null;
  } catch {
    return null;
  }
}

// Reintento en 3 tandas: rapido, a los 3min (GMS necesita ese margen para
// inicializar en el primer boot), y un ultimo intento a los +60s por si acaso.
function scheduleFetch(instanceId) {
  const tryPersist = async () => {
    const instance = store.get(instanceId);
    if (!instance || instance.androidId) return true;
    const raw = await fetchFromVolume(instance.volumeName);
    if (raw) {
      store.upsert({ ...instance, androidId: raw });
      log(`Android ID persistido para ${instanceId}: ${raw}`);
      return true;
    }
    return false;
  };

  setTimeout(async () => {
    if (!(await tryPersist())) {
      setTimeout(async () => {
        if (!(await tryPersist())) setTimeout(tryPersist, 60_000);
      }, 3 * 60 * 1000);
    }
  }, 5_000);
}

async function get(instanceId) {
  const instance = store.get(instanceId);
  if (!instance) return null;
  const raw = await fetchFromVolume(instance.volumeName);
  if (raw && raw !== instance.androidId) {
    store.upsert({ ...instance, androidId: raw });
  }
  return raw || instance.androidId || null;
}

function markRegistered(instanceId) {
  const instance = store.get(instanceId);
  if (!instance) return null;
  const updated = { ...instance, androidIdRegisteredAt: new Date().toISOString() };
  store.upsert(updated);
  return updated;
}

module.exports = { scheduleFetch, get, markRegistered };
