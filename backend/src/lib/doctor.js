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
    return { status: 'ok', detail: 'Docker socket responding.' };
  } catch (e) {
    return {
      status: 'fail',
      detail: `Could not talk to the Docker socket: ${e.message}`,
      fix: 'Confirm that /var/run/docker.sock is mounted in the redroid-forge container (see docker-compose.yml) and that the Docker daemon is running on the host.',
    };
  }
}

function checkBinderfs() {
  const ctrlPath = '/dev/binderfs/binder-control';
  if (fs.existsSync(ctrlPath)) {
    return { status: 'ok', detail: `${ctrlPath} present.` };
  }
  // Legacy mode (kernel without CONFIG_ANDROID_BINDERFS): binder_linux creates
  // /dev/binderN according to `devices=`. See binder.js (useLegacyBinder).
  const legacySlots = [];
  for (let n = 0; n <= 32; n++) {
    const sfx = n === 0 ? '' : String(n);
    if (['binder', 'hwbinder', 'vndbinder'].every((b) => fs.existsSync(`/dev/${b}${sfx}`))) legacySlots.push(n);
  }
  if (legacySlots.length > 0) {
    return {
      status: 'ok',
      detail: `legacy binder (binder_linux with devices=): ${legacySlots.length} slot(s) available [${legacySlots.join(', ')}] (0 = /dev/binder without a suffix). Every instance uses one slot; if you need more simultaneous instances, extend \`devices=\`.`,
    };
  }
  return {
    status: 'fail',
    detail: `${ctrlPath} does not exist — binderfs is not mounted on the host.`,
    fix: [
      'Run on the HOST (not inside the container):',
      '  sudo mkdir -p /dev/binderfs',
      '  sudo mount -t binder binder /dev/binderfs',
      'To make it survive a reboot, add to /etc/fstab:',
      '  binder /dev/binderfs binder nofail 0 0',
      '',
      'If this fails or the kernel does not have CONFIG_ANDROID_BINDERFS (check with',
      '"grep BINDERFS /boot/config-$(uname -r)" on the HOST — Debian trixie kernels',
      'do not have it), the legacy binder_linux module is needed instead:',
      '  # /etc/modprobe.d/binder-redroid.conf',
      '  options binder_linux devices=binder,hwbinder,vndbinder,binder1,hwbinder1,vndbinder1',
      '  # /etc/modules-load.d/binder-redroid.conf',
      '  binder_linux',
      'It requires a reboot if the module was already loaded with another config (rmmod',
      'usually fails with "Device or resource busy").',
    ].join('\n'),
  };
}

function checkExt4Module() {
  // Android's APEXes are ext4 images mounted through a loop device. On a 100%
  // btrfs host the kernel may never have ext4 loaded (it does not even appear in
  // /proc/filesystems) -> mount() fails with ENODEV and the real symptom looks like
  // cascading failures of vold/apexd-bootstrap with misleading messages such as
  // "cannot execv(...): No such file or directory".
  try {
    const filesystems = fs.readFileSync('/proc/filesystems', 'utf-8');
    if (/\bext4\b/.test(filesystems)) {
      return { status: 'ok', detail: 'ext4 module available (listed in /proc/filesystems).' };
    }
    return {
      status: 'fail',
      detail: 'ext4 does not appear in the host\'s /proc/filesystems — Android\'s APEXes (mounted through loop) will fail with ENODEV.',
      fix: [
        'Run on the HOST:',
        '  sudo modprobe ext4',
        '  echo ext4 | sudo tee /etc/modules-load.d/ext4-redroid.conf',
        'Typical symptom if this is missing: Android\'s boot dies within seconds with',
        '"cannot execv" errors in vold/apexd-bootstrap that look like missing binaries',
        'but are really the APEX partition that was never mounted.',
      ].join('\n'),
    };
  } catch (e) {
    return { status: 'warn', detail: `Could not read /proc/filesystems: ${e.message}` };
  }
}

function checkLoopDevices() {
  const ctrlPath = '/dev/loop-control';
  if (!fs.existsSync(ctrlPath)) {
    return {
      status: 'fail',
      detail: `${ctrlPath} does not exist.`,
      fix: 'Run on the HOST: sudo modprobe loop',
    };
  }
  return { status: 'ok', detail: `${ctrlPath} present.` };
}

// The ./data bind mount inherits the host's real filesystem — it can be read from
// the container's own /proc/mounts without needing --pid=host for this.
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
        detail: '/app/data lives on btrfs — there is a known gotcha with redroid instances\' data volumes on btrfs.',
        fix: 'Move the ./data bind mount (and the instances\' data volumes) to an ext4 partition/subvolume, or create a dedicated btrfs subvolume without copy-on-write (chattr +C) for that folder before having any data.',
      };
    }
    return { status: 'ok', detail: `/app/data on filesystem ${best ? best.fsType : 'unknown'}.` };
  } catch (e) {
    return { status: 'warn', detail: `Could not determine the filesystem of /app/data: ${e.message}` };
  }
}

async function checkHwsim() {
  const anyNeedsWifi = images.some((i) => i.needsHwsimWifi);
  try {
    await execFileAsync('modinfo', ['mac80211_hwsim']);
    return { status: 'ok', detail: 'mac80211_hwsim module available to load.' };
  } catch (e) {
    return {
      status: anyNeedsWifi ? 'fail' : 'warn',
      detail: `mac80211_hwsim is not available: ${e.message}`,
      fix: [
        'It is only needed if you will use images with fake WiFi (needsHwsimWifi).',
        'Run on the HOST: sudo modprobe mac80211_hwsim radios=6',
        'If it fails, confirm that the host kernel has CONFIG_MAC80211_HWSIM (it comes enabled in the standard Ubuntu kernels).',
      ].join('\n'),
    };
  }
}

function checkGpu() {
  const dri = '/dev/dri';
  if (!fs.existsSync(dri)) {
    return {
      status: 'warn',
      detail: `${dri} does not exist on this host — no GPU acceleration is available.`,
      fix: 'Only relevant for instances with gpuMode=host. Install the corresponding GPU drivers on the host (mesa-utils for Intel/AMD, or NVIDIA\'s proprietary driver) and confirm that nodes appear in /dev/dri.',
    };
  }
  const entries = fs.readdirSync(dri);
  return {
    status: 'ok',
    detail: `${dri} present (${entries.join(', ')}). The real compatibility of gpuMode=host depends on the installed driver — it cannot be confirmed in the abstract, try an instance and check the container's logs.`,
  };
}

async function checkHwAccel() {
  const anyNeedsHwEnc = images.some((i) => i.hwEncCapable);
  const vendor = await hwAccel.detectGpuVendor();

  if (!hwAccel.encodeSupported(vendor)) {
    return {
      status: anyNeedsHwEnc ? 'warn' : 'ok',
      detail: `GPU detected: ${vendor}. hwenc's VA-API daemon (encode) only supports AMD/Intel -- on NVIDIA the separate redroid-nvidia component is needed (Phase 2 step 2 of the roadmap), not ported yet. Instances with gpuMode=soft images or without hwEncCapable are not affected.`,
    };
  }

  try {
    await hwAccel.ensureDaemonRunning();
    return {
      status: 'ok',
      detail: `${vendor} GPU detected, VA-API daemon (hwenc) running at ${hwAccel.SOCKET_PATH}.`,
    };
  } catch (e) {
    return {
      status: 'fail',
      detail: `${vendor} GPU detected but the VA-API daemon could not start: ${e.message}`,
      fix: 'Confirm that the binary is built (backend/native/vaapi-daemon/daemon, see its Makefile) and that /dev/dri is accessible from the backend container.',
    };
  }
}

async function checkImagesPresent() {
  const localTags = await runtime.listLocalImageTags();
  return images.map((img) => {
    const present = localTags.has(img.dockerImage);
    const soporte = img.soporte === 'oficial' ? '✅ official' : '⚠️ community';
    const notaSoporte = img.notaSoporte ? ` ${img.notaSoporte}` : '';
    return {
      id: `image-${img.id}`,
      label: `Image present: ${img.label}`,
      status: present ? 'ok' : 'fail',
      detail: present
        ? `${img.dockerImage} is already in the local Docker. Support: ${soporte}.${notaSoporte}`
        : `${img.dockerImage} is not in the local Docker. Support: ${soporte}.${notaSoporte}`,
      fix: present ? undefined : [
        'If the image was exported on another PC:',
        `  docker save ${img.dockerImage} | gzip > ${img.id}.tar.gz`,
        '  # copy the file to this PC, then:',
        `  gunzip -c ${img.id}.tar.gz | docker load`,
        'If it is pushed to your own registry:',
        `  docker pull <your-registry>/${img.dockerImage}`,
      ].join('\n'),
    };
  });
}

// Google blocks GApps on uncertified instances if their Android ID (GSF) is not
// registered by hand at https://www.google.com/android/uncertified within 48
// hours of the first boot with GApps. This is a human step, not something the
// code can do on its own — this check only prevents it from being overlooked.
function checkAndroidIdRegistration() {
  const pending = store.readAll().filter((i) => i.hasGapps && !i.androidIdRegisteredAt);
  if (pending.length === 0) {
    return [{
      id: 'android-id-registration',
      label: 'Android ID registration (GApps)',
      status: 'ok',
      detail: 'There are no GApps instances pending registration (or you have none with GApps yet).',
    }];
  }

  return pending.map((i) => {
    const hoursSinceCreated = (Date.now() - new Date(i.createdAt).getTime()) / 3_600_000;
    const hoursLeft = Math.round(ANDROID_ID_DEADLINE_HOURS - hoursSinceCreated);
    if (!i.androidId) {
      return {
        id: `android-id-${i.id}`,
        label: `Android ID pending: ${i.name}`,
        status: 'warn',
        detail: `The Android ID of "${i.name}" could not be read yet (GMS may not have finished initializing). It retries by itself in the first minutes after startup; if it still does not show up after that, check it with GET /api/instances/${i.id}/android-id.`,
      };
    }
    return {
      id: `android-id-${i.id}`,
      label: `Android ID not registered: ${i.name}`,
      status: hoursLeft <= 0 ? 'fail' : 'warn',
      detail: hoursLeft <= 0
        ? `"${i.name}" has gone more than ${ANDROID_ID_DEADLINE_HOURS} h without registering its Android ID (${i.androidId}) — Google may already have blocked GApps access on this instance.`
        : `"${i.name}" has Android ID ${i.androidId} unregistered. About ${hoursLeft} h remain before Google blocks GApps on this instance.`,
      fix: [
        `1. Copy the Android ID: ${i.androidId}`,
        '2. Register it at https://www.google.com/android/uncertified',
        `3. Mark it as done: POST /api/instances/${i.id}/android-id/registered (or from the UI)`,
      ].join('\n'),
    };
  });
}

// Known-combinations database (docs/KNOWN-COMBINATIONS.md). Informative: never
// 'fail' because of age -- the app works the same without it, it just knows less
// about which combinations are validated.
function checkKnownDb() {
  const knownDbStore = require('./knownDbStore');
  try {
    const cur = knownDbStore.loadCurrent();
    const s = knownDbStore.summarize(cur);
    const origen = s.source === 'snapshot' ? 'this version\'s snapshot' : 'downloaded database';
    const detail = `Database serial ${s.serial} (${s.generatedAt.slice(0, 10)}, ${origen}): ${s.counts.combinaciones} combination(s), ${s.counts.oficiales} validated by the project.`;
    const last = require('./knownDbUpdate').getLastCheck();
    const nueva = last && last.ok && last.disponible
      ? ` A newer database is published (serial ${last.serialRemoto}): update it with POST /api/db/update.`
      : '';
    if (s.warnings.length) {
      return { status: 'warn', detail: `${detail}${nueva} Warnings: ${s.warnings.join('; ')}` };
    }
    return { status: 'ok', detail: `${detail}${nueva}` };
  } catch (e) {
    return {
      status: 'warn',
      detail: `Could not load the known-combinations database: ${e.message}. Without it every combination is treated as "no known support".`,
    };
  }
}

async function runAll() {
  const [dockerSocket, hwsim, imagePresence, hwAccelCheck] = await Promise.all([
    checkDockerSocket(),
    checkHwsim(),
    checkImagesPresent(),
    checkHwAccel(),
  ]);

  const checks = [
    { id: 'docker-socket', label: 'Docker socket', ...dockerSocket },
    { id: 'binderfs', label: 'binderfs mounted', ...checkBinderfs() },
    { id: 'loop-devices', label: 'Loop devices', ...checkLoopDevices() },
    { id: 'ext4-module', label: 'ext4 module (APEX mounting through loop)', ...checkExt4Module() },
    { id: 'data-fs', label: '/app/data filesystem', ...checkDataVolumeFilesystem() },
    { id: 'hwsim', label: 'mac80211_hwsim (fake WiFi)', ...hwsim },
    { id: 'gpu', label: 'GPU / /dev/dri', ...checkGpu() },
    { id: 'hw-accel', label: 'HW acceleration (hwenc, VA-API)', ...hwAccelCheck },
    { id: 'known-db', label: 'Known-combinations database', ...checkKnownDb() },
    ...imagePresence,
    ...checkAndroidIdRegistration(),
  ];

  return checks;
}

module.exports = { runAll, checkKnownDb };
