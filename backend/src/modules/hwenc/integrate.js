#!/usr/bin/env node
'use strict';

// Modulo hwenc (etapas 3, 4, 5 y 6 -- ver manifest.json, moduleRunner.js y
// docs/ARQUITECTURA.md): integra el componente Codec2 de VA-API (proyecto
// redroid-hwenc, Apache-2.0, mismo autor que redroid-forge) en una instancia
// recien creada, mientras todavia esta detenida, y lo deja usable en runtime.
//
// Primer modulo que corre a traves del runner generico
// (backend/src/lib/moduleRunner.js) en vez de estar cableado a mano en
// instances.js -- expone un hook por etapa que declara en su manifest.json
// ("etapa": [3, 4, 5, 6]), con el nombre fijo que ese runner espera:
// prepareCreate (3), integrate (4), ensureHostInfraReady (5),
// ensureRuntimeReady (6, se llamaba ensureHwencReady antes de esta
// convencion).
//
// A diferencia de GApps/Magisk (seccion 6 de REQUIREMENTS.md), esto SI es
// codigo propio 100% libre -- no aplica la restriccion de "nunca alojar el
// binario". El motivo de bajarlo en vez de compilarlo en el momento es
// puramente tecnico: son binarios Android/bionic que necesitan el
// toolchain completo de AOSP para compilarse, no algo que el build normal
// de redroid-forge pueda hacer.
//
// [PENDIENTE] hoy lee los artefactos de una carpeta local
// (REDROID_HWENC_ARTIFACTS_DIR) porque redroid-hwenc todavia no publica un
// release -- cuando exista, este modulo tendria que descargarlo de ahi en
// vez de asumir que ya estan en el disco.
//
// [PENDIENTE] usa el CLI de `docker` via child_process -- valido para
// probar desde el host, pero el backend real de redroid-forge corre en una
// imagen Alpine sin ese CLI instalado (ver Dockerfile). Portar a
// dockerode's putArchive() (con uid/gid=0 en los headers del tar) cuando
// esto se enganche al flujo real de creacion de instancias.
//
// Tier 5.13 de redroid-hwenc (28-29/09): 3 bugs reales encontrados
// integrando esto como modulo contra la imagen oficial de redroid (no la
// build custom que se usaba antes) -- nombre de instancia (ya corregido en
// el binario que baja este modulo), falta la entrada de media_codecs.xml
// (ya la resuelve patchMediaCodecsXml), y el CSD del encoder (ya corregido
// en el componente). El unico que sigue sin automatizarse es la property
// AIDL/HIDL -- ver ensureRuntimeReady() mas abajo.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const hwAccel = require('../../lib/hwAccel');
const execFileAsync = promisify(execFile);

const ARTIFACTS_DIR = process.env.REDROID_HWENC_ARTIFACTS_DIR
  || '/home/jgustavo/aosp-out-redroid15/target/product/redroid_x86_64/vendor';

// Ruta relativa dentro de ARTIFACTS_DIR -> mismo path dentro de /vendor de
// la instancia. Cierre transitivo de dependencias calculado a mano el
// 28/09 (readelf -d sobre el binario + sus .so, resolviendo contra este
// mismo arbol) -- ver docs/ARQUITECTURA.md para el detalle de como se armo
// esta lista y por que NO incluye libva/libgbm/libdrm/libEGL (esas son
// dependencias del daemon del host, no de este binario -- error que se
// cometio la primera vez, corregido acá).
const FILES = [
  'bin/hw/android.hardware.media.c2-vaapi-service',
  'etc/init/android.hardware.media.c2-vaapi-service.rc',
  'etc/seccomp_policy/android.hardware.media.c2-vaapi-seccomp_policy',
  'etc/vintf/manifest/manifest_media_c2_vaapi.xml',
  'lib64/libcodec2.so',
  'lib64/libcodec2_hal_common.so',
  'lib64/libcodec2_aidl.so',
  'lib64/libcodec2_vndk.so',
  'lib64/libcodec2_soft_common.so',
  'lib64/libcodec2_hidl_plugin.so',
  'lib64/android.hardware.media.c2-V1-ndk.so',
  'lib64/libavservices_minijail.so',
  'lib64/libstagefright_bufferpool@2.0.1.so',
  'lib64/android.hardware.graphics.bufferqueue@2.0.so',
  'lib64/libsfplugin_ccodec_utils.so',
  'lib64/android.hardware.media.bufferpool@2.0.so',
  'lib64/android.hardware.media.bufferpool2-V2-ndk.so',
  'lib64/libminijail.so',
  'lib64/libion.so',
  'lib64/libdmabufheap.so',
  'lib64/libcap.so',
  'lib64/libstagefright_aidl_bufferpool2.so',
];

// El backend tiene que sumar esto al Cmd de creacion del contenedor --
// dispara redroid.c2.sh (ya viene en la imagen oficial de redroid) que
// habilita debug.stagefright.ccodec. Sin esto el framework filtra TODOS
// los componentes Codec2 sin importar que esten bien registrados (Tier 5.6
// de redroid-hwenc).
const REQUIRED_BOOT_FLAGS = ['androidboot.use_redroid_c2=1'];

const C2_ENCODER_NAME = 'c2.hardware.encoder.h264';

function log(msg) { console.log(`[hwenc-integrate] ${msg}`); }

// Etapa 3 (ver manifest.json y backend/src/lib/moduleRunner.js): que necesita
// ESTE MODULO al momento de `docker create`, antes de que exista el
// contenedor. Hasta ahora esto vivia hardcodeado a mano en instances.js
// (`if (img.hwEncCapable) binds.push(hwAccel.daemonBind())` + el flag de
// REQUIRED_BOOT_FLAGS sumado aparte, y sin usar en ningun lado) -- el runner
// generico llama a esta funcion en vez de que instances.js sepa que hwenc
// existe. El bind del socket del daemon (hwAccel.js, etapa 5) se declara
// aca, no ahi: es lo que esta instancia necesita para poder hablar con ese
// daemon una vez arrancada, aunque el daemon en si sea infraestructura
// separada del host.
function prepareCreate() {
  return { binds: [hwAccel.daemonBind()], cmd: REQUIRED_BOOT_FLAGS };
}

// No reemplaza media_codecs.xml entero -- cada imagen base (oficial,
// custom, lo que sea) puede traer includes/entradas propias que no
// queremos pisar. Se extrae el archivo YA presente en la instancia, se le
// agrega la linea del encoder si todavia no esta, y se reinyecta -- sin
// esta declaracion, MediaCodecList nunca se entera de que el componente
// existe aunque su store AIDL este bien registrado (Tier 5.6 de
// redroid-hwenc, confirmado en vivo el 28/09 contra la imagen oficial).
async function patchMediaCodecsXml(containerId) {
  const tmpPath = path.join(os.tmpdir(), `media_codecs-${containerId.slice(0, 12)}.xml`);
  await execFileAsync('docker', ['cp', `${containerId}:/vendor/etc/media_codecs.xml`, tmpPath]);
  const original = fs.readFileSync(tmpPath, 'utf-8');
  if (original.includes(C2_ENCODER_NAME)) {
    log('media_codecs.xml ya tiene la entrada del encoder, no se toca');
    return;
  }
  const patched = original.replace(
    /<Encoders>/,
    `<Encoders>\n        <MediaCodec name="${C2_ENCODER_NAME}" type="video/avc" />`,
  );
  if (patched === original) {
    throw new Error('No se encontro <Encoders> en media_codecs.xml -- formato inesperado, no se pudo parchear');
  }
  fs.writeFileSync(tmpPath, patched);
  await execFileAsync('chown', ['root:root', tmpPath]);
  await execFileAsync('docker', ['cp', tmpPath, `${containerId}:/vendor/etc/media_codecs.xml`]);
  fs.unlinkSync(tmpPath);
}

async function copyIntoContainer(containerId, srcPath, destRelPath) {
  if (!fs.existsSync(srcPath)) {
    throw new Error(`Falta el artefacto ${srcPath} -- ¿REDROID_HWENC_ARTIFACTS_DIR (${ARTIFACTS_DIR}) es el correcto?`);
  }
  // Nunca se toca srcPath -- chown/chmod van sobre una copia temporal. Esto
  // no es cosmetico: la primera version de esta funcion hacia chown/chmod
  // directo sobre srcPath (el propio arbol de ARTIFACTS_DIR/el repo), y
  // eso rompio en vivo el siguiente build incremental de AOSP el 28/09
  // (ckati fallaba con "Operation not permitted" sobre archivos que este
  // modulo habia dejado en root sin querer).
  const tmpPath = path.join(os.tmpdir(), `hwenc-${containerId.slice(0, 12)}-${path.basename(destRelPath)}`);
  fs.copyFileSync(srcPath, tmpPath);
  await execFileAsync('chown', ['root:root', tmpPath]);
  // init rechaza cualquier .rc group/world-writable ("Skipping insecure
  // file") -- los binarios/.so que salen del build de AOSP ya vienen 0644,
  // pero un archivo estatico propio de este modulo (ej. redroid-nodcc.rc,
  // creado a mano) puede heredar el umask del host y quedar 0664.
  // Reproducido en vivo el 29/09 -- mismo bug que ya documenta el DEVLOG de
  // redroid-hwenc para este mismo archivo. chmod siempre, no solo chown.
  const isExecutable = destRelPath.startsWith('bin/');
  await execFileAsync('chmod', [isExecutable ? '0755' : '0644', tmpPath]);
  await execFileAsync('docker', ['cp', tmpPath, `${containerId}:/vendor/${destRelPath}`]);
  fs.unlinkSync(tmpPath);
}

// containerId tiene que ser de un contenedor CREADO pero NUNCA ARRANCADO
// (o detenido antes de su primer boot real) -- /vendor deja de ser
// escribible segundos despues de que Android bootea por primera vez.
async function integrate(containerId) {
  log(`inyectando ${FILES.length} archivos en ${containerId}...`);
  for (const relPath of FILES) {
    await copyIntoContainer(containerId, path.join(ARTIFACTS_DIR, relPath), relPath);
  }
  // redroid-nodcc.rc (fix de Tier 5.7 de redroid-hwenc: sin esto Mesa
  // habilita DCC en el buffer real de SurfaceFlinger y VCN no puede
  // codificarlo -- "VCN - DCC surfaces not supported") no sale del build de
  // AOSP, es un archivo estatico de 2 lineas -- vive en este mismo modulo,
  // no en ARTIFACTS_DIR.
  await copyIntoContainer(
    containerId,
    path.join(__dirname, 'redroid-nodcc.rc'),
    'etc/init/redroid-nodcc.rc',
  );
  await patchMediaCodecsXml(containerId);
  log('listo -- prepareCreate() ya se encargo de sumar los boot flags requeridos al Cmd del contenedor.');
}

// Etapa 5 (ver manifest.json y moduleRunner.js): infraestructura del host de
// la que esta instancia depende para hablar con el encoder, independiente de
// cualquier instancia puntual. La logica real (spawnear el daemon, detectar
// si ya esta vivo, etc.) vive en hwAccel.js y no se duplica aca -- este
// modulo solo expone el hook con el nombre que el runner generico espera,
// delegando. Es la misma decision que ya explicaba el README de este modulo
// antes de que existiera un runner generico; ahora ademas queda enganchada
// al ciclo de vida sin casing especial en instances.js.
async function ensureHostInfraReady() {
  await hwAccel.ensureDaemonRunning();
}

// Etapa 6 (ver docs/ARQUITECTURA.md): a diferencia de integrate(), esto
// corre DESPUES del boot, sobre una instancia ya viva -- unico bug de los
// 3 encontrados en Tier 5.13 que sigue sin resolverse del lado de la
// imagen/build. media.c2.hal.selection default a "hidl" en este framework
// (el gate real, ver DEVLOG.md de redroid-hwenc -- el camino via aconfig
// flag esta compilado afuera con #if 0), asi que Codec2Client nunca busca
// stores AIDL como la nuestra hasta que se fuerza a "aidl" -- y como
// GetServiceNames() se cachea una vez por proceso, mediaserver (que ya
// arranco con el valor viejo) necesita reiniciarse para que tome el nuevo.
// [PENDIENTE] mover esto a un init trigger propio (redroid.c2.rc ya hace
// algo parecido gateado en un boot flag) para no depender de esto en
// runtime.
//
// Nombre alineado a la convencion generica del runner (STAGE_EXPORT_NAME[6]
// = "ensureRuntimeReady") -- se llamaba ensureHwencReady() antes de que
// existiera esa convencion.
async function ensureRuntimeReady(containerId) {
  // `docker exec` ya aterriza como uid=0 en la imagen oficial de redroid
  // (confirmado en vivo el 29/09) -- a diferencia del patron `su -c` que
  // usa hwsimWifi.js/redroid.service.ts para las imagenes custom con
  // Magisk, esta imagen no tiene ni siquiera un binario `su`. Si este
  // modulo se reusa alguna vez sobre una imagen que si lo necesite, agregar
  // ese wrapper de vuelta.
  await execFileAsync('docker', ['exec', containerId, 'setprop', 'media.c2.hal.selection', 'aidl']);
  await execFileAsync('docker', ['exec', containerId, 'pkill', 'mediaserver']);
  log('media.c2.hal.selection=aidl aplicado, mediaserver reiniciado');
}

module.exports = {
  prepareCreate, integrate, ensureHostInfraReady, ensureRuntimeReady, FILES, REQUIRED_BOOT_FLAGS, ARTIFACTS_DIR,
};

if (require.main === module) {
  const containerId = process.argv[2];
  if (!containerId) {
    console.error('Uso: node integrate.js <containerId>');
    process.exit(1);
  }
  integrate(containerId).catch((e) => { console.error(e); process.exit(1); });
}
