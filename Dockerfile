FROM node:22-alpine

# iproute2 -> ip, iw ; kmod -> modprobe/modinfo ; util-linux -> mountpoint ;
# python3 -> ioctl de creacion de dispositivos binderfs (ver backend/src/lib/binder.js)
RUN apk add --no-cache iproute2 iw kmod util-linux python3

WORKDIR /app/backend
COPY backend/package.json backend/package-lock.json ./
RUN npm install --omit=dev
COPY backend ./
COPY frontend ../frontend

ENV PORT=8080
CMD ["node", "src/server.js"]
