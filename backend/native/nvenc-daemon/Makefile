# Host-side NVENC encode daemon (redroid-nvidia's Tier 7, SCM_RIGHTS transport) --
# see README.md for the origin and why it is a standalone glibc binary, never built
# into redroid-forge's own (Alpine/musl) backend image: libnvidia-encode.so.1/
# libcuda.so.1/libvulkan.so.1 are proprietary glibc blobs, dlopen()'d at runtime --
# nvencAccel.js only ever CONNECTS to this daemon's socket, it never spawns it (see
# that file's comment). Build and run it directly on the host.
CC ?= gcc
CFLAGS ?= -O2 -Wall
LDLIBS := -lpthread -ldl

nvenc_scm_daemon: nvenc_scm_daemon.c vtest_gpu_encode.c vtest_gpu_encode.h nvenc_scm_protocol.h Makefile
	$(CC) $(CFLAGS) -o nvenc_scm_daemon nvenc_scm_daemon.c vtest_gpu_encode.c $(LDLIBS)

clean:
	rm -f nvenc_scm_daemon

.PHONY: clean
