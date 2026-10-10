const express = require('express');
const manifests = require('../lib/moduleManifests');
const acceptance = require('../lib/moduleAcceptance');
const catalog = require('../../images.json');

const router = express.Router();

// The same manifest is used both to list the module catalog and for the
// frontend to render the generic contract modal (section 5) -- here the
// acceptance state is added and, if asked for a specific image (?imageId=),
// whether it is compatible with it (compatibleCon).
function withStatus(manifest, imageId) {
  const latest = acceptance.latestFor(manifest.id);
  const out = {
    ...manifest,
    accepted: acceptance.isAccepted(manifest.id, manifest.version),
    acceptedVersion: latest ? latest.version : null,
    acceptedAt: latest ? latest.acceptedAt : null,
  };

  if (imageId) {
    const img = catalog.find((i) => i.id === imageId);
    if (img) {
      out.compatible = manifests.isCompatible(manifest, img);
      out.incompatibilityReason = out.compatible ? null : manifests.incompatibilityReason(manifest, img);
    } else {
      out.compatible = null;
      out.incompatibilityReason = `Unknown image: ${imageId}`;
    }
  }

  return out;
}

router.get('/', (req, res) => {
  res.json(manifests.list().map((m) => withStatus(m, req.query.imageId)));
});

// GApps does not download anything: the user provides the files (see the module's manifest).
// This lets the UI say, BEFORE creating the instance and asking to accept the contract,
// whether the folder is ready -- it verifies the sha256 of every file, which is exactly what
// the module does when it injects. Declared before '/:id' so that "gapps" is not an id.
router.get('/gapps/status', async (req, res) => {
  const gapps = require('../modules/gapps/integrate');
  try {
    const { pkg, source } = await gapps.resolveAndVerify();
    res.json({
      ok: true, source, packageId: pkg.id || null, files: pkg.archivos.length, supported: source === 'db',
    });
  } catch (e) {
    res.json({ ok: false, message: e.message });
  }
});

router.get('/:id', (req, res) => {
  const manifest = manifests.get(req.params.id);
  if (!manifest) return res.status(404).json({ error: `Unknown module: ${req.params.id}` });
  res.json(withStatus(manifest, req.query.imageId));
});

router.post('/:id/accept', (req, res) => {
  const manifest = manifests.get(req.params.id);
  if (!manifest) return res.status(404).json({ error: `Unknown module: ${req.params.id}` });

  const { version, instanceId, instanceName, userId } = req.body || {};
  // Only the manifest's current version can be accepted -- it prevents an old
  // frontend (with an outdated cached manifest) from recording an acceptance
  // that no longer corresponds to the current contract.
  if (version !== manifest.version) {
    return res.status(409).json({
      error: `The submitted version (${version}) does not match the current version of manifest "${manifest.id}" (${manifest.version}). Read the contract again.`,
    });
  }

  const entry = acceptance.record({
    moduleId: manifest.id, version, userId, instanceId, instanceName,
  });
  res.status(201).json(entry);
});

module.exports = router;
