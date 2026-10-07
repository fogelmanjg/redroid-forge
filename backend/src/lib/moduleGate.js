const manifests = require('./moduleManifests');
const acceptance = require('./moduleAcceptance');
const hwAccel = require('./hwAccel');

// Which modules an image of the catalog requires, from the same flags that
// backend/images.json already has (hasGapps/needsHwsimWifi) plus hasMagisk
// (added in Phase 4) and hwEncCapable (added in Phase 5, see moduleRunner.js).
// There is no separate "modules per image" list: it is derived from the
// metadata the catalog already declares.
//
// hwEncCapable follows the same "required if the image declares it" criterion
// as hasGapps/hasMagisk/needsHwsimWifi, not a separate opt-in: if the image
// says it ships the hwenc component, the user has to see and accept its
// contract (even if it is "own", see section 5 of REQUIREMENTS.md) before the
// backend integrates it -- the official image in the catalog sets this flag.
function requiredModuleIdsForImage(img) {
  const ids = [];
  if (img.hasGapps) ids.push('gapps');
  if (img.hasMagisk) ids.push('magisk');
  if (img.needsHwsimWifi) ids.push('wifi-falso');
  if (img.hwEncCapable) ids.push('hwenc');
  return ids;
}

// Single source of truth for "this image can be created/started as configured":
// no module it requires may be incompatible with it (compatibleCon) or lack a
// current acceptance of its manifest. It is called both when creating and when
// (re)starting an instance -- so, if a manifest goes up a version after the
// instance was created, it also blocks its next start, not only the creation.
//
// Async because `compatibleCon.hostGpuVendor` (hwenc) is an attribute of the
// host's HARDWARE, not of the image -- unlike androidVersion/gpuMode (which
// moduleManifests.incompatibilityReason already resolves without anything
// async, comparing only against `img`), this needs to ask
// hwAccel.detectGpuVendor() (it spawns `lspci`). Before this, no module was
// ever checked against the real vendor: hwenc could be "accepted" and start
// the VA-API daemon (AMD/Intel-only) on an NVIDIA host without anything
// blocking it.
async function check(img) {
  const requiredIds = requiredModuleIdsForImage(img);
  const pendingManifests = [];
  // It is detected at most once per call, and only if some required module
  // really declares hostGpuVendor -- for an image without hardware modules
  // (most of them) this triggers no lspci.
  let hostGpuVendor;

  for (const id of requiredIds) {
    const manifest = manifests.get(id);
    if (!manifest) {
      return {
        ok: false,
        httpStatus: 500,
        error: `Image "${img.id}" requires module "${id}" but its manifest does not exist.`,
      };
    }

    const reason = manifests.incompatibilityReason(manifest, img);
    if (reason) {
      return {
        ok: false,
        httpStatus: 409,
        error: `Image "${img.id}" cannot be used: ${reason}`,
      };
    }

    if (manifest.compatibleCon.hostGpuVendor) {
      if (hostGpuVendor === undefined) hostGpuVendor = await hwAccel.detectGpuVendor();
      if (!manifest.compatibleCon.hostGpuVendor.includes(hostGpuVendor)) {
        return {
          ok: false,
          httpStatus: 409,
          error: `Module "${manifest.nombre}" cannot be used: this host has a "${hostGpuVendor}" GPU`
            + ` (compatible with: ${manifest.compatibleCon.hostGpuVendor.join(', ')}).`,
        };
      }
    }

    if (!acceptance.isAccepted(id, manifest.version)) {
      pendingManifests.push(manifest);
    }
  }

  if (pendingManifests.length > 0) {
    return {
      ok: false,
      httpStatus: 428,
      error: 'The contract of one or more modules has to be read and accepted before continuing.',
      modules: pendingManifests,
    };
  }

  return { ok: true };
}

module.exports = { check, requiredModuleIdsForImage };
