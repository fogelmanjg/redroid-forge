const manifests = require('./moduleManifests');
const acceptance = require('./moduleAcceptance');

// Que modulos exige una imagen del catalogo, a partir de las mismas flags
// que ya tiene backend/images.json (hasGapps/needsHwsimWifi) mas hasMagisk
// (sumada en Fase 4) y hwEncCapable (sumada en Fase 5, ver moduleRunner.js).
// No hay lista separada de "modulos por imagen": se deriva de la metadata
// que el catalogo ya declara.
//
// hwEncCapable sigue el mismo criterio "requerido si la imagen lo declara"
// que hasGapps/hasMagisk/needsHwsimWifi, no opt-in aparte: si la imagen dice
// que trae el componente de hwenc, el usuario tiene que ver y aceptar su
// contrato (aunque sea "propio", ver seccion 5 de REQUIREMENTS.md) antes de
// que el backend lo integre -- ninguna imagen del catalogo hoy pone esta
// flag en true, asi que en la practica esto todavia no bloquea nada real.
function requiredModuleIdsForImage(img) {
  const ids = [];
  if (img.hasGapps) ids.push('gapps');
  if (img.hasMagisk) ids.push('magisk');
  if (img.needsHwsimWifi) ids.push('wifi-falso');
  if (img.hwEncCapable) ids.push('hwenc');
  return ids;
}

// Punto unico de verdad para "esta imagen puede crearse/arrancar tal cual
// esta configurada": ningun modulo que requiere puede ser incompatible con
// ella (compatibleCon) ni estar sin una aceptacion vigente de su manifest.
// Se llama tanto al crear como al (re)iniciar una instancia -- asi, si un
// manifest sube de version despues de creada la instancia, tambien bloquea
// su proximo arranque, no solo la creacion.
function check(img) {
  const requiredIds = requiredModuleIdsForImage(img);
  const pendingManifests = [];

  for (const id of requiredIds) {
    const manifest = manifests.get(id);
    if (!manifest) {
      return {
        ok: false,
        httpStatus: 500,
        error: `La imagen "${img.id}" requiere el modulo "${id}" pero no existe su manifest.`,
      };
    }

    const reason = manifests.incompatibilityReason(manifest, img);
    if (reason) {
      return {
        ok: false,
        httpStatus: 409,
        error: `No se puede usar la imagen "${img.id}": ${reason}`,
      };
    }

    if (!acceptance.isAccepted(id, manifest.version)) {
      pendingManifests.push(manifest);
    }
  }

  if (pendingManifests.length > 0) {
    return {
      ok: false,
      httpStatus: 428,
      error: 'Hace falta leer y aceptar el contrato de uno o mas modulos antes de continuar.',
      modules: pendingManifests,
    };
  }

  return { ok: true };
}

module.exports = { check, requiredModuleIdsForImage };
