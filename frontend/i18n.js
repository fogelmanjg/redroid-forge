// Minimal i18n: English is the default and the source of truth, Spanish is the second language.
// Static texts live in the `strings` table below (HTML uses data-i18n / data-i18n-placeholder);
// the backend's manifests and images carry their own `i18n.<lang>` blocks, read through `loc()`.
// Messages the backend builds at runtime (errors, Doctor checks) are English only for now.
const I18n = (() => {
  const strings = {
    en: {
      'nav.instances': 'Instances', 'nav.modules': 'Modules', 'nav.doctor': 'Doctor', 'nav.help': 'Help',
      'common.refresh': 'Refresh', 'common.cancel': 'Cancel', 'common.loading': 'Loading...', 'common.error': 'Error: {msg}',
      'instances.new': '+ New instance',
      'instances.col.name': 'Name', 'instances.col.image': 'Image', 'instances.col.status': 'Status',
      'instances.col.adb': 'ADB', 'instances.col.androidId': 'Android ID (GApps)', 'instances.col.actions': 'Actions',
      'instances.none': 'There are no instances yet.',
      'instances.waitingBoot': 'waiting for boot...', 'instances.registered': 'registered',
      'instances.unregistered': 'not registered', 'instances.expired': ' (EXPIRED)',
      'instances.register': 'Register', 'instances.markRegistered': 'I already registered it',
      'instances.delete': 'Delete',
      'instances.confirmDelete': 'Delete instance "{name}"? This also removes its data volume.',
      'modules.intro': 'Catalog of the modules declared by manifest (section 5 of <code>docs/REQUIREMENTS.md</code>). The ones that are not 100% free software need their contract accepted before the backend activates them — see the Status column.',
      'modules.accepted': 'Accepted (v{v})',
      'modules.oldAccepted': 'Old version accepted (v{old}), current is v{cur}',
      'modules.pending': 'Pending acceptance',
      'modules.thirdParty': 'Non-free third party', 'modules.own': 'Own to the project',
      'modules.compatible': 'Compatible with: Android {android} · GPU {gpu}',
      'doctor.run': 'Run diagnostics', 'doctor.running': 'Running diagnostics...',
      'help.imageTitle': 'How to bring the image to this PC',
      'help.imageIntro': 'If the redroid image was built on another machine:',
      'help.imageCopy': '# copy the file to this PC, then:',
      'help.registry': 'If it is pushed to your own registry:',
      'help.reqTitle': 'Host requirements',
      'help.req1': 'Docker installed and running.',
      'help.req2': 'binderfs mounted at <code>/dev/binderfs</code> (see the Doctor tab for the exact command).',
      'help.req3': '<code>mac80211_hwsim</code> available if you are going to use images with fake WiFi.',
      'help.req4': 'GPU + drivers if you want acceleration (<code>gpuMode=host</code>).',
      'help.startTitle': 'Starting this manager',
      'help.startNote': 'The Doctor tab will tell you exactly what is left to configure on this host, with the command to fix it.',
      'new.title': 'New instance', 'new.name': 'Name', 'new.namePlaceholder': 'my-instance', 'new.image': 'Image', 'new.create': 'Create',
      'image.official': '✅ official', 'image.community': '⚠️ community', 'image.notPresent': ' (not present locally)',
      'contract.touches': 'What it touches / permissions it declares',
      'contract.confirm': 'I have read and understand the above, and I agree to activate this module.',
      'contract.accept': 'Accept',
      'contract.disclaimer': 'This module integrates non-free third-party software — it is not part of redroid-forge. You install/run it at your own responsibility.',
      'contract.license': 'License: {v}', 'contract.origin': 'Origin: ',
      'contract.rejected': 'The backend rejected the acceptance (HTTP {status})',
      'contract.failed': 'Could not record the module acceptance',
    },
    es: {
      'nav.instances': 'Instancias', 'nav.modules': 'Módulos', 'nav.doctor': 'Doctor', 'nav.help': 'Ayuda',
      'common.refresh': 'Actualizar', 'common.cancel': 'Cancelar', 'common.loading': 'Cargando...', 'common.error': 'Error: {msg}',
      'instances.new': '+ Nueva instancia',
      'instances.col.name': 'Nombre', 'instances.col.image': 'Imagen', 'instances.col.status': 'Estado',
      'instances.col.adb': 'ADB', 'instances.col.androidId': 'Android ID (GApps)', 'instances.col.actions': 'Acciones',
      'instances.none': 'Todavía no hay instancias.',
      'instances.waitingBoot': 'esperando boot...', 'instances.registered': 'registrado',
      'instances.unregistered': 'sin registrar', 'instances.expired': ' (VENCIDO)',
      'instances.register': 'Registrar', 'instances.markRegistered': 'Ya lo registré',
      'instances.delete': 'Borrar',
      'instances.confirmDelete': '¿Borrar la instancia "{name}"? Esto elimina también su volumen de datos.',
      'modules.intro': 'Catálogo de módulos declarados por manifest (sección 5 de <code>docs/REQUIREMENTS.md</code>). Los que no son 100% software libre necesitan aceptar su contrato antes de que el backend los active — ver la columna Estado.',
      'modules.accepted': 'Aceptado (v{v})',
      'modules.oldAccepted': 'Versión vieja aceptada (v{old}), la actual es v{cur}',
      'modules.pending': 'Pendiente de aceptar',
      'modules.thirdParty': 'Tercero no libre', 'modules.own': 'Propio del proyecto',
      'modules.compatible': 'Compatible con: Android {android} · GPU {gpu}',
      'doctor.run': 'Correr diagnóstico', 'doctor.running': 'Corriendo diagnóstico...',
      'help.imageTitle': 'Cómo llevar la imagen a esta PC',
      'help.imageIntro': 'Si la imagen redroid se armó en otra máquina:',
      'help.imageCopy': '# copiar el archivo a esta PC, después:',
      'help.registry': 'Si está pusheada a un registry propio:',
      'help.reqTitle': 'Requisitos del host',
      'help.req1': 'Docker instalado y corriendo.',
      'help.req2': 'binderfs montado en <code>/dev/binderfs</code> (ver la pestaña Doctor para el comando exacto).',
      'help.req3': '<code>mac80211_hwsim</code> disponible si vas a usar imágenes con WiFi falso.',
      'help.req4': 'GPU + drivers si querés aceleración (<code>gpuMode=host</code>).',
      'help.startTitle': 'Levantar este manager',
      'help.startNote': 'La pestaña Doctor te va a decir exactamente qué falta configurar en este host, con el comando para arreglarlo.',
      'new.title': 'Nueva instancia', 'new.name': 'Nombre', 'new.namePlaceholder': 'mi-instancia', 'new.image': 'Imagen', 'new.create': 'Crear',
      'image.official': '✅ oficial', 'image.community': '⚠️ comunidad', 'image.notPresent': ' (no presente localmente)',
      'contract.touches': 'Qué toca / permisos que declara',
      'contract.confirm': 'Leí y entiendo lo anterior, y acepto activar este módulo.',
      'contract.accept': 'Aceptar',
      'contract.disclaimer': 'Este módulo integra software de terceros no libre — no es parte de redroid-forge. Se instala/ejecuta bajo tu propia responsabilidad.',
      'contract.license': 'Licencia: {v}', 'contract.origin': 'Origen: ',
      'contract.rejected': 'El backend rechazó la aceptación (HTTP {status})',
      'contract.failed': 'No se pudo registrar la aceptación del módulo',
    },
  };

  let lang = 'en';
  try {
    const saved = localStorage.getItem('lang');
    lang = saved && strings[saved] ? saved : (navigator.language || 'en').toLowerCase().startsWith('es') ? 'es' : 'en';
  } catch (e) {
    lang = (navigator.language || 'en').toLowerCase().startsWith('es') ? 'es' : 'en';
  }

  function t(key, params) {
    const s = (strings[lang] && strings[lang][key]) || strings.en[key] || key;
    return params ? s.replace(/\{(\w+)\}/g, (m, k) => (k in params ? params[k] : m)) : s;
  }

  // Field of a manifest/image in the current language, falling back to the English base.
  function loc(obj, field) {
    const tr = obj && obj.i18n && obj.i18n[lang];
    return tr && tr[field] !== undefined ? tr[field] : obj[field];
  }

  // Applies the static texts of the HTML (data-i18n = innerHTML, data-i18n-placeholder = placeholder).
  function apply() {
    document.documentElement.lang = lang;
    document.querySelectorAll('[data-i18n]').forEach((el) => { el.innerHTML = t(el.dataset.i18n); });
    document.querySelectorAll('[data-i18n-placeholder]').forEach((el) => { el.placeholder = t(el.dataset.i18nPlaceholder); });
  }

  function setLang(next) {
    if (!strings[next]) return;
    lang = next;
    try { localStorage.setItem('lang', next); } catch (e) { /* no storage: it just won't be remembered */ }
    apply();
    document.dispatchEvent(new CustomEvent('langchange'));
  }

  return { t, loc, apply, setLang, get lang() { return lang; } };
})();
