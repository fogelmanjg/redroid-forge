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
daemon: daemon.c decode_h264.c decode_h264.h protocol.h Makefile
	$(CC) $(CFLAGS) -o daemon daemon.c decode_h264.c $(LDLIBS)

clean:
	rm -f daemon

.PHONY: clean
