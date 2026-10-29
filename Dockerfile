# Our own minimal, LGPL-only FFmpeg build for hwdec.c (libavcodec + VA-API decode) --
# see docs/ROADMAP.md Phase 2 step 5. Alpine's own ffmpeg-libavcodec package is built
# with --enable-gpl (for ITS other users, e.g. libx264 support), and FFmpeg's own
# license terms make the WHOLE library GPL once that flag is on, regardless of which
# decoders a given program actually calls -- linking it would make this image a GPLv3
# work, incompatible with Apache-2.0. hwdec.c only ever calls plain decode (avcodec_open2/
# send_packet/receive_frame) on 7 codecs via VAAPI hwaccel -- all of that is genuinely
# LGPL-only code in FFmpeg's own tree, no GPL-licensed component involved at all. Proven
# by configuring with none of avformat/avfilter/avdevice/swscale/swresample/programs and
# only those 7 decoders + their _vaapi hwaccels: FFmpeg's own build system prints "License:
# LGPL version 2.1 or later" for this exact configuration (confirmed 23/10/2026, same
# FFmpeg release Alpine ships, 8.0.1) -- no API difference from Alpine's package, only the
# license-affecting configure flags differ. This is what finally makes HWDEC a safe
# default (see below) instead of a "development only" opt-in.
FROM node:22-alpine AS ffmpeg-lgpl
RUN apk add --no-cache build-base pkgconf libva-dev nasm curl tar xz
ARG FFMPEG_VERSION=8.0.1
RUN curl -sL https://ffmpeg.org/releases/ffmpeg-${FFMPEG_VERSION}.tar.xz | tar xJ && \
    cd ffmpeg-${FFMPEG_VERSION} && \
    ./configure --prefix=/opt/ffmpeg-lgpl \
      --disable-gpl --disable-nonfree --disable-version3 \
      --disable-everything \
      --disable-programs --disable-doc --disable-avdevice --disable-avformat \
      --disable-avfilter --disable-swscale --disable-swresample \
      --enable-avcodec --enable-avutil \
      --enable-decoder=h264,hevc,vp8,vp9,mpeg2video,vc1,av1 \
      --enable-hwaccel=h264_vaapi,hevc_vaapi,vp8_vaapi,vp9_vaapi,mpeg2_vaapi,vc1_vaapi,av1_vaapi \
      --enable-vaapi --enable-shared --disable-static && \
    make -j$(nproc) && make install

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
# build-time, they are not left installed in the final image, see the stage below) ;
# fwknop/fwknop-server/iptables -> Single Packet Authorization for per-instance ADB/scrcpy
# port-knocking (see backend/src/lib/fwknop.js, docs/ROADMAP.md Phase 9) -- `fwknopd` runs
# as one more supervised child process started by server.js, no separate container
RUN apk add --no-cache iproute2 iw kmod util-linux python3 pciutils docker-cli libva mesa-gbm mesa-egl mesa-va-gallium intel-media-driver fwknop fwknop-server iptables

WORKDIR /app/backend
COPY backend/package.json backend/package-lock.json ./
RUN npm install --omit=dev
COPY backend ./
COPY frontend ../frontend

# HWDEC=1 builds the daemon with hardware decode (libavcodec + VA-API; see the
# ffmpeg-lgpl stage above for why this is now safe to be the default -- flip to 0 only
# to skip it outright, e.g. to shrink the image on a build that will never use it).
ARG HWDEC=1
COPY --from=ffmpeg-lgpl /opt/ffmpeg-lgpl/lib/*.so* /usr/lib/
COPY --from=ffmpeg-lgpl /opt/ffmpeg-lgpl/include /opt/ffmpeg-lgpl/include
COPY --from=ffmpeg-lgpl /opt/ffmpeg-lgpl/lib/pkgconfig /opt/ffmpeg-lgpl/lib/pkgconfig

# drm_fourcc.h: depending on the Alpine version it lives in /usr/include/drm, in /usr/include/libdrm or in both;
# the code and the Makefile (pkg-config libdrm) cover both cases, without symlinks.
RUN apk add --no-cache --virtual .build-deps build-base libva-dev mesa-dev libdrm-dev vulkan-headers pkgconf \
  && PKG_CONFIG_PATH=/opt/ffmpeg-lgpl/lib/pkgconfig make -C native/vaapi-daemon HWDEC=$HWDEC \
  && apk del .build-deps \
  && rm -rf /opt/ffmpeg-lgpl/include /opt/ffmpeg-lgpl/lib/pkgconfig

ENV PORT=8080
CMD ["node", "src/server.js"]
