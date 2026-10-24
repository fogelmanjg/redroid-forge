const express = require('express');
const os = require('os');

const router = express.Router();

// Host network interfaces, for the "Network" sub-section of the instance Configure panel
// (docs/ROADMAP.md Phase 6) -- the user picks which of these an instance's ADB port binds to.
// `network_mode: host` in docker-compose.yml means os.networkInterfaces() here already sees
// the real host's interfaces directly (shared netns), no extra privilege needed.
router.get('/interfaces', (req, res) => {
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
  res.json(out);
});

module.exports = router;
