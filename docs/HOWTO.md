# How-to — common tasks, step by step

**Languages:** English | [Español](HOWTO.es.md)

Short, task-oriented recipes for things people asked "how do I do this?" about. Same spirit as
`TROUBLESHOOTING.md`: this grows from real questions, not a speculative checklist written in one
sitting — open an issue if the task you're after isn't here yet.

## Open an instance in scrcpy on your computer

The **📲** button on a running instance opens it in the real [scrcpy](https://github.com/Genymobile/scrcpy)
desktop app on the computer you are browsing from — native window, your own scrcpy settings. A web
page cannot start programs by itself, so this needs the small **local launcher** installed once on
that computer; it handles the `scrcpy-redroid://` links the button uses. Linux only for now.

1. **Install scrcpy and adb** on your computer (Debian/Ubuntu:
   `sudo apt install scrcpy adb desktop-file-utils xdg-utils`). `desktop-file-utils` matters: without
   it some browsers do not see the handler even though it is registered.
2. **Install the launcher**, as your normal user (no root). redroid-forge serves its own copy; the
   "Test local scrcpy" dialog shows these lines with your forge's address filled in:

   ```
   mkdir -p ~/redroid-forge-launcher && cd ~/redroid-forge-launcher
   curl -fsSLO http://<your-forge>/launcher/linux/scrcpy-redroid-launcher \
        -O http://<your-forge>/launcher/linux/install.sh -O http://<your-forge>/launcher/linux/config.example
   bash install.sh
   ```

   (The same files are in the repository under `launcher/linux/`.)
3. In redroid-forge, press **▶ Test local scrcpy** (Instances toolbar) and then **Test**. The first
   time, the browser asks whether to open the link with "redroid-forge scrcpy launcher": accept, and
   tick "always" if it offers it. The test is real, not a guess: the forge opens a temporary fake ADB
   device on its host, the launcher connects to it with your adb and answers, and only then is the
   feature turned on.
4. It is now **on in this browser** (the button reads "Local scrcpy ● on") and every running
   instance shows **📲**. The setting lives in the browser: test once per browser/computer. Click the
   toolbar button again to turn it off, or to test again after changing something.

**Your own scrcpy flags** go in `~/.config/redroid-forge-launcher/config` (created by the installer):
e.g. `SCRCPY_ARGS=(--hwdec=disabled)` to force software decode, or `ALLOWED_HOSTS=(...)` to only accept
links to your forges. The launcher never takes scrcpy/adb options from the link itself — a link only
says which `host:port` to open.

**If the test fails:**

- Nothing happened at all (no notification): the launcher is not installed, or the browser was not
  allowed to open it. Check `xdg-mime query default x-scheme-handler/scrcpy-redroid` prints
  `scrcpy-redroid-launcher.desktop`, and that the browser did not remember a "never open" answer.
- A notification says adb could not reach the host: the computer has no network path to the forge
  host on the test port (default TCP **15599**, `REDROID_FORGE_LAUNCHER_TEST_PORT`). The forge opens
  that port (and, when it has iptables access, a temporary firewall rule for it) only while a test
  runs, and closes both right after. A VPN, a router or a firewall between you and the host can still
  block it — and then it would block the instances' ADB ports too.
- The launcher writes everything it does to `~/.cache/redroid-forge-launcher/launcher.log`.

Uninstall: `bash install.sh --uninstall` (and turn the feature off in the browser — it cannot tell by
itself).

## Type into an instance from the expanded viewer (full-screen)

1. Open the instance's **expanded viewer** (full-screen, real-time video/audio/input).
2. Click the **⌨** button in the bottom bar — it has to be clicked once before physical typing
   does anything; a tooltip appears above it on hover/focus as a reminder.
3. Type normally on your physical keyboard. Only plain text reaches the device.

For Backspace, Enter or the arrow keys, tap Android's own on-screen keyboard directly (visible in
the video) instead — see `TROUBLESHOOTING.md` for why those aren't forwarded from the physical
keyboard.

## Pin an instance to specific CPU cores (and read the core picker correctly)

Open the instance's **Resources** panel. The CPU-core grid lays out one column per *physical*
core and one row per *thread* — on a host with SMT/Hyper-Threading (e.g. an AMD 5700G), logical
core `N` and `N + (total cores / 2)` are two threads of the **same** physical core and share part
of its circuitry (on this host's convention, core `0` pairs with `8`, `7` with `15`, and so on).
The grid places them in the same column, one above the other, specifically so that's visible at a
glance instead of something you have to work out by counting.

Practical upshot: pinning an instance to, say, cores `0` and `8` does **not** give it two
independent cores worth of headroom — it gives it both threads of one physical core, which share
capacity. If you want two instances to genuinely not compete for the same silicon, pick cores from
different columns in the grid, not just different numbers.
