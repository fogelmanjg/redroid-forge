const store = require('./store');

const ADB_PORT_START = parseInt(process.env.ADB_PORT_START || '5555', 10);
const ADB_PORT_END = parseInt(process.env.ADB_PORT_END || '5595', 10);

function nextPort() {
  const used = new Set(store.readAll().map((i) => i.adbPort));
  for (let p = ADB_PORT_START; p <= ADB_PORT_END; p++) {
    if (!used.has(p)) return p;
  }
  throw new Error('No free ADB ports in the configured range');
}

module.exports = { nextPort, ADB_PORT_START, ADB_PORT_END };
