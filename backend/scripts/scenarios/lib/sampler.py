#!/usr/bin/env python3
"""Host-side sampler of the scenario runner (docs/SCENARIOS.md). It runs ON THE HOST UNDER TEST
(python3 standard library only) and takes one sample per second of everything that tells how hard
the machine is working, until it receives SIGTERM/SIGINT or --duration seconds pass:

  - host: CPU % (all cores, from /proc/stat), memory, load average
  - GPU (AMD, through sysfs/debugfs; every field is null where the host does not offer it):
        busy %, VRAM, temperature, power, shader/memory clocks, and whether the video engines are
        powered up (UVD = decode, VCE = encode) -- which tells that the hardware really works
  - per container: CPU (in cores, from the cgroup v2 cpu.stat) and memory
  - kernel events worth knowing about (GPU ring timeouts and resets, VM faults, init aborts of an
    Android...), read from /dev/kmsg

It writes <out> as JSON lines (one object per sample, plus one per kernel event) and, at the end,
<summary> with mean / p95 / max of every numeric series. debugfs and /dev/kmsg need root: without it
those parts are reported as null and the rest still works.

  sampler.py --out s.jsonl --summary s.json [--interval 1] [--duration N] [--containers a,b,c]
"""
import argparse
import glob
import json
import os
import re
import signal
import subprocess
import sys
import time

# Kernel messages that mean "the machine did not like what we asked of it".
KMSG_PATTERNS = re.compile(
    r"ring \w+ timeout|GPU reset|gpu reset|amdgpu.*(VM fault|fault|ERROR|error)|\[drm:.*ERROR|"
    r"init: critical process|InitFatalReboot|binder.*(failed|error)|Out of memory|oom-kill|"
    r"segfault|general protection",
    re.IGNORECASE,
)


def read(path, default=None):
    try:
        with open(path) as f:
            return f.read()
    except OSError:
        return default


def num(text, default=None):
    try:
        return float(text.strip())
    except (AttributeError, ValueError):
        return default


class CpuTotal:
    """System-wide CPU % from the deltas of /proc/stat."""

    def __init__(self):
        self.prev = self.snap()

    @staticmethod
    def snap():
        line = (read('/proc/stat') or 'cpu 0 0 0 0').splitlines()[0].split()[1:]
        vals = [int(x) for x in line]
        idle = vals[3] + (vals[4] if len(vals) > 4 else 0)
        return sum(vals), idle

    def pct(self):
        total, idle = self.snap()
        dt, di = total - self.prev[0], idle - self.prev[1]
        self.prev = (total, idle)
        return round(100.0 * (dt - di) / dt, 1) if dt > 0 else None


def meminfo():
    kv = {}
    for line in (read('/proc/meminfo') or '').splitlines():
        m = re.match(r'(\w+):\s+(\d+)', line)
        if m:
            kv[m.group(1)] = int(m.group(2))
    total, avail = kv.get('MemTotal'), kv.get('MemAvailable')
    if not total or avail is None:
        return None, None
    return round((total - avail) / 1024), round(avail / 1024)


class Gpu:
    """AMD GPU through sysfs (always) and debugfs amdgpu_pm_info (root). Other vendors: all null."""

    def __init__(self):
        self.dev = None
        for card in sorted(glob.glob('/sys/class/drm/card[0-9]*/device')):
            if (read(card + '/vendor') or '').strip() == '0x1002' and os.path.exists(card + '/gpu_busy_percent'):
                self.dev = card
                break
        self.pm = None
        if self.dev:
            slot = os.path.basename(os.path.realpath(self.dev))
            cand = '/sys/kernel/debug/dri/%s/amdgpu_pm_info' % slot
            if read(cand) is not None:
                self.pm = cand

    def sample(self):
        out = {'busy': None, 'vram_mb': None, 'temp_c': None, 'power_w': None,
               'sclk_mhz': None, 'mclk_mhz': None, 'uvd': None, 'vce': None}
        if not self.dev:
            return out
        out['busy'] = num(read(self.dev + '/gpu_busy_percent'))
        vram = num(read(self.dev + '/mem_info_vram_used'))
        out['vram_mb'] = round(vram / 1048576) if vram is not None else None
        if self.pm:
            txt = read(self.pm) or ''
            m = re.search(r'GPU Load:\s*(\d+)', txt)
            if m and out['busy'] is None:
                out['busy'] = float(m.group(1))
            m = re.search(r'GPU Temperature:\s*(\d+)', txt)
            out['temp_c'] = float(m.group(1)) if m else None
            m = re.search(r'([\d.]+)\s*W\s*\((?:current|average)[^)]*\)', txt)
            out['power_w'] = float(m.group(1)) if m else None
            m = re.search(r'(\d+)\s*MHz \(SCLK\)', txt)
            out['sclk_mhz'] = float(m.group(1)) if m else None
            m = re.search(r'(\d+)\s*MHz \(MCLK\)', txt)
            out['mclk_mhz'] = float(m.group(1)) if m else None
            for eng in ('uvd', 'vce'):
                m = re.search(r'%s:\s*(Powered (?:up|down))' % eng.upper(), txt)
                out[eng] = (m.group(1) == 'Powered up') if m else None
        return out


class Container:
    """CPU (cores) and memory of one container from its cgroup v2 scope."""

    def __init__(self, name):
        self.name = name
        self.path = None
        try:
            cid = subprocess.check_output(['docker', 'inspect', '-f', '{{.Id}}', name], text=True,
                                          stderr=subprocess.DEVNULL).strip()
            for cand in ('/sys/fs/cgroup/system.slice/docker-%s.scope' % cid, '/sys/fs/cgroup/docker/%s' % cid):
                if os.path.isdir(cand):
                    self.path = cand
                    break
        except (OSError, subprocess.CalledProcessError):
            pass
        self.prev = self.usage()
        self.prev_t = time.time()

    def usage(self):
        m = re.search(r'usage_usec\s+(\d+)', read(self.path + '/cpu.stat') or '') if self.path else None
        return int(m.group(1)) if m else None

    def sample(self):
        now, use = time.time(), self.usage()
        cores = None
        if use is not None and self.prev is not None and now > self.prev_t:
            cores = round((use - self.prev) / 1e6 / (now - self.prev_t), 3)
        self.prev, self.prev_t = use, now
        mem = num(read(self.path + '/memory.current')) if self.path else None
        return {'cpu_cores': cores, 'mem_mb': round(mem / 1048576) if mem is not None else None}


class Kmsg:
    """New kernel messages that match KMSG_PATTERNS. Needs root; without it, it is silent."""

    def __init__(self):
        self.fd = None
        try:
            self.fd = os.open('/dev/kmsg', os.O_RDONLY | os.O_NONBLOCK)
            os.lseek(self.fd, 0, os.SEEK_END)
        except OSError:
            self.fd = None

    def poll(self):
        events = []
        while self.fd is not None:
            try:
                raw = os.read(self.fd, 8192).decode('utf-8', 'replace')
            except BlockingIOError:
                break
            except OSError:
                break
            msg = raw.split(';', 1)[-1].strip()
            if KMSG_PATTERNS.search(msg):
                events.append(msg[:240])
        return events


def stats(values):
    vals = sorted(v for v in values if isinstance(v, (int, float)))
    if not vals:
        return None
    return {'mean': round(sum(vals) / len(vals), 2), 'p95': vals[min(len(vals) - 1, int(0.95 * len(vals)))],
            'max': vals[-1], 'n': len(vals)}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', required=True)
    ap.add_argument('--summary', required=True)
    ap.add_argument('--interval', type=float, default=1.0)
    ap.add_argument('--duration', type=float, default=0)
    ap.add_argument('--containers', default='')
    a = ap.parse_args()

    stop = {'now': False}
    for sig in (signal.SIGTERM, signal.SIGINT):
        signal.signal(sig, lambda *_: stop.update(now=True))

    cpu, gpu, kmsg = CpuTotal(), Gpu(), Kmsg()
    containers = [Container(n) for n in a.containers.split(',') if n]
    series, kernel_events = [], []
    t0 = time.time()
    with open(a.out, 'w') as out:
        while not stop['now']:
            time.sleep(a.interval)
            now = time.time()
            used, avail = meminfo()
            sample = {
                't': round(now - t0, 2),
                'cpu_pct': cpu.pct(),
                'mem_used_mb': used, 'mem_avail_mb': avail,
                'load1': num((read('/proc/loadavg') or '').split(' ')[0]),
                'gpu': gpu.sample(),
                'containers': {c.name: c.sample() for c in containers},
            }
            series.append(sample)
            out.write(json.dumps(sample) + '\n')
            for msg in kmsg.poll():
                ev = {'t': sample['t'], 'kernel': msg}
                kernel_events.append(ev)
                out.write(json.dumps(ev) + '\n')
            out.flush()
            if a.duration and now - t0 >= a.duration:
                break

    gpu_keys = ['busy', 'vram_mb', 'temp_c', 'power_w', 'sclk_mhz', 'mclk_mhz']
    summary = {
        'samples': len(series),
        'seconds': round(time.time() - t0, 1),
        'cpu_pct': stats([s['cpu_pct'] for s in series]),
        'mem_used_mb': stats([s['mem_used_mb'] for s in series]),
        'load1': stats([s['load1'] for s in series]),
        'gpu': {k: stats([s['gpu'][k] for s in series]) for k in gpu_keys},
        # fraction of the samples in which the engine was powered up: it proves the hardware worked
        'uvd_active_ratio': ratio([s['gpu']['uvd'] for s in series]),
        'vce_active_ratio': ratio([s['gpu']['vce'] for s in series]),
        'containers': {c.name: {
            'cpu_cores': stats([s['containers'][c.name]['cpu_cores'] for s in series]),
            'mem_mb': stats([s['containers'][c.name]['mem_mb'] for s in series]),
        } for c in containers},
        'kernel_events': kernel_events,
        'capabilities': {'gpu': bool(gpu.dev), 'gpu_debugfs': bool(gpu.pm), 'kmsg': kmsg.fd is not None},
    }
    with open(a.summary, 'w') as f:
        json.dump(summary, f, indent=2)


def ratio(flags):
    known = [f for f in flags if f is not None]
    return round(sum(1 for f in known if f) / len(known), 3) if known else None


if __name__ == '__main__':
    main()
