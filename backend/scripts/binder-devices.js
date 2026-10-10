#!/usr/bin/env node
'use strict';

// Prints what a host WITHOUT binderfs (kernel without CONFIG_ANDROID_BINDERFS, e.g. Debian trixie)
// needs to run N Redroid instances at once: the binder_linux module creates the nodes when it loads,
// from its `devices=` parameter, so they have to be declared up front and the module reloaded.
//
//   node backend/scripts/binder-devices.js [slots]      (default 12)
//
// It only PRINTS the configuration and the steps; it changes nothing.
const { legacyDevicesParam } = require('../src/lib/binder');

const slots = process.argv[2] === undefined ? 12 : Number(process.argv[2]);
let devices;
try { devices = legacyDevicesParam(slots); } catch (e) { console.error(e.message); process.exit(2); }

console.log(`# ${slots} slots (0 = /dev/binder without a suffix, then /dev/binder1 ... /dev/binder${slots - 1}).
# Each running instance takes one slot.

# /etc/modprobe.d/zz-redroid-forge-binder.conf
# (the "zz-" makes it load AFTER other files that also set devices=, e.g. Waydroid's: the last one wins)
options binder_linux devices=${devices}

# /etc/modules-load.d/redroid-forge-binder.conf
binder_linux

# The module creates the nodes root-only (0600) and that is NOT enough: Android's servicemanager runs as a
# non-root user inside the container, and with a root-only node the instance dies a few seconds after starting
# (exit 129). Every node, slot 0 included, must be 0666 -- at every boot, e.g. with a oneshot systemd unit that
# runs, after systemd-modules-load.service:
#   /bin/sh -c 'chmod 0666 /dev/binder /dev/hwbinder /dev/vndbinder /dev/binder[0-9]* /dev/hwbinder[0-9]* /dev/vndbinder[0-9]*'
# (not /dev/binder*: that would also match the /dev/binderfs directory)

# Apply it with a REBOOT. The binder driver of the kernel has no unload function, so
# \`modprobe -r binder_linux\` always fails with "Device or resource busy" (even with nothing using it): the
# nodes are created only when the module loads at boot. After rebooting, check as a normal user:
#   cat /sys/module/binder_linux/parameters/devices      # must print the devices= line above
# If Waydroid is installed, stop it before (waydroid session stop): it uses the same binder.

# If Waydroid is installed on this host it uses slot 0 (/dev/binder): keep redroid-forge away from it with
#   REDROID_FORGE_BINDER_RESERVED=0
`);
