const runtime = require('./dockerRuntime');
const store = require('./store');

// Ports android-identity.service.ts from plenum-redroid. The Android ID (GSF) is
// assigned by Google Play Services on its own at any boot, without this code
// intervening — all this does is READ it from the gservices.db that already lives
// in the /data volume, so it can be shown. It has to be registered by hand at
// https://www.google.com/android/uncertified within 48 hours of the first boot
// with GApps: otherwise Google blocks GApps access on that instance (it is an
// "uncertified" device).
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

// Retry in 3 rounds: quick, at 3 min (GMS needs that margin to initialize on the
// first boot), and a last attempt at +60 s just in case.
function scheduleFetch(instanceId) {
  const tryPersist = async () => {
    const instance = store.get(instanceId);
    if (!instance || instance.androidId) return true;
    const raw = await fetchFromVolume(instance.volumeName);
    if (raw) {
      store.upsert({ ...instance, androidId: raw });
      log(`Android ID persisted for ${instanceId}: ${raw}`);
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
