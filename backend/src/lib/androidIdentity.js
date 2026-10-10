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

// Where the ID lives depends on the GMS generation, but it is the same number in every
// source (the one the user pastes in https://www.google.com/android/uncertified), and it
// is read the same way jg-dashboard does it (Android 11 and 15 images): the `android_id`
// row of the `main` table of gservices.db, trying the GSF path first and the GMS path
// second (GSF-owned in the GSF 12 / kylindemons-style trio, GMS-owned in the modern
// GSF 15 + GMS 24+ trio of the gapps module). As a fallback, the same ID is also in
// shared_prefs/Checkin.xml (<string name="android_id">3607632867885909819</string>),
// confirmed on 09/10/2026 to be identical to the db value in both generations.
// It is returned EXACTLY as stored (a decimal number, ~19 digits): it is the format the
// registration has always been done with (confirmed on 09/10/2026 against the CIFI
// instance, whose ID is 3627736167647049813). It is NOT converted to hexadecimal.
const CHECKIN_XML = '/data/data/com.google.android.gms/shared_prefs/Checkin.xml';
const LEGACY_DBS = [
  '/data/data/com.google.android.gsf/databases/gservices.db',
  '/data/data/com.google.android.gms/databases/gservices.db',
];

// Pure (no I/O) so it can be tested. Returns the check-in Android ID as a decimal
// string, or null if the XML has no valid ID yet (before the first check-in completes GMS
// stores 0 or nothing).
function parseCheckinXml(xml) {
  const m = /<string\s+name="android_id">\s*(\d{1,20})\s*<\/string>/.exec(String(xml || ''));
  if (!m) return null;
  const id = BigInt(m[1]);
  if (id === 0n || id >= (1n << 64n)) return null;
  return id.toString();
}

// The legacy value comes from gservices.db as text. It is accepted only if it looks
// like an ID (digits, or hexadecimal in the oldest GSF generations); anything else is
// ignored rather than shown to the user as an ID.
function normalizeLegacyId(raw) {
  const v = String(raw || '').trim().toLowerCase();
  return /^[0-9a-f]{8,20}$/.test(v) ? v : null;
}

async function fetchFromVolume(volumeName) {
  // One ephemeral container reads both sources and prints a JSON; parsing and
  // conversion happen here in Node (parseCheckinXml/normalizeLegacyId, tested).
  const pyScript = [
    'import json, sqlite3',
    `checkin = ${JSON.stringify(CHECKIN_XML)}`,
    `paths = ${JSON.stringify(LEGACY_DBS)}`,
    'out = {"checkin": "", "legacy": ""}',
    'try:',
    '    out["checkin"] = open(checkin).read()',
    'except Exception:',
    '    pass',
    'for p in paths:',
    '    try:',
    '        c = sqlite3.connect("file:" + p + "?mode=ro", uri=True)',
    '        r = c.execute("select value from main where name=\'android_id\'").fetchone()',
    '        if r and r[0]:',
    '            out["legacy"] = str(r[0])',
    '            break',
    '    except Exception:',
    '        pass',
    'print(json.dumps(out), end="")',
  ].join('\n');

  try {
    const out = await runtime.runEphemeral(
      'python:3.12-alpine',
      ['python3', '-c', pyScript],
      [`${volumeName}:/data:ro`],
    );
    const data = JSON.parse(out.trim());
    return normalizeLegacyId(data.legacy) || parseCheckinXml(data.checkin) || null;
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

module.exports = { scheduleFetch, get, markRegistered, parseCheckinXml, normalizeLegacyId };
