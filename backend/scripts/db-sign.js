#!/usr/bin/env node
// Herramienta de la persona que libera la base (docs/KNOWN-COMBINATIONS.md
// 4.3). Sin dependencias: usa el ed25519 nativo de Node. Esta copia vive en
// redroid-forge y se mantiene identica a la de tools/ en redroid-forge-db.
//
//   db-sign.js keygen <dir> [--passphrase-env VAR | --no-passphrase]
//       crea <dir>/db-signing.key (0600) y <dir>/db-signing.pub
//   db-sign.js sign   <database.json> <clave-privada> [--passphrase-env VAR]
//       escribe <database.json>.sig
//   db-sign.js verify <database.json> <clave-publica.pem>
//       verifica <database.json>.sig
//
// Passphrase: por defecto se PIDE POR TERMINAL con la entrada oculta (la
// persona que firma la escribe; nada la ve ni la guarda). --passphrase-env
// existe para automatizar/testear. La clave privada NUNCA debe vivir en un
// servidor compartido ni en CI (ver 4.3).
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const MIN_PASSPHRASE = 12;
const args = process.argv.slice(2);
const cmd = args.shift();
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args.splice(i, 2)[1] : null; };
const bool = (name) => { const i = args.indexOf(name); if (i >= 0) { args.splice(i, 1); return true; } return false; };
const die = (m) => { console.error(m); process.exit(2); };

// Pide un texto por terminal sin hacer eco. Falla si no hay TTY.
function promptHidden(question) {
  if (!process.stdin.isTTY) die('no hay terminal interactiva para pedir la passphrase: usa --passphrase-env VAR');
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl.stdoutMuted = false;
    rl._writeToOutput = (s) => { if (!rl.stdoutMuted) rl.output.write(s); };
    rl.question(question, (answer) => { rl.output.write('\n'); rl.close(); resolve(answer); });
    rl.stdoutMuted = true;
  });
}

async function newPassphrase() {
  const a = await promptHidden(`Passphrase nueva (minimo ${MIN_PASSPHRASE} caracteres): `);
  if (a.length < MIN_PASSPHRASE) die(`la passphrase debe tener al menos ${MIN_PASSPHRASE} caracteres`);
  const b = await promptHidden('Repetila: ');
  if (a !== b) die('las passphrases no coinciden');
  return a;
}

async function main() {
  const passEnv = flag('--passphrase-env');
  const noPass = bool('--no-passphrase');
  let passphrase = passEnv ? process.env[passEnv] : undefined;
  if (passEnv && !passphrase) die(`la variable ${passEnv} esta vacia`);

  if (cmd === 'keygen') {
    const dir = args[0] || die('uso: keygen <dir> [--passphrase-env VAR | --no-passphrase]');
    const keyFile = path.join(dir, 'db-signing.key');
    if (fs.existsSync(keyFile)) die(`ya existe ${keyFile}: no se sobrescribe (borralo a mano si de verdad queres otra)`);
    if (!passphrase && !noPass) passphrase = await newPassphrase();
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(dir, 0o700);
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const privOpts = { type: 'pkcs8', format: 'pem', ...(passphrase ? { cipher: 'aes-256-cbc', passphrase } : {}) };
    fs.writeFileSync(keyFile, privateKey.export(privOpts), { mode: 0o600 });
    const pub = publicKey.export({ type: 'spki', format: 'pem' });
    fs.writeFileSync(path.join(dir, 'db-signing.pub'), pub);
    console.log(`clave privada: ${keyFile} (${passphrase ? 'protegida con passphrase' : 'SIN passphrase'})`);
    console.log('GUARDA UN RESPALDO de esa clave privada: si se pierde hay que rotar a una nueva.');
    console.log('Clave publica (esta SI se puede compartir):\n' + pub);
  } else if (cmd === 'sign') {
    const [file, key] = args;
    if (!file || !key) die('uso: sign <database.json> <clave-privada> [--passphrase-env VAR]');
    const pem = fs.readFileSync(key);
    // Clave cifrada (PKCS#8 con passphrase): se detecta por la cabecera del PEM,
    // porque el codigo de error de OpenSSL cuando falta la passphrase cambia
    // entre versiones de Node.
    if (!passphrase && pem.toString().includes('ENCRYPTED')) {
      passphrase = await promptHidden('Passphrase de la clave: ');
    }
    let priv;
    try {
      priv = crypto.createPrivateKey({ key: pem, ...(passphrase ? { passphrase } : {}) });
    } catch (e) {
      die(passphrase ? 'passphrase incorrecta' : `no se pudo abrir la clave privada: ${e.message}`);
    }
    const sig = crypto.sign(null, fs.readFileSync(file), priv).toString('base64');
    fs.writeFileSync(`${file}.sig`, sig + '\n');
    console.log(`firma escrita en ${file}.sig`);
  } else if (cmd === 'verify') {
    const [file, pub] = args;
    if (!file || !pub) die('uso: verify <database.json> <clave-publica.pem>');
    const ok = crypto.verify(null, fs.readFileSync(file), crypto.createPublicKey(fs.readFileSync(pub)),
      Buffer.from(fs.readFileSync(`${file}.sig`, 'utf-8').trim(), 'base64'));
    console.log(ok ? 'FIRMA VALIDA' : 'FIRMA INVALIDA');
    process.exit(ok ? 0 : 1);
  } else {
    die('comandos: keygen | sign | verify');
  }
}

main().catch((e) => die(e.message));
