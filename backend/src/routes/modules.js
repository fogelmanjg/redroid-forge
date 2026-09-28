const express = require('express');
const manifests = require('../lib/moduleManifests');
const acceptance = require('../lib/moduleAcceptance');
const catalog = require('../../images.json');

const router = express.Router();

// El mismo manifest se usa tanto para listar el catalogo de modulos como
// para que el frontend renderice el modal de contrato generico (seccion 5)
// -- acá se le suma el estado de aceptacion y, si se pide para una imagen
// puntual (?imageId=), si es compatible con ella (compatibleCon).
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
      out.incompatibilityReason = `Imagen desconocida: ${imageId}`;
    }
  }

  return out;
}

router.get('/', (req, res) => {
  res.json(manifests.list().map((m) => withStatus(m, req.query.imageId)));
});

router.get('/:id', (req, res) => {
  const manifest = manifests.get(req.params.id);
  if (!manifest) return res.status(404).json({ error: `Modulo desconocido: ${req.params.id}` });
  res.json(withStatus(manifest, req.query.imageId));
});

router.post('/:id/accept', (req, res) => {
  const manifest = manifests.get(req.params.id);
  if (!manifest) return res.status(404).json({ error: `Modulo desconocido: ${req.params.id}` });

  const { version, instanceId, instanceName, userId } = req.body || {};
  // Solo se puede aceptar la version actual del manifest -- evita que un
  // frontend viejo (con un manifest cacheado desactualizado) registre una
  // aceptacion que ya no corresponde al contrato vigente.
  if (version !== manifest.version) {
    return res.status(409).json({
      error: `La version enviada (${version}) no coincide con la version actual del manifest "${manifest.id}" (${manifest.version}). Volve a leer el contrato.`,
    });
  }

  const entry = acceptance.record({
    moduleId: manifest.id, version, userId, instanceId, instanceName,
  });
  res.status(201).json(entry);
});

module.exports = router;
