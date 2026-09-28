const fs = require('fs');
const { execFile } = require('child_process');
const { promisify } = require('util');
const runtime = require('./dockerRuntime');
const store = require('./store');
const hwAccel = require('./hwAccel');
const images = require('../../images.json');

const ANDROID_ID_DEADLINE_HOURS = 48;

const execFileAsync = promisify(execFile);

async function checkDockerSocket() {
  try {
    await runtime.docker.ping();
    return { status: 'ok', detail: 'Socket de Docker respondiendo.' };
  } catch (e) {
    return {
      status: 'fail',
      detail: `No se pudo hablar con el socket de Docker: ${e.message}`,
      fix: 'Confirmar que /var/run/docker.sock esta montado en el contenedor de redroid-forge (ver docker-compose.yml) y que el daemon de Docker esta corriendo en el host.',
    };
  }
}

function checkBinderfs() {
  const ctrlPath = '/dev/binderfs/binder-control';
  if (fs.existsSync(ctrlPath)) {
    return { status: 'ok', detail: `${ctrlPath} presente.` };
  }
  return {
    status: 'fail',
    detail: `${ctrlPath} no existe — binderfs no esta montado en el host.`,
    fix: [
      'Ejecutar en el HOST (no dentro del contenedor):',
      '  sudo mkdir -p /dev/binderfs',
      '  sudo mount -t binder binder /dev/binderfs',
      'Para que sobreviva un reboot, agregar a /etc/fstab:',
      '  binder /dev/binderfs binder nofail 0 0',
      '',
      'Si esto falla o el kernel no tiene CONFIG_ANDROID_BINDERFS (chequear con',
      '"grep BINDERFS /boot/config-$(uname -r)" en el HOST — kernels Debian trixie',
      'no lo tienen), hace falta el modulo binder_linux legacy en su lugar:',
      '  # /etc/modprobe.d/binder-redroid.conf',
      '  options binder_linux devices=binder,hwbinder,vndbinder,binder1,hwbinder1,vndbinder1',
      '  # /etc/modules-load.d/binder-redroid.conf',
      '  binder_linux',
      'Requiere reboot si el modulo ya estaba cargado con otra config (rmmod suele',
      'fallar con "Device or resource busy").',
    ].join('\n'),
  };
}

function checkExt4Module() {
  // Las APEX de Android son imagenes ext4 montadas por loop device. En un host
  // 100% btrfs el kernel puede no tener ext4 cargado nunca (no aparece ni en
  // /proc/filesystems) -> mount() falla con ENODEV y el sintoma real se ve
  // como fallos en cascada de vold/apexd-bootstrap con mensajes enganosos tipo
  // "cannot execv(...): No such file or directory".
  try {
    const filesystems = fs.readFileSync('/proc/filesystems', 'utf-8');
    if (/\bext4\b/.test(filesystems)) {
      return { status: 'ok', detail: 'Modulo ext4 disponible (listado en /proc/filesystems).' };
    }
    return {
      status: 'fail',
      detail: 'ext4 no aparece en /proc/filesystems del host — las APEX de Android (montadas por loop) van a fallar con ENODEV.',
      fix: [
        'Ejecutar en el HOST:',
        '  sudo modprobe ext4',
        '  echo ext4 | sudo tee /etc/modules-load.d/ext4-redroid.conf',
        'Sintoma tipico si esto falta: el boot de Android muere en segundos con',
        'errores de "cannot execv" en vold/apexd-bootstrap que parecen binarios',
        'faltantes pero en realidad es la particion APEX que nunca se monto.',
      ].join('\n'),
    };
  } catch (e) {
    return { status: 'warn', detail: `No se pudo leer /proc/filesystems: ${e.message}` };
  }
}

function checkLoopDevices() {
  const ctrlPath = '/dev/loop-control';
  if (!fs.existsSync(ctrlPath)) {
    return {
      status: 'fail',
      detail: `${ctrlPath} no existe.`,
      fix: 'Ejecutar en el HOST: sudo modprobe loop',
    };
  }
  return { status: 'ok', detail: `${ctrlPath} presente.` };
}

// Bind mount de ./data hereda el filesystem real del host — se puede leer
// desde /proc/mounts del propio contenedor sin necesitar --pid=host para esto.
function checkDataVolumeFilesystem() {
  try {
    const mounts = fs.readFileSync('/proc/mounts', 'utf-8').split('\n');
    let best = null;
    for (const line of mounts) {
      const parts = line.split(' ');
      if (parts.length < 3) continue;
      const [, mountPoint, fsType] = parts;
      if ('/app/data'.startsWith(mountPoint) && (!best || mountPoint.length > best.mountPoint.length)) {
        best = { mountPoint, fsType };
      }
    }
    if (best && best.fsType === 'btrfs') {
      return {
        status: 'warn',
        detail: '/app/data vive en btrfs — hay un gotcha conocido con volumenes de datos de instancias redroid sobre btrfs.',
        fix: 'Mover el bind mount ./data (y los volumenes de datos de las instancias) a una particion/subvolumen ext4, o crear un subvolumen btrfs dedicado sin copy-on-write (chattr +C) para esa carpeta antes de tener datos.',
      };
    }
    return { status: 'ok', detail: `/app/data sobre filesystem ${best ? best.fsType : 'desconocido'}.` };
  } catch (e) {
    return { status: 'warn', detail: `No se pudo determinar el filesystem de /app/data: ${e.message}` };
  }
}

async function checkHwsim() {
  const anyNeedsWifi = images.some((i) => i.needsHwsimWifi);
  try {
    await execFileAsync('modinfo', ['mac80211_hwsim']);
    return { status: 'ok', detail: 'Modulo mac80211_hwsim disponible para cargar.' };
  } catch (e) {
    return {
      status: anyNeedsWifi ? 'fail' : 'warn',
      detail: `mac80211_hwsim no esta disponible: ${e.message}`,
      fix: [
        'Solo hace falta si vas a usar imagenes con WiFi falso (needsHwsimWifi).',
        'Ejecutar en el HOST: sudo modprobe mac80211_hwsim radios=6',
        'Si falla, confirmar que el kernel del host tiene CONFIG_MAC80211_HWSIM (viene habilitado en los kernels estandar de Ubuntu).',
      ].join('\n'),
    };
  }
}

function checkGpu() {
  const dri = '/dev/dri';
  if (!fs.existsSync(dri)) {
    return {
      status: 'warn',
      detail: `${dri} no existe en este host — no hay aceleracion de GPU disponible.`,
      fix: 'Solo relevante para instancias con gpuMode=host. Instalar los drivers de GPU correspondientes en el host (mesa-utils para Intel/AMD, o el driver propietario de NVIDIA) y confirmar que aparecen nodos en /dev/dri.',
    };
  }
  const entries = fs.readdirSync(dri);
  return {
    status: 'ok',
    detail: `${dri} presente (${entries.join(', ')}). La compatibilidad real de gpuMode=host depende del driver instalado — no se puede confirmar en abstracto, probar una instancia y revisar los logs del contenedor.`,
  };
}

async function checkHwAccel() {
  const anyNeedsHwEnc = images.some((i) => i.hwEncCapable);
  const vendor = await hwAccel.detectGpuVendor();

  if (!hwAccel.encodeSupported(vendor)) {
    return {
      status: anyNeedsHwEnc ? 'warn' : 'ok',
      detail: `GPU detectada: ${vendor}. El daemon VA-API de hwenc (encode) solo soporta AMD/Intel -- en NVIDIA hace falta el componente separado redroid-nvidia (Fase 2 paso 2 del roadmap), todavia no portado. Las instancias con imagenes de gpuMode=soft o sin hwEncCapable no se ven afectadas.`,
    };
  }

  try {
    await hwAccel.ensureDaemonRunning();
    return {
      status: 'ok',
      detail: `GPU ${vendor} detectada, daemon VA-API (hwenc) corriendo en ${hwAccel.SOCKET_PATH}.`,
    };
  } catch (e) {
    return {
      status: 'fail',
      detail: `GPU ${vendor} detectada pero el daemon VA-API no pudo iniciar: ${e.message}`,
      fix: 'Confirmar que el binario esta compilado (backend/native/vaapi-daemon/daemon, ver su Makefile) y que /dev/dri es accesible desde el contenedor del backend.',
    };
  }
}

async function checkImagesPresent() {
  const localTags = await runtime.listLocalImageTags();
  return images.map((img) => {
    const present = localTags.has(img.dockerImage);
    const soporte = img.soporte === 'oficial' ? '✅ oficial' : '⚠️ comunidad';
    const notaSoporte = img.notaSoporte ? ` ${img.notaSoporte}` : '';
    return {
      id: `image-${img.id}`,
      label: `Imagen presente: ${img.label}`,
      status: present ? 'ok' : 'fail',
      detail: present
        ? `${img.dockerImage} ya esta en el Docker local. Soporte: ${soporte}.${notaSoporte}`
        : `${img.dockerImage} no esta en el Docker local. Soporte: ${soporte}.${notaSoporte}`,
      fix: present ? undefined : [
        'Si la imagen fue exportada en otra PC:',
        `  docker save ${img.dockerImage} | gzip > ${img.id}.tar.gz`,
        '  # copiar el archivo a esta PC, despues:',
        `  gunzip -c ${img.id}.tar.gz | docker load`,
        'Si esta pusheada a un registry propio:',
        `  docker pull <tu-registry>/${img.dockerImage}`,
      ].join('\n'),
    };
  });
}

// Google bloquea GApps en instancias no certificadas si su Android ID (GSF)
// no se registra a mano en https://www.google.com/android/uncertified dentro
// de las 48hs del primer boot con GApps. Esto es un paso humano, no algo que
// el codigo pueda hacer solo — este check solo evita que se pase por alto.
function checkAndroidIdRegistration() {
  const pending = store.readAll().filter((i) => i.hasGapps && !i.androidIdRegisteredAt);
  if (pending.length === 0) {
    return [{
      id: 'android-id-registration',
      label: 'Registro de Android ID (GApps)',
      status: 'ok',
      detail: 'No hay instancias con GApps pendientes de registrar (o no tenes ninguna con GApps todavia).',
    }];
  }

  return pending.map((i) => {
    const hoursSinceCreated = (Date.now() - new Date(i.createdAt).getTime()) / 3_600_000;
    const hoursLeft = Math.round(ANDROID_ID_DEADLINE_HOURS - hoursSinceCreated);
    if (!i.androidId) {
      return {
        id: `android-id-${i.id}`,
        label: `Android ID pendiente: ${i.name}`,
        status: 'warn',
        detail: `Todavia no se pudo leer el Android ID de "${i.name}" (puede que GMS no haya terminado de inicializar). Se reintenta solo en los primeros minutos tras el arranque; si sigue sin aparecer despues de eso, mirala con GET /api/instances/${i.id}/android-id.`,
      };
    }
    return {
      id: `android-id-${i.id}`,
      label: `Android ID sin registrar: ${i.name}`,
      status: hoursLeft <= 0 ? 'fail' : 'warn',
      detail: hoursLeft <= 0
        ? `"${i.name}" lleva mas de ${ANDROID_ID_DEADLINE_HOURS}hs sin registrar su Android ID (${i.androidId}) — Google puede haber bloqueado ya el acceso a GApps en esta instancia.`
        : `"${i.name}" tiene Android ID ${i.androidId} sin registrar. Quedan ~${hoursLeft}hs antes de que Google bloquee GApps en esta instancia.`,
      fix: [
        `1. Copiar el Android ID: ${i.androidId}`,
        '2. Registrarlo en https://www.google.com/android/uncertified',
        `3. Marcarlo como hecho: POST /api/instances/${i.id}/android-id/registered (o desde la UI)`,
      ].join('\n'),
    };
  });
}

async function runAll() {
  const [dockerSocket, hwsim, imagePresence, hwAccelCheck] = await Promise.all([
    checkDockerSocket(),
    checkHwsim(),
    checkImagesPresent(),
    checkHwAccel(),
  ]);

  const checks = [
    { id: 'docker-socket', label: 'Socket de Docker', ...dockerSocket },
    { id: 'binderfs', label: 'binderfs montado', ...checkBinderfs() },
    { id: 'loop-devices', label: 'Loop devices', ...checkLoopDevices() },
    { id: 'ext4-module', label: 'Modulo ext4 (montaje de APEX por loop)', ...checkExt4Module() },
    { id: 'data-fs', label: 'Filesystem de /app/data', ...checkDataVolumeFilesystem() },
    { id: 'hwsim', label: 'mac80211_hwsim (WiFi falso)', ...hwsim },
    { id: 'gpu', label: 'GPU / /dev/dri', ...checkGpu() },
    { id: 'hw-accel', label: 'Aceleracion HW (hwenc, VA-API)', ...hwAccelCheck },
    ...imagePresence,
    ...checkAndroidIdRegistration(),
  ];

  return checks;
}

module.exports = { runAll };
