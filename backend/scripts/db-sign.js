#!/usr/bin/env node
// Herramienta de la persona que libera la base (docs/BASE-COMBINACIONES.md
// 4.3). Vive aca mientras no exista el repo externo redroid-forge-db, a donde
// se mudara. Sin dependencias: usa el ed25519 nativo de Node.
//
//   db-sign.js keygen <dir> [--passphrase-env VAR]   crea <dir>/db-signing.key (0600) y db-signing.pub
//   db-sign.js sign   <database.json> <key> [--passphrase-env VAR]   escribe <database.json>.sig
//   db-sign.js verify <database.json> <pub.pem>      verifica <database.json>.sig
//
// La clave privada NUNCA debe vivir en un servidor compartido ni en CI (ver 4.3).
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const [cmd, ...rest] = process.argv.slice(2);
const flag = (name) => { const i = rest.indexOf(name); return i >= 0 ? rest.splice(i, 2)[1] : null; };
const passEnv = flag('--passphrase-env');
const passphrase = passEnv ? process.env[passEnv] : undefined;
if (passEnv && !passphrase) { console.error(`la variable ${passEnv} esta vacia`); process.exit(2); }
const die = (m) => { console.error(m); process.exit(2); };

if (cmd === 'keygen') {
  const dir = rest[0] || die('uso: keygen <dir>');
  fs.mkdirSync(dir, { recursive: true });
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const privOpts = { type: 'pkcs8', format: 'pem', ...(passphrase ? { cipher: 'aes-256-cbc', passphrase } : {}) };
  const keyFile = path.join(dir, 'db-signing.key');
  fs.writeFileSync(keyFile, privateKey.export(privOpts), { mode: 0o600 });
  const pub = publicKey.export({ type: 'spki', format: 'pem' });
  fs.writeFileSync(path.join(dir, 'db-signing.pub'), pub);
  console.log(`clave privada: ${keyFile} (${passphrase ? 'protegida con passphrase' : 'SIN passphrase'})`);
  console.log('clave publica (para backend/db/trusted-keys.json):\n' + pub);
} else if (cmd === 'sign') {
  const [file, key] = rest;
  if (!file || !key) die('uso: sign <database.json> <clave-privada>');
  const priv = crypto.createPrivateKey({ key: fs.readFileSync(key), ...(passphrase ? { passphrase } : {}) });
  const sig = crypto.sign(null, fs.readFileSync(file), priv).toString('base64');
  fs.writeFileSync(`${file}.sig`, sig + '\n');
  console.log(`firma escrita en ${file}.sig`);
} else if (cmd === 'verify') {
  const [file, pub] = rest;
  if (!file || !pub) die('uso: verify <database.json> <clave-publica.pem>');
  const ok = crypto.verify(null, fs.readFileSync(file), crypto.createPublicKey(fs.readFileSync(pub)),
    Buffer.from(fs.readFileSync(`${file}.sig`, 'utf-8').trim(), 'base64'));
  console.log(ok ? 'FIRMA VALIDA' : 'FIRMA INVALIDA');
  process.exit(ok ? 0 : 1);
} else {
  die('comandos: keygen | sign | verify');
}
