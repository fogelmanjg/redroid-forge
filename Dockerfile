FROM node:22-alpine

# iproute2 -> ip, iw ; kmod -> modprobe/modinfo ; util-linux -> mountpoint ;
# python3 -> ioctl de creacion de dispositivos binderfs (ver backend/src/lib/binder.js) ;
# pciutils -> lspci, deteccion de vendor de GPU (ver backend/src/lib/hwAccel.js) ;
# docker-cli -> backend/src/modules/hwenc/integrate.js shellea a `docker cp`/
# `docker exec` (ver sus propios comentarios [PENDIENTE]: portar a dockerode's
# putArchive() cuando el modulo se use en volumen -- por ahora, mientras es el
# unico modulo con logica de etapa 4 real, el CLI alcanza) ;
# intel-media-driver -> driver VA-API iHD para GPUs Intel (Gen8+ / Iris Xe);
# mesa-va-gallium solo cubre AMD (radeonsi) y nouveau -- confirmado en vivo el
# 05/10 en n02 (TigerLake): sin esto vaInitialize falla y el daemon muere ;
# build-base/libva-dev/mesa-dev -> compilar backend/native/vaapi-daemon (solo
# build-time, no quedan instalados en la imagen final, ver stage de abajo)
RUN apk add --no-cache iproute2 iw kmod util-linux python3 pciutils docker-cli libva mesa-gbm mesa-egl mesa-va-gallium intel-media-driver

WORKDIR /app/backend
COPY backend/package.json backend/package-lock.json ./
RUN npm install --omit=dev
COPY backend ./
COPY frontend ../frontend

# HWDEC=1 compila el daemon con decode por hardware (libavcodec + VA-API; ver docs/ROADMAP.md,
# Fase 2, paso 5). SOLO PARA DESARROLLO: usa el FFmpeg de Alpine, compilado con --enable-gpl, y
# enlazarlo hace de esta imagen una obra GPLv3 (incompatible con publicarla como Apache-2.0). La
# imagen distribuible va a compilar su propio libavcodec LGPL; mientras tanto el default es 0.
ARG HWDEC=0
RUN if [ "$HWDEC" = "1" ]; then apk add --no-cache ffmpeg-libavcodec ffmpeg-libavutil; fi

# drm_fourcc.h: segun la version de Alpine vive en /usr/include/drm, en /usr/include/libdrm o en ambos;
# el codigo y el Makefile (pkg-config libdrm) cubren los dos casos, sin symlinks.
RUN apk add --no-cache --virtual .build-deps build-base libva-dev mesa-dev libdrm-dev vulkan-headers pkgconf \
      $( [ "$HWDEC" = "1" ] && echo ffmpeg-dev ) \
  && make -C native/vaapi-daemon HWDEC=$HWDEC \
  && apk del .build-deps

ENV PORT=8080
CMD ["node", "src/server.js"]
