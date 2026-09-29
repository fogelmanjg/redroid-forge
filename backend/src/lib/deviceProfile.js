const runtime = require('./dockerRuntime');

function log(msg) { console.log(`[deviceProfile] ${msg}`); }

// Porta DEVICE_PROFILES/buildDeviceProfileScript de jg-dashboard
// (redroid.service.ts) -- ver docs/ROADMAP.md Fase 3 paso 1. Play Store
// filtra que apps/juegos mostrar segun la identidad de dispositivo
// autoreportada (brand/manufacturer/model/fingerprint); la identidad
// generica "redroid" la rechazan algunos. 'samsung' imita un Galaxy A55 real
// aceptado. Nunca se toca ro.hardware/ro.boot.hardware -- son las que cargan
// el HAL de GPU, tocarlas rompe el renderizado.
const DEFAULT_PROFILE = 'redroid';

const DEVICE_PROFILES = {
  samsung: {
    brand: 'samsung', manufacturer: 'samsung', device: 'a55x', name: 'a55x', model: 'SM-A5560',
  },
};

// Dos convenciones de ruta segun generacion de imagen: Android 15 suma /etc/
// bajo product y system_ext, Android 11 no -- se prueban todas, el script
// saltea con `[ -f ]` las que no existan en la imagen puntual (mismo criterio
// que jg-dashboard, confirmado ahi con `find / -iname build.prop`).
const BUILD_PROP_FILES = [
  '/system/build.prop',
  '/system/system_ext/build.prop',
  '/system/system_ext/etc/build.prop',
  '/system/product/build.prop',
  '/system/product/etc/build.prop',
  '/vendor/build.prop',
  '/vendor/odm/etc/build.prop',
  '/vendor/vendor_dlkm/etc/build.prop',
  '/vendor/odm_dlkm/etc/build.prop',
];

const BACKUP_SUFFIX = '.rf-pre-spoof.bak';

// Hibrido: identidad del perfil (brand/device/model) + build id/version real
// de la imagen -- copiar el fingerprint literal de un dispositivo real
// generaria una inconsistencia interna entre el SDK real de la imagen y el
// que declara el fingerprint (ver memoria del proyecto de origen).
function androidFingerprint(profile, androidVersion) {
  return `${profile.brand}/${profile.device}/${profile.device}:${androidVersion}`
    + '/BP1A.250505.005.D1/eng.redroid-forge:userdebug/test-keys';
}

// Arma el script de shell que edita (perfil != null) o revierte (perfil ==
// null) build.prop. Antes de la primera mutacion de cada archivo lo respalda
// a <archivo>.rf-pre-spoof.bak dentro del propio contenedor -- asi revertir
// al perfil 'redroid' restaura el original real en vez de reconstruir
// valores por defecto (que varian por imagen/arquitectura).
function buildDeviceProfileScript(profile, androidVersion) {
  const lines = ['mount -o remount,rw /'];
  for (const file of BUILD_PROP_FILES) {
    const backup = `${file}${BACKUP_SUFFIX}`;
    if (profile) {
      const fingerprint = androidFingerprint(profile, androidVersion);
      const subs = [
        `-e 's/^(ro\\.[a-zA-Z0-9_.]*\\.brand)=.*/\\1=${profile.brand}/'`,
        `-e 's/^(ro\\.[a-zA-Z0-9_.]*\\.manufacturer)=.*/\\1=${profile.manufacturer}/'`,
        `-e 's/^(ro\\.[a-zA-Z0-9_.]*\\.device)=.*/\\1=${profile.device}/'`,
        `-e 's/^(ro\\.[a-zA-Z0-9_.]*\\.name)=.*/\\1=${profile.name}/'`,
        `-e 's/^(ro\\.[a-zA-Z0-9_.]*\\.model)=.*/\\1=${profile.model}/'`,
        // delimitador # (no /): el fingerprint trae barras sin escapar
        `-e 's#^(ro\\.[a-zA-Z0-9_.]*\\.fingerprint)=.*#\\1=${fingerprint}#'`,
      ].join(' ');
      lines.push(`[ -f '${file}' ] && { [ -f '${backup}' ] || cp '${file}' '${backup}'; sed -i -E ${subs} '${file}'; }; true`);
    } else {
      lines.push(`[ -f '${backup}' ] && cp '${backup}' '${file}'; true`);
    }
  }
  // "true" final: no todas las particiones existen en todas las imagenes
  // (algunas no tienen system_ext/odm_dlkm) -- sin esto el exit status de la
  // ultima linea faltante tiraba abajo todo el script aunque el resto se
  // haya aplicado bien.
  lines.push('true');
  return lines.join('\n');
}

function resolveProfile(profileKey) {
  const key = profileKey || DEFAULT_PROFILE;
  if (key === DEFAULT_PROFILE) return { key, profile: null };
  const profile = DEVICE_PROFILES[key];
  if (!profile) throw new Error(`Perfil de dispositivo desconocido: "${key}"`);
  return { key, profile };
}

// Aplica (perfil nombrado) o revierte (profileKey=undefined/'redroid') un
// perfil de dispositivo dentro de una instancia YA CORRIENDO -- "mount -o
// remount,rw /" necesita el overlay que arma el init de Android, no se puede
// hacer con el contenedor todavia detenido (etapa 4 de ARQUITECTURA.md no
// aplica aca). Sigue el mismo patron que ensureWifiConnected/
// ensureEth0Routing en hwsimWifi.js: 'su -c' para actuar como root dentro del
// contenedor privilegiado.
async function applyDeviceProfile(containerId, androidVersion, profileKey) {
  const { key, profile } = resolveProfile(profileKey);
  const script = buildDeviceProfileScript(profile, androidVersion);
  await runtime.exec(containerId, ['su', '-c', script]);
  log(`perfil "${key}" aplicado en el contenedor ${containerId}`);
  return key;
}

module.exports = {
  DEFAULT_PROFILE, DEVICE_PROFILES, BUILD_PROP_FILES,
  buildDeviceProfileScript, applyDeviceProfile,
};
