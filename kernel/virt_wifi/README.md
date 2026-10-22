# virt_wifi (patched): a real wiphy per link, movable to a netns

Supporting kernel-side work for a planned module of redroid-forge ("wifi-interno" -- chosen over
"fake-wifi"/"wifi-falso", same idea but without the negative framing): giving each instance a real,
per-instance WiFi-looking network device, backed by the instance's own real connectivity (its existing
Docker networking), not a second, separately-simulated network.

`virt_wifi.c` here is `drivers/net/wireless/virtual/virt_wifi.c` (upstream, GPL-2.0, Copyright Google --
see the file's own header), patched. It is **not** redroid-forge's own code; this folder exists so the
patch survives (a scratch file in `/tmp` on a lab host does not), with the reasoning for every change kept
inline as comments in the file itself.

## What upstream `virt_wifi` is

A driver that wraps a real ethernet net_device (`ip link add link eth0 name wlan0 type virt_wifi`) and
makes it look like a WiFi device to userspace (`wificond`, `iw`, Android's own WiFi framework) -- real
traffic keeps flowing through the wrapped device, nothing about the network path changes; only cfg80211
gets told "this is wireless". It is what Cuttlefish/the Android Emulator itself is built on (there, via the
related `virt_wifi` + emulator userspace, not Android's real supplicant/HAL stack).

## Why it needed patching

Upstream `virt_wifi` uses **one wiphy for the whole host** (`common_wiphy`, created once at module load),
shared by every link. That cannot be moved into a container's network namespace
(`cfg80211_switch_netns()` needs `WIPHY_FLAG_NETNS_OK` + `wiphy_net_set()` on a wiphy that is not shared) --
which is exactly what redroid-forge needs: each instance has to get its **own** wiphy, created when its
link is created, movable into its own netns.

## History -- why this was closed once, and why it was reopened

An earlier attempt (building this same idea on `jg-dashboard`, a different, older project) hit a real
incident: a first patch attempt called `wiphy_register()` from inside the kernel's `rtnl_newlink_create()`
path -- which already holds the RTNL mutex -- and `wiphy_register()` takes that same mutex internally.
Self-deadlock. Because `rtnl_lock` is a single, global, host-wide mutex used by nearly everything network-
related (Docker, Tailscale, SSH, `sudo` on some paths), the hang took down the entire physical host, not
just the test container. That closed the whole `virt_wifi`-patching idea "for good" -- until revisited
here, this time **only ever tested inside a disposable VM** (never on a host anything else depends on), on
the user's own explicit call to re-open it.

## The two real bugs found this time, and the actual fixes

Both were found and confirmed by directly testing against a disposable VM (never the real host), using the
QEMU guest agent as the diagnostic channel of last resort (it runs over a virtio-serial channel, not the
VM's own network -- survives exactly the kind of hang this was chasing).

**1. The original self-deadlock, confirmed real again.** `wiphy_register()`/`wiphy_unregister()` take
`rtnl_lock()` internally; `newlink()`/`dellink()` are invoked by the kernel *with* that lock already held.
Deferring the register/unregister calls to a workqueue avoids the self-deadlock, but breaks a *different*
invariant: `register_netdevice()` fires cfg80211's `NETDEV_REGISTER` notifier, which expects the wiphy to
already be registered (its sysfs device already added) at that exact moment -- confirmed for real via a
dmesg warning, `cfg80211: failed to add phy80211 symlink to netdev!`, the one time this was tried deferred.

**Fix:** inside `newlink()`, release `rtnl` right before calling `wiphy_register()`, and re-acquire it right
after -- synchronously, in the same function, in the correct order (wiphy registered *before*
`register_netdevice()`). The same pattern exists in other real kernel drivers for exactly this situation.

**2. A second, separate hang -- harder to find.** Copying the exact same unlock/relock pattern into
`virt_wifi_net_device_destructor()` (which tears the link's own wiphy down) reliably hung the *entire*
guest shortly after creating-and-then-deleting a link -- any new `ip` command would block forever waiting
on `rtnl`, with no process visibly holding it in a full kernel task dump (`sysrq` show-state). Ruled out:
IPv6 (disabling it entirely made no difference).

Root cause, confirmed by reading `net/core/dev.c` and by tracing `rtnl_lock`/`rtnl_unlock`/`__rtnl_unlock`
with `ftrace` across a full create+delete cycle: `netdev_run_todo()` calls `__rtnl_unlock()` **early**
(right after snapshotting its to-do list) and only invokes each device's `priv_destructor` **much later**
(after an `rcu_barrier()` and a wait-for-refs loop) -- `rtnl` is already free by the time the destructor
runs, on purpose, specifically so a destructor can take it itself if it needs to. Calling `rtnl_unlock()` on
entry (as the newlink/dellink pattern does, correctly, since *they* run with the lock held) unlocks an
already-unlocked mutex -- undefined behaviour, and in practice corrupts it enough that the very next
`rtnl_lock()` call (meant to "restore" it afterwards) never returns. The ftrace capture showed this
directly: the last line of the entire trace was `rtnl_lock <-virt_wifi_net_device_destructor`, with no
matching unlock ever following.

**Fix:** no lock dance at all in the destructor -- call `wiphy_unregister()`/`wiphy_free()` directly. `rtnl`
is already free there; wrapping it in an extra unlock/lock was the bug.

## Validation

On a disposable Ubuntu 24.04 VM (kernel `6.8.0-147-generic`, built with the matching
`linux-headers-generic`), accessed via the QEMU guest agent so the test survives even if the VM's own
network hangs:

- Create a link (`ip link add link enp1s0 name wlan0 type virt_wifi`): clean, no warnings in `dmesg`, `iw
  dev` sees a real, correctly registered wiphy.
- Delete it: clean, instant.
- A stress pass (create 5, delete 5 in a row against the same lower device): no hang. 4 of the 5 creations
  correctly fail with "Device or resource busy" -- the driver only supports one `virt_wifi` wrapper per
  lower device, by design, not a bug.
- After all of the above: real SSH into the VM still works, load average normal, no command left stuck on
  `rtnl`.

## What is still open

This only proves the kernel-side piece (a real, per-instance, netns-movable wiphy) is sound. Still to design
for the actual redroid-forge module:

- Building this against the *real* kernel of the host it will run on (this was only validated inside a
  disposable VM's own generic kernel), and only ever testing a modified version of it the same way again --
  **never** load a patched kernel module like this directly on a host anything else depends on.
- How the per-instance link gets its real connectivity: this driver wraps a real ethernet device and passes
  its traffic through unchanged -- there is no real 802.11 association happening between virt_wifi radios,
  so "can instances see each other over WiFi" is actually a question of Docker network isolation (a
  dedicated bridge network, `inter-container communication` on/off), not of anything WiFi-specific.
- Whether `mac80211_hwsim` (already used by redroid-forge's own `hwsimWifi.js`/`jg-dashboard`'s wifi-falso
  for an unrelated reason -- giving `wificond` a real wiphy to accept creating an STA interface at all,
  without any real traffic passing over hwsim's simulated radios) and this `virt_wifi` path end up
  coexisting, replacing each other, or solving genuinely different parts of the problem.
