FROM node:22-alpine

# iproute2 -> ip, iw ; kmod -> modprobe/modinfo ; util-linux -> mountpoint ;
# python3 -> ioctl that creates binderfs devices (see backend/src/lib/binder.js) ;
# pciutils -> lspci, GPU vendor detection (see backend/src/lib/hwAccel.js) ;
# docker-cli -> backend/src/modules/hwenc/integrate.js shells out to `docker cp`/
# `docker exec` (see its own [PENDING] comments: port it to dockerode's
# putArchive() when the module is used in volume mode -- for now, while it is the
# only module with real stage-4 logic, the CLI is enough) ;
# intel-media-driver -> iHD VA-API driver for Intel GPUs (Gen8+ / Iris Xe);
# mesa-va-gallium only covers AMD (radeonsi) and nouveau -- confirmed live on
# 05/10 on n02 (TigerLake): without this vaInitialize fails and the daemon dies ;
# build-base/libva-dev/mesa-dev -> to compile backend/native/vaapi-daemon (only
# build-time, they are not left installed in the final image, see the stage below)
RUN apk add --no-cache iproute2 iw kmod util-linux python3 pciutils docker-cli libva mesa-gbm mesa-egl mesa-va-gallium intel-media-driver

WORKDIR /app/backend
COPY backend/package.json backend/package-lock.json ./
RUN npm install --omit=dev
COPY backend ./
COPY frontend ../frontend

# HWDEC=1 builds the daemon with hardware decode (libavcodec + VA-API; see docs/ROADMAP.md,
# Phase 2, step 5). DEVELOPMENT ONLY: it uses Alpine's FFmpeg, built with --enable-gpl, and
# linking it makes this image a GPLv3 work (incompatible with publishing it as Apache-2.0). The
# distributable image will build its own LGPL libavcodec; meanwhile the default is 0.
ARG HWDEC=0
RUN if [ "$HWDEC" = "1" ]; then apk add --no-cache ffmpeg-libavcodec ffmpeg-libavutil; fi

# drm_fourcc.h: depending on the Alpine version it lives in /usr/include/drm, in /usr/include/libdrm or in both;
# the code and the Makefile (pkg-config libdrm) cover both cases, without symlinks.
RUN apk add --no-cache --virtual .build-deps build-base libva-dev mesa-dev libdrm-dev vulkan-headers pkgconf \
      $( [ "$HWDEC" = "1" ] && echo ffmpeg-dev ) \
  && make -C native/vaapi-daemon HWDEC=$HWDEC \
  && apk del .build-deps

ENV PORT=8080
CMD ["node", "src/server.js"]
