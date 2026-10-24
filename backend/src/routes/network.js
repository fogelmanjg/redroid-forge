const express = require('express');
const os = require('os');
const settings = require('../lib/settings');
const { isVisible, isNoisyByDefault } = require('../lib/networkInterfaceFilter');

const router = express.Router();

// Every real (non-link-local) address of every host interface, in Node's own raw shape --
// shared by both routes below, filtered differently by each.
function rawAddresses() {
  const ifaces = os.networkInterfaces();
  const out = [];
  for (const [name, addrs] of Object.entries(ifaces)) {
    for (const a of addrs || []) {
      if (a.family !== 'IPv4' && a.family !== 'IPv6') continue;
      // Link-local IPv6 (fe80::...) is rarely useful to expose a TCP port on and needs a zone
      // index to even dial -- left out to keep the list to addresses worth offering.
      if (a.family === 'IPv6' && a.address.startsWith('fe80:')) continue;
      out.push({ iface: name, address: a.address, family: a.family, internal: !!a.internal });
    }
  }
  return out;
}

// Host network interfaces, for the "Network" sub-section of the instance Configure panel
// (docs/ROADMAP.md Phase 6) -- the user picks which of these an instance's ADB port binds to.
// `network_mode: host` in docker-compose.yml means os.networkInterfaces() here already sees
// the real host's interfaces directly (shared netns), no extra privilege needed. Filtered to
// only the interfaces networkInterfaceFilter.js (+ any admin override in settings) considers
// worth offering -- a host with many containers has a docker0/br-*/veth* for each of them, none
// of which anyone would bind an instance's ADB port to, see that module's own comment.
router.get('/interfaces', (req, res) => {
  const overrides = settings.get().networkInterfaceOverrides;
  res.json(rawAddresses().filter((a) => isVisible(a.iface, overrides)));
});

// The UNFILTERED list, deduped by interface name, each annotated with whether the heuristic
// would show it and whether it currently does (heuristic as possibly overridden) -- what the
// Settings "Network interfaces" panel renders so an admin can correct the heuristic's default,
// not what the per-instance picker above uses.
router.get('/interfaces/all', (req, res) => {
  const overrides = settings.get().networkInterfaceOverrides;
  const byIface = new Map();
  for (const a of rawAddresses()) {
    if (!byIface.has(a.iface)) byIface.set(a.iface, { iface: a.iface, addresses: [], internal: a.internal });
    byIface.get(a.iface).addresses.push(a.address);
  }
  res.json([...byIface.values()].map((entry) => ({
    ...entry,
    heuristicVisible: !isNoisyByDefault(entry.iface),
    visible: isVisible(entry.iface, overrides),
  })));
});

module.exports = router;
