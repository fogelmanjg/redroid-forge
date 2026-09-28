FROM node:22-alpine

# iproute2 -> ip, iw ; kmod -> modprobe/modinfo ; util-linux -> mountpoint ;
# python3 -> ioctl de creacion de dispositivos binderfs (ver backend/src/lib/binder.js) ;
# pciutils -> lspci, deteccion de vendor de GPU (ver backend/src/lib/hwAccel.js) ;
# build-base/libva-dev/mesa-dev -> compilar backend/native/vaapi-daemon (solo
# build-time, no quedan instalados en la imagen final, ver stage de abajo)
RUN apk add --no-cache iproute2 iw kmod util-linux python3 pciutils libva mesa-gbm mesa-egl mesa-va-gallium

WORKDIR /app/backend
COPY backend/package.json backend/package-lock.json ./
RUN npm install --omit=dev
COPY backend ./
COPY frontend ../frontend

# drm_fourcc.h vive en /usr/include/libdrm en Alpine, pero daemon.c lo incluye
# como <drm/drm_fourcc.h> (convencion Debian/Ubuntu, donde se probo el daemon
# originalmente) -- el symlink evita tocar el codigo portado.
RUN apk add --no-cache --virtual .build-deps build-base libva-dev mesa-dev libdrm-dev vulkan-headers \
  && ln -s /usr/include/libdrm /usr/include/drm \
  && make -C native/vaapi-daemon \
  && rm /usr/include/drm \
  && apk del .build-deps

ENV PORT=8080
CMD ["node", "src/server.js"]
