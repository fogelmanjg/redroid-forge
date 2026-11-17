# How-to — common tasks, step by step

**Languages:** English | [Español](HOWTO.es.md)

Short, task-oriented recipes for things people asked "how do I do this?" about. Same spirit as
`TROUBLESHOOTING.md`: this grows from real questions, not a speculative checklist written in one
sitting — open an issue if the task you're after isn't here yet.

## Type into an instance from the "expandida" (full-screen) viewer

1. Open the instance's **"expandida"** viewer (full-screen, real-time video/audio/input).
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
