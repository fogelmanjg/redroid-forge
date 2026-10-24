'use strict';

// Whole-/data-volume backup/restore (section "Backup de instancia" of the design discussed
// 24/10/2026 -- see project memory, not a doc in this repo yet). Same core mechanism as
// jg-dashboard's redroid.service.ts#backup(): tar.gz the named volume through a throwaway
// `alpine` container, mounted read-only so a live instance is never blocked from running
// while it's backed up. Restore is new (dashboard never had it): wipe the volume and extract
// the tar back into it, with two things dashboard never needed to deal with because it never
// restored onto a DIFFERENT instance than the one that made the backup:
//   - a small sidecar .json next to each backup recording the source instance's base image
//     digest, gapps package id and module versions, so a restore onto a differently-equipped
//     instance can warn instead of silently producing broken Play Services/account state.
//   - an opt-in Android ID/GSF identity reset (default OFF -- see resetIdentity below).

const path = require('path');
const fs = require('fs');
const runtime = require('./dockerRuntime');
const instanceSupport = require('./instanceSupport');

function httpError(message, httpStatus) {
  return Object.assign(new Error(message), { httpStatus });
}

function backupFileName(instanceName, when = new Date()) {
  return `${instanceName}-${when.toISOString().replace(/[:.]/g, '-')}.tar.gz`;
}

function metaFileFor(backupPath) {
  return `${backupPath}.json`;
}

// Snapshot of exactly what the known-combinations resolver would also look at (see
// instanceSupport.buildInput) -- minus hostGpuVendor, which is a property of whatever host
// happens to restore this later, not of the backup itself.
async function captureMeta(instance) {
  const baseDigest = await runtime.getImageDigest(instance.dockerImage).catch(() => null);
  return {
    instanceName: instance.name,
    createdAt: new Date().toISOString(),
    dockerImage: instance.dockerImage,
    baseDigest,
    gappsId: instance.hasGapps ? instanceSupport.localGappsId() : null,
    modulos: instanceSupport.modulesWithVersions(instance.requiredModuleIds || []),
  };
}

// Mounts the volume read-only -- safe to run against an instance that is currently running
// (same characteristic jg-dashboard's own backup() already has; not a regression).
async function createBackup(instance, backupDir) {
  if (!instance.volumeName) throw httpError('This instance has no volume to back up.', 409);
  fs.mkdirSync(backupDir, { recursive: true });
  const file = backupFileName(instance.name);
  const dest = path.join(backupDir, file);
  const meta = await captureMeta(instance);
  await runtime.runEphemeral(
    'alpine',
    ['tar', 'czf', `/backup/${file}`, '-C', '/data', '.'],
    [`${instance.volumeName}:/data:ro`, `${backupDir}:/backup`],
    300000,
  );
  fs.writeFileSync(metaFileFor(dest), JSON.stringify(meta, null, 2));
  return { file, path: dest, meta };
}

// Every backup in backupDir, not filtered by instance -- restoring a backup onto a
// DIFFERENT instance than the one that made it (migrating between hosts/instances) is one
// of the supported use cases, so there is no "this instance's backups" subset to list.
function listBackups(backupDir) {
  if (!fs.existsSync(backupDir)) return [];
  return fs.readdirSync(backupDir)
    .filter((f) => f.endsWith('.tar.gz'))
    .map((file) => {
      const full = path.join(backupDir, file);
      let meta = null;
      try { meta = JSON.parse(fs.readFileSync(metaFileFor(full), 'utf-8')); } catch { /* no/invalid sidecar */ }
      return { file, sizeBytes: fs.statSync(full).size, meta };
    })
    .sort((a, b) => (b.meta?.createdAt || '').localeCompare(a.meta?.createdAt || ''));
}

// Only a bare filename inside backupDir, never a path -- this comes straight from a
// request body.
function resolveBackupPath(backupDir, file) {
  if (!file || path.basename(file) !== file || !file.endsWith('.tar.gz')) {
    throw httpError('Invalid backup file name.', 400);
  }
  const full = path.join(backupDir, file);
  if (!fs.existsSync(full)) throw httpError(`Backup "${file}" not found.`, 404);
  return full;
}

function deleteBackup(backupDir, file) {
  const full = resolveBackupPath(backupDir, file);
  fs.unlinkSync(full);
  try { fs.unlinkSync(metaFileFor(full)); } catch { /* sidecar missing/already gone -- fine */ }
}

// Compatibility warnings (never block the restore -- same "warn, don't gatekeep" posture as
// the known-combinations tiers): version mismatch, and gapps id mismatch specifically (that's
// the one piece of restored data most likely to end up orphaned if the id differs, since
// Play Services ties its account/signature state to the exact package that's installed).
function compatibilityWarnings(meta, instance) {
  const warnings = [];
  if (!meta) {
    warnings.push('This backup has no metadata (made before this feature existed, or the sidecar file is missing) -- compatibility cannot be checked.');
    return warnings;
  }
  if (meta.dockerImage && meta.dockerImage !== instance.dockerImage) {
    warnings.push(`This backup was made on image "${meta.dockerImage}", this instance runs "${instance.dockerImage}". Restoring across different images/Android versions is not supported -- expect breakage.`);
  }
  if (instance.hasGapps && meta.gappsId && meta.gappsId !== instanceSupport.localGappsId()) {
    warnings.push(`This backup's GApps package id ("${meta.gappsId}") differs from this instance's ("${instanceSupport.localGappsId()}") -- restored Play Services/account data may end up orphaned.`);
  }
  return warnings;
}

// resetIdentity (default false, opt-in): wipes com.google.android.gsf/gms AFTER extracting
// the backup, so Android/Play Services generate a fresh Android ID on next boot instead of
// carrying over the backup's. Partial mitigation only -- a Google account that stays logged
// in can still correlate the two instances by the account itself, not just the device id;
// that's why the clash warning below fires independently of this flag.
async function restoreBackup(instance, backupDir, file, { resetIdentity = false } = {}) {
  if (!instance.volumeName) throw httpError('This instance has no volume to restore into.', 409);
  const info = await runtime.inspect(instance.containerId).catch(() => null);
  if (info?.State?.Status === 'running') {
    throw httpError('Stop the instance before restoring a backup -- its /data cannot be safely replaced while it is running.', 409);
  }
  const backupPath = resolveBackupPath(backupDir, file);
  let meta = null;
  try { meta = JSON.parse(fs.readFileSync(metaFileFor(backupPath), 'utf-8')); } catch { /* no/invalid sidecar */ }
  const warnings = compatibilityWarnings(meta, instance);

  await runtime.runEphemeral(
    'alpine',
    ['sh', '-c', 'find /data -mindepth 1 -delete && tar xzf /backup.tar.gz -C /data'],
    [`${instance.volumeName}:/data`, `${backupPath}:/backup.tar.gz:ro`],
    300000,
  );
  if (resetIdentity) {
    await runtime.runEphemeral(
      'alpine',
      ['sh', '-c', 'rm -rf /data/data/com.google.android.gsf /data/data/com.google.android.gms'],
      [`${instance.volumeName}:/data`],
      60000,
    );
  } else if (instance.hasGapps) {
    warnings.push('Identity not reset: this instance keeps the same Android ID/GSF identity as the backup. Do not run the original and this restored copy at the same time -- Google may see the same device twice.');
  }
  return { warnings };
}

module.exports = {
  createBackup, listBackups, restoreBackup, deleteBackup, backupFileName, compatibilityWarnings,
};
