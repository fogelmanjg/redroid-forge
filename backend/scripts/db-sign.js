#!/usr/bin/env node
// Tool for whoever releases the database (docs/KNOWN-COMBINATIONS.md 4.3).
// Dependency-free: it uses Node's native ed25519. This copy lives in
// redroid-forge and is kept identical to the one in tools/ of redroid-forge-db.
//
//   db-sign.js keygen <dir> [--passphrase-env VAR | --no-passphrase]
//       creates <dir>/db-signing.key (0600) and <dir>/db-signing.pub
//   db-sign.js sign   <database.json> <private-key> [--passphrase-env VAR]
//       writes <database.json>.sig
//   db-sign.js verify <database.json> <public-key.pem>
//       verifies <database.json>.sig
//
// Passphrase: by default it is ASKED FOR ON THE TERMINAL with hidden input (the
// person signing types it; nothing sees or stores it). --passphrase-env exists
// to automate/test. The private key must NEVER live on a shared server or in CI
// (see 4.3).
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

// Asks for text on the terminal without echoing it. It fails if there is no TTY.
function promptHidden(question) {
  if (!process.stdin.isTTY) die('there is no interactive terminal to ask for the passphrase: use --passphrase-env VAR');
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl.stdoutMuted = false;
    rl._writeToOutput = (s) => { if (!rl.stdoutMuted) rl.output.write(s); };
    rl.question(question, (answer) => { rl.output.write('\n'); rl.close(); resolve(answer); });
    rl.stdoutMuted = true;
  });
}

async function newPassphrase() {
  const a = await promptHidden(`New passphrase (minimum ${MIN_PASSPHRASE} characters): `);
  if (a.length < MIN_PASSPHRASE) die(`the passphrase must have at least ${MIN_PASSPHRASE} characters`);
  const b = await promptHidden('Repeat it: ');
  if (a !== b) die('the passphrases do not match');
  return a;
}

async function main() {
  const passEnv = flag('--passphrase-env');
  const noPass = bool('--no-passphrase');
  let passphrase = passEnv ? process.env[passEnv] : undefined;
  if (passEnv && !passphrase) die(`the variable ${passEnv} is empty`);

  if (cmd === 'keygen') {
    const dir = args[0] || die('usage: keygen <dir> [--passphrase-env VAR | --no-passphrase]');
    const keyFile = path.join(dir, 'db-signing.key');
    if (fs.existsSync(keyFile)) die(`${keyFile} already exists: it is not overwritten (delete it by hand if you really want another one)`);
    if (!passphrase && !noPass) passphrase = await newPassphrase();
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(dir, 0o700);
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const privOpts = { type: 'pkcs8', format: 'pem', ...(passphrase ? { cipher: 'aes-256-cbc', passphrase } : {}) };
    fs.writeFileSync(keyFile, privateKey.export(privOpts), { mode: 0o600 });
    const pub = publicKey.export({ type: 'spki', format: 'pem' });
    fs.writeFileSync(path.join(dir, 'db-signing.pub'), pub);
    console.log(`private key: ${keyFile} (${passphrase ? 'protected with a passphrase' : 'WITHOUT a passphrase'})`);
    console.log('KEEP A BACKUP of that private key: if it is lost you have to rotate to a new one.');
    console.log('Public key (this one CAN be shared):\n' + pub);
  } else if (cmd === 'sign') {
    const [file, key] = args;
    if (!file || !key) die('usage: sign <database.json> <private-key> [--passphrase-env VAR]');
    const pem = fs.readFileSync(key);
    // Encrypted key (PKCS#8 with a passphrase): detected by the PEM header,
    // because OpenSSL's error code when the passphrase is missing changes
    // between Node versions.
    if (!passphrase && pem.toString().includes('ENCRYPTED')) {
      passphrase = await promptHidden('Key passphrase: ');
    }
    let priv;
    try {
      priv = crypto.createPrivateKey({ key: pem, ...(passphrase ? { passphrase } : {}) });
    } catch (e) {
      die(passphrase ? 'wrong passphrase' : `could not open the private key: ${e.message}`);
    }
    const sig = crypto.sign(null, fs.readFileSync(file), priv).toString('base64');
    fs.writeFileSync(`${file}.sig`, sig + '\n');
    console.log(`signature written to ${file}.sig`);
  } else if (cmd === 'verify') {
    const [file, pub] = args;
    if (!file || !pub) die('usage: verify <database.json> <public-key.pem>');
    const ok = crypto.verify(null, fs.readFileSync(file), crypto.createPublicKey(fs.readFileSync(pub)),
      Buffer.from(fs.readFileSync(`${file}.sig`, 'utf-8').trim(), 'base64'));
    console.log(ok ? 'VALID SIGNATURE' : 'INVALID SIGNATURE');
    process.exit(ok ? 0 : 1);
  } else {
    die('commands: keygen | sign | verify');
  }
}

main().catch((e) => die(e.message));
