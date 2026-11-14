# Our own minimal, LGPL-only FFmpeg build for hwdec.c (libavcodec + VA-API decode) and,
# since 07/11/2026, ffmpeg_encode.c (libavcodec + VA-API encode, h264_vaapi -- see
# docs/ROADMAP.md Phase 2 step 5 and the REDROID_FORGE_ENCODE_BACKEND=ffmpeg path in
# daemon.c). Alpine's own ffmpeg-libavcodec package is built with --enable-gpl (for ITS
# other users, e.g. libx264 support), and FFmpeg's own license terms make the WHOLE library
# GPL once that flag is on, regardless of which decoders/encoders a given program actually
# calls -- linking it would make this image a GPLv3 work, incompatible with Apache-2.0.
# hwdec.c only ever calls plain decode (avcodec_open2/send_packet/receive_frame) on 7 codecs
# via VAAPI hwaccel, and ffmpeg_encode.c only ever calls plain encode (avcodec_send_frame/
# receive_packet) on h264_vaapi -- all of that is genuinely LGPL-only code in FFmpeg's own
# tree, no GPL-licensed component involved at all. Proven by configuring with none of
# avformat/avfilter/avdevice/swscale/swresample/programs and only those 7 decoders + their
# _vaapi hwaccels + the one encoder: FFmpeg's own build system prints "License: LGPL version
# 2.1 or later" for this exact configuration (confirmed 23/10/2026 for decode-only, and again
# 07/11/2026 after adding --enable-encoder=h264_vaapi, same FFmpeg release Alpine ships,
# 8.0.1) -- no API difference from Alpine's package, only the license-affecting configure
# flags differ. This is what finally makes HWDEC a safe default (see below) instead of a
# "development only" opt-in.
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
      --enable-encoder=h264_vaapi \
      --enable-hwaccel=h264_vaapi,hevc_vaapi,vp8_vaapi,vp9_vaapi,mpeg2_vaapi,vc1_vaapi,av1_vaapi \
      --enable-vaapi --enable-shared --disable-static && \
    make -j$(nproc) && make install

# The VA-API daemon's own source (backend/native/vaapi-daemon/ used to vendor a hand-copied
# checkout of redroid-hwenc's tier5-vaapi-daemon -- "a direct port, no logic changes"). That
# meant every real upstream fix/addition needed porting by hand, file by file, and there was no
# clean way to try a newer redroid-hwenc and roll back if it broke something on a GPU this
# project already has working (14/11/2026: this came up concretely over an Intel Haswell/i965
# profile that might regress other GPUs, with no way to test it without committing to it).
# Building directly from a pinned tag instead fixes both: bumping REDROID_HWENC_VERSION (one
# string, overridable per host in that host's own .env, same as every other per-host setting in
# docker-compose.yml) is the entire upgrade, and rolling back is just reverting that one string
# and rebuilding -- no vendored files to hand-maintain or diff against upstream ever again. This
# stage only ever touches redroid-hwenc's own tier5-vaapi-daemon/ directory; nothing else in
# that repo is pulled in.
FROM node:22-alpine AS redroid-hwenc-daemon
RUN apk add --no-cache git build-base libva-dev mesa-dev libdrm-dev vulkan-headers pkgconf
ARG REDROID_HWENC_VERSION=v0.2.0
RUN git clone --depth 1 --branch ${REDROID_HWENC_VERSION} \
      https://github.com/fogelmanjg/redroid-hwenc.git /tmp/redroid-hwenc
COPY --from=ffmpeg-lgpl /opt/ffmpeg-lgpl/lib/*.so* /usr/lib/
COPY --from=ffmpeg-lgpl /opt/ffmpeg-lgpl/include /opt/ffmpeg-lgpl/include
COPY --from=ffmpeg-lgpl /opt/ffmpeg-lgpl/lib/pkgconfig /opt/ffmpeg-lgpl/lib/pkgconfig
ARG HWDEC=1
RUN PKG_CONFIG_PATH=/opt/ffmpeg-lgpl/lib/pkgconfig make -C /tmp/redroid-hwenc/tier5-vaapi-daemon HWDEC=$HWDEC

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
# fwknop/fwknop-server/iptables -> Single Packet Authorization for per-instance ADB/scrcpy
# port-knocking (see backend/src/lib/fwknop.js, docs/ROADMAP.md Phase 9) -- `fwknopd` runs
# as one more supervised child process started by server.js, no separate container
# (14/11/2026: no build-base/libva-dev/mesa-dev here any more -- the daemon is now built
# entirely in the redroid-hwenc-daemon stage above, see backend/native/vaapi-daemon/README.md)
RUN apk add --no-cache iproute2 iw kmod util-linux python3 pciutils docker-cli libva mesa-gbm mesa-egl mesa-va-gallium intel-media-driver fwknop fwknop-server iptables

WORKDIR /app/backend
COPY backend/package.json backend/package-lock.json ./
RUN npm install --omit=dev
COPY backend ./
COPY frontend ../frontend
COPY --from=ffmpeg-lgpl /opt/ffmpeg-lgpl/lib/*.so* /usr/lib/
COPY --from=redroid-hwenc-daemon /tmp/redroid-hwenc/tier5-vaapi-daemon/daemon native/vaapi-daemon/daemon
# Re-declared here (ARGs don't cross FROM boundaries) just to freeze it into an ENV --
# Doctor reads this at runtime to show which redroid-hwenc tag is actually running,
# since a build ARG alone is invisible once the image exists.
ARG REDROID_HWENC_VERSION=v0.2.0
ENV REDROID_FORGE_HWENC_DAEMON_VERSION=$REDROID_HWENC_VERSION

ENV PORT=8080
CMD ["node", "src/server.js"]
