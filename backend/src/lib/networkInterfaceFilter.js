'use strict';

// Which host network interfaces are worth offering in the per-instance "Network" picker
// (docs/ROADMAP.md Phase 6/7). A host running many containers has a `docker0`, a `br-<hash>`
// per docker-compose network and a `veth*` per container -- none of those are something anyone
// would bind an instance's ADB port to, and on a busy host they would drown out the handful of
// interfaces (physical NICs, WiFi, VPNs, VM bridges) that actually matter. The heuristic below
// is the zero-config default; `networkInterfaceOverrides` in settings.js lets an admin correct
// it per interface (show one it hid, or hide one it let through) without having to get the
// heuristic itself right for every possible host.
const NOISY_PATTERNS = [
  /^docker\d*$/, // docker0, docker1, ...
  /^br-[0-9a-f]{12}$/, // docker-compose / `docker network create` bridges
  /^docker_gwbridge$/, // Swarm
  /^veth/, // container-side veth peers (visible here too: network_mode: host shares the netns)
  /^cni\d*$/, /^flannel/, /^cali/, /^tunl\d*$/, /^kube-/, // Kubernetes/CNI noise
];

function isNoisyByDefault(ifaceName) {
  return NOISY_PATTERNS.some((re) => re.test(ifaceName));
}

// `overrides`: settings.js's `networkInterfaceOverrides`, {[ifaceName]: boolean}. An explicit
// override always wins; absent, the heuristic decides.
function isVisible(ifaceName, overrides = {}) {
  if (Object.prototype.hasOwnProperty.call(overrides, ifaceName)) return !!overrides[ifaceName];
  return !isNoisyByDefault(ifaceName);
}

module.exports = { isNoisyByDefault, isVisible };
