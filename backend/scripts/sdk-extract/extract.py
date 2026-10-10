#!/usr/bin/env python3
"""Runs INSIDE the container started by ../gapps-extract-sdk.js.

Reads the Google Play x86_64 system image of the Android SDK (the .zip that Google
publishes for the emulator, which the USER already downloaded) and copies a fixed, explicit
list of files out of it into /out, laid out as the gapps module expects, plus a
package.json with the sha256 of every file. It does not download anything.

Why this is not a one-liner: the image's system.img is a GPT disk whose second partition
is an Android "super" (dynamic partitions: LP metadata), and inside it `product` and
`system_ext` are EROFS filesystems. So: unzip -> find the super partition in the GPT ->
read the LP metadata to locate `product` and `system_ext` -> extract them with
fsck.erofs -> pick the files.
"""
import hashlib, json, os, struct, subprocess, sys, shutil

ZIP = "/in/sdk.zip"
OUT = "/out"
WORK = "/work"

# EXACT list (not globs): what the module injects is auditable at a glance. It is the set
# validated on 09/10/2026 (boot, Google sign-in, Play self-update without errors). The
# dialer-support and odad permission files of the image are left out on purpose (they
# reference components that are not injected).
FILES = [
    "product/priv-app/PrebuiltGmsCore/PrebuiltGmsCore.apk",
    "product/priv-app/Phonesky/Phonesky.apk",
    "product/priv-app/PartnerSetupPrebuilt/PartnerSetupPrebuilt.apk",
    "system_ext/priv-app/GoogleServicesFramework/GoogleServicesFramework.apk",
    "product/etc/default-permissions/default-permissions-sdk-google.xml",
    "product/etc/permissions/privapp-permissions-google-p.xml",
    "product/etc/permissions/privapp-permissions-sdk-google.xml",
    "product/etc/permissions/split-permissions-google.xml",
    "product/etc/sysconfig/google_build.xml",
    "product/etc/sysconfig/google-hiddenapi-package-whitelist.xml",
    "product/etc/sysconfig/google-staged-installer-whitelist.xml",
    "product/etc/sysconfig/google.xml",
    "system_ext/etc/permissions/com.google.android.googlesdksetup.xml",
    "system_ext/etc/permissions/privapp-permissions-google-se.xml",
]
PARTITIONS = ["product", "system_ext"]

# The ARM translation (ndk_translation native bridge) that the same image carries in /system: the
# translator and its runtime, one proxy library per system library an ARM app can call, and the ARM
# side of the system (an ARM libc, linker, app_process... that the translated code runs against).
# Command-line support (binfmt_misc registration, the program runner) is left out on purpose: see the
# arm-translation module.
ARM_PROXIES = [
    "aaudio", "amidi", "android", "android_runtime", "binder_ndk", "c", "camera2ndk", "EGL", "GLESv1_CM",
    "GLESv2", "GLESv3", "jnigraphics", "mediandk", "nativehelper", "nativewindow", "neuralnetworks",
    "OpenMAXAL", "OpenSLES", "vulkan", "webviewchromium_plat_support",
]
ARM_FILES = (
    ["system/lib64/libndk_translation.so", "system/lib64/libberberis_exec_region.so",
     "system/bin/arm64/app_process64", "system/bin/arm64/linker64",
     "system/etc/cpuinfo.arm64.txt", "system/etc/ld.config.arm64.txt"]
    + ["system/lib64/libndk_translation_proxy_lib%s.so" % p for p in ARM_PROXIES]
)
# Every file of these folders too (the ARM system libraries: about 60, listed with their hash in package.json).
ARM_DIRS = ["system/lib64/arm64"]
# Files that must be executable once injected.
ARM_EXEC = {"system/bin/arm64/app_process64", "system/bin/arm64/linker64"}

# profile -> what to take out of the image. `src_root` is where the listed paths are looked up inside the
# extracted partitions (the `system` partition of the SDK image holds a /system tree of its own).
PROFILES = {
    "gapps": {"partitions": PARTITIONS, "files": FILES, "src_root": "", "tipo": "gapps",
              "id": "gapps-local", "nombre": "Google Mobile Services (from the Android SDK system image)"},
    "arm-translation": {"partitions": ["system"], "files": ARM_FILES, "dirs": ARM_DIRS, "exec": ARM_EXEC, "src_root": "system", "tipo": "arm-translation",
                        "id": "arm-translation-local",
                        "nombre": "ARM64 translation, ndk_translation (from the Android SDK system image)"},
}
PROFILE = PROFILES[os.environ.get("PROFILE", "gapps")]


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def gpt_partitions(img):
    """(start_byte, size_bytes) of every GPT partition."""
    with open(img, "rb") as f:
        f.seek(512)
        hdr = f.read(92)
        if hdr[:8] != b"EFI PART":
            sys.exit("system.img has no GPT: this is not the expected image")
        entries_lba, n, size = struct.unpack_from("<QII", hdr, 72)
        f.seek(entries_lba * 512)
        out = []
        for _ in range(n):
            e = f.read(size)
            if len(e) < size or e[:16] == b"\0" * 16:
                continue
            first, last = struct.unpack_from("<QQ", e, 32)
            out.append((first * 512, (last - first + 1) * 512))
        return out


def lp_extents(img, base):
    """name -> [(sector_in_super, num_sectors)] from the LP metadata of the super at `base`."""
    with open(img, "rb") as f:
        f.seek(base + 4096)
        if f.read(4) != b"gDla":
            return None
        f.seek(base + 4096 + 4096 + 4096)  # reserved + geometry + backup geometry
        h = f.read(128)
        if struct.unpack_from("<I", h, 0)[0] != 0x414C5030:
            sys.exit("unexpected LP metadata header")
        header_size = struct.unpack_from("<I", h, 8)[0]
        p_off, p_n, p_sz = struct.unpack_from("<III", h, 80)
        e_off, e_n, e_sz = struct.unpack_from("<III", h, 92)
        tables = base + 4096 * 3 + header_size
        parts = {}
        for i in range(p_n):
            f.seek(tables + p_off + i * p_sz)
            raw = f.read(p_sz)
            name = raw[:36].split(b"\0")[0].decode()
            first, count = struct.unpack_from("<II", raw, 40)
            exts = []
            for j in range(first, first + count):
                f.seek(tables + e_off + j * e_sz)
                er = f.read(e_sz)
                sectors, ttype, tdata = struct.unpack_from("<QIQ", er, 0)
                if ttype != 0:
                    sys.exit("only linear extents are supported")
                exts.append((tdata, sectors))
            parts[name] = exts
        return parts


def main():
    os.makedirs(WORK, exist_ok=True)
    print("unzip system.img ...", flush=True)
    subprocess.check_call(["unzip", "-o", "-q", ZIP, "*/system.img", "-d", WORK])
    img = next(os.path.join(r, "system.img") for r, _, fs in os.walk(WORK) if "system.img" in fs)

    super_base, lp = None, None
    for start, _size in gpt_partitions(img):
        lp = lp_extents(img, start)
        if lp:
            super_base = start
            break
    if not lp:
        sys.exit("no super partition (LP metadata) found in system.img")

    root = os.path.join(WORK, "fs")
    os.makedirs(root, exist_ok=True)  # fsck.erofs creates only the last component
    for part in PROFILE["partitions"]:
        if part not in lp:
            sys.exit(f"partition {part} is not in the super")
        raw = os.path.join(WORK, part + ".img")
        with open(img, "rb") as src, open(raw, "wb") as dst:
            for sector, count in lp[part]:
                src.seek(super_base + sector * 512)
                left = count * 512
                while left:
                    chunk = src.read(min(left, 1 << 22))
                    dst.write(chunk)
                    left -= len(chunk)
        print(f"extract {part} (erofs) ...", flush=True)
        subprocess.check_call(["fsck.erofs", f"--extract={os.path.join(root, part)}", raw],
                              stdout=subprocess.DEVNULL)
        os.remove(raw)

    archivos = []
    wanted = list(PROFILE["files"])
    for d in PROFILE.get("dirs", []):
        base = os.path.join(root, PROFILE["src_root"], d)
        if not os.path.isdir(base):
            sys.exit(f"{d} is not in the image: it is not the system image this tool was written for")
        wanted += [d + "/" + n for n in sorted(os.listdir(base)) if os.path.isfile(os.path.join(base, n))]
    for rel in wanted:
        src = os.path.join(root, PROFILE["src_root"], rel)
        if not os.path.isfile(src):
            sys.exit(f"{rel} is not in the image: it is not the system image this tool was written for")
        dst = os.path.join(OUT, rel)
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        shutil.copyfile(src, dst)
        mode = 0o755 if rel in PROFILE.get("exec", ()) else 0o644
        os.chmod(dst, mode)
        archivos.append({"path": rel, "sha256": sha256(dst), "tamano": os.path.getsize(dst), "modo": mode})

    pkg_meta = json.loads(os.environ.get("PKG_META", "{}"))
    pkg = {
        "id": pkg_meta.get("id", PROFILE["id"]),
        "tipo": PROFILE["tipo"],
        "nombre": pkg_meta.get("nombre", PROFILE["nombre"]),
        "version": pkg_meta.get("version", ""),
        "androidVersion": [15],
        "arch": "x86_64",
        "origen": pkg_meta.get("origen", ""),
        "origenSha1": pkg_meta.get("origenSha1", ""),
        "licencia": "Proprietary (Google)",
        "integracion": "sdk-system-image",
        "archivos": archivos,
    }
    with open(os.path.join(OUT, "package.json"), "w") as f:
        json.dump(pkg, f, indent=2)
        f.write("\n")
    # The container runs as root: hand the output back to whoever launched it.
    uid, gid = os.environ.get("HOST_UID"), os.environ.get("HOST_GID")
    if uid and gid:
        for r, dirs, fs in os.walk(OUT):
            for n in dirs + fs:
                os.chown(os.path.join(r, n), int(uid), int(gid))
        os.chown(OUT, int(uid), int(gid))
    shutil.rmtree(WORK, ignore_errors=True)
    print(f"done: {len(archivos)} files", flush=True)


if __name__ == "__main__":
    main()
