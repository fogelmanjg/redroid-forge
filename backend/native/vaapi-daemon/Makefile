# Puerto de tier5-vaapi-daemon (redroid-hwenc): encode VA-API AMD/Intel +
# decode NVDEC/NVIDIA, un solo proceso host-side. Ver README.md de este
# directorio para el origen y por que corre fuera del contenedor de Android.

CC ?= gcc
CFLAGS ?= -O2 -Wall
LDLIBS := -lva -lva-drm -lgbm -lEGL -ldl

daemon: daemon.c decode_h264.c decode_h264.h protocol.h
	$(CC) $(CFLAGS) -o daemon daemon.c decode_h264.c $(LDLIBS)

clean:
	rm -f daemon

.PHONY: clean
