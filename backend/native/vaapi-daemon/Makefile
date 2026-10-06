# Puerto de tier5-vaapi-daemon (redroid-hwenc): encode VA-API AMD/Intel +
# decode NVDEC/NVIDIA, un solo proceso host-side. Ver README.md de este
# directorio para el origen y por que corre fuera del contenedor de Android.

# -D_FORTIFY_SOURCE=0 (no alcanza con -U): el gcc de Alpine agrega
# _FORTIFY_SOURCE por default via specs (un patron tipo
# "%{!D_FORTIFY_SOURCE:-D_FORTIFY_SOURCE=2}" -- solo mira si YA se paso un
# -D_FORTIFY_SOURCE, un -U no cuenta como "ya especificado" y el spec lo
# inyecta igual), y eso tira wrappers __read_chk/__memcpy_chk/__fprintf_chk
# sobre las funciones de libc -- musl (la libc de Alpine, donde corre esta
# imagen) nunca implemento esos simbolos en su libc.so. El binario linkeaba
# bien pero fallaba en runtime con "no such file or directory" (el
# interprete /lib64/ld-linux... que pide, tampoco existe en Alpine) seguido
# de "symbol not found" al forzar la carga -- confirmado en vivo el 30/09
# corriendo el Doctor de redroid-forge contra una imagen recien buildeada.
CC ?= gcc
CFLAGS ?= -O2 -Wall -D_FORTIFY_SOURCE=0
LDLIBS := -lva -lva-drm -lgbm -lEGL -ldl

# Makefile como prerequisito propio: sin esto, cambiar CFLAGS (ej. el fix de
# _FORTIFY_SOURCE de arriba) no dispara una recompilacion si el binario ya
# existe con timestamp mas nuevo que los .c/.h -- confirmado en vivo el 30/09,
# costo bastante tiempo de debugging encontrar que "make" decia
# "'daemon' is up to date" e ignoraba el fix silenciosamente.
# HWDEC=1 suma el decode por hardware vendor-agnostico (hwdec.c, libavcodec + VA-API).
# Por defecto NO: el build de produccion actual no necesita FFmpeg hasta que exista el
# libavcodec LGPL propio de la imagen (ver docs/ROADMAP.md, Fase 2, paso 5).
HWDEC ?= 0
ifeq ($(HWDEC),1)
HWDEC_CFLAGS := -DHAVE_HWDEC $(shell pkg-config --cflags libavcodec libavutil)
HWDEC_SRCS := hwdec.c
HWDEC_LIBS := $(shell pkg-config --libs libavcodec libavutil) -lpthread
endif

# -I de libdrm (pkg-config): ver el comentario del include de drm_fourcc.h en daemon.c.
LIBDRM_CFLAGS := $(shell pkg-config --cflags libdrm 2>/dev/null)

daemon: daemon.c decode_h264.c decode_h264.h protocol.h hwdec.c hwdec.h Makefile
	$(CC) $(CFLAGS) $(LIBDRM_CFLAGS) $(HWDEC_CFLAGS) -o daemon daemon.c decode_h264.c $(HWDEC_SRCS) $(LDLIBS) $(HWDEC_LIBS)

# Paso 1 del hwdecode (docs/ROADMAP.md, Fase 2, paso 5): sesion de decode por
# hardware con libavcodec + VA-API, y su cliente de prueba. Aparte del target
# `daemon` a proposito: todavia no esta cableado al daemon (eso es el paso 2) y
# necesita las cabeceras de FFmpeg (libavcodec/libavformat/libavutil) y libva.
FFMPEG_PKGS := libavcodec libavformat libavutil
hwdec-test: hwdec.c hwdec.h hwdec-test.c hwdec_client.c hwdec_client.h protocol.h Makefile
	$(CC) -O2 -Wall -o hwdec-test hwdec.c hwdec_client.c hwdec-test.c \
	  $(shell pkg-config --cflags --libs $(FFMPEG_PKGS) libva libva-drm)

clean:
	rm -f daemon hwdec-test

.PHONY: clean
