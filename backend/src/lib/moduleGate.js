const manifests = require('./moduleManifests');
const acceptance = require('./moduleAcceptance');
const hwAccel = require('./hwAccel');

// Which modules an image of the catalog is BOUND to, from the same flags that
// backend/images.json already has (hasGapps/needsHwsimWifi) plus hasMagisk. There is no
// separate "modules per image" list: it is derived from the metadata the catalog declares.
//
// hwenc is NOT here since the per-instance options: `hwEncCapable` now says "this image
// supports the hwenc module" and hwenc is an optional module of the instance, on by default
// (see defaultModuleIdsForImage and requiredModuleIds).
function requiredModuleIdsForImage(img) {
  const ids = [];
  if (img.hasGapps) ids.push('gapps');
  if (img.hasMagisk) ids.push('magisk');
  if (img.needsHwsimWifi) ids.push('wifi-falso');
  return ids;
}

// Optional modules an instance gets when the request does not choose (`modules` omitted):
// the hardware acceleration if the image supports it. Same behavior as before the options
// existed, which is also what instances created back then get when they are revalidated.
function defaultModuleIdsForImage(img) {
  return img.hwEncCapable ? ['hwenc'] : [];
}

// Modules that the user can choose PER INSTANCE when creating it (POST /api/instances
// {"modules": ["gapps", "hwenc", "arm-translation"]}). Anything else in that list is rejected: the request body must
// not be able to switch on modules that are not meant to be optional (fake WiFi depends on the
// image, device-profile has its own flow).
const OPTIONAL_PER_INSTANCE = ['gapps', 'hwenc', 'arm-translation'];

// The modules of an instance: what the image is bound to, plus the optional ones.
//  - `requested` omitted (undefined/null): the image's defaults (hwenc if it supports it).
//  - `requested` an array: EXACTLY those optional modules -- an instance can opt out of hwenc by
//    not listing it. It comes from the HTTP body: validated here. Throws Error with httpStatus 400.
function requiredModuleIds(img, requested) {
  const ids = requiredModuleIdsForImage(img);
  if (requested === undefined || requested === null) {
    for (const id of defaultModuleIdsForImage(img)) if (!ids.includes(id)) ids.push(id);
    return ids;
  }
  if (!Array.isArray(requested) || requested.some((m) => typeof m !== 'string')) {
    throw Object.assign(new Error('"modules" must be an array of module ids'), { httpStatus: 400 });
  }
  for (const id of requested) {
    if (!OPTIONAL_PER_INSTANCE.includes(id)) {
      throw Object.assign(
        new Error(`module "${id}" cannot be requested per instance (allowed: ${OPTIONAL_PER_INSTANCE.join(', ')})`),
        { httpStatus: 400 },
      );
    }
    if (id === 'hwenc' && !img.hwEncCapable) {
      throw Object.assign(new Error(`image "${img.id}" does not support hardware video acceleration (hwenc)`), { httpStatus: 400 });
    }
    if (!ids.includes(id)) ids.push(id);
  }
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
// `requested`: the modules asked for per instance (see requiredModuleIds()); on start/restart
// the ones persisted on the instance are passed, so its contract is revalidated too.
async function check(img, requested) {
  const requiredIds = requiredModuleIds(img, requested);
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

module.exports = {
  check, requiredModuleIdsForImage, defaultModuleIdsForImage, requiredModuleIds, OPTIONAL_PER_INSTANCE,
};
