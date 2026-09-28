# vaapi-daemon

Puerto directo del daemon de [`redroid-hwenc`](https://github.com/fogelmanjg/redroid-hwenc)
(tier5-vaapi-daemon), sin cambios de lógica — mismo binario, mismo protocolo. Ver el README
de ese proyecto para el diseño completo (por qué un daemon host-side en vez de VA-API nativo
dentro de Android, el protocolo del socket, y la tabla de compatibilidad por GPU).

Encode H.264 vía VA-API en AMD/Intel (`VAEntrypointEncSlice`) y decode H.264 vía NVDEC en
NVIDIA (`VAEntrypointVLD`, driver `nvidia-vaapi-driver`) — un solo proceso, dos backends
independientes, ninguno requerido para que el otro funcione.

## Build

```sh
make
```

Requiere headers de desarrollo de `libva`, `libva-drm`, `libgbm` y `libEGL` (ver Dockerfile
del backend para los paquetes exactos en la imagen de producción).

## Quién lo levanta

No se corre a mano — `backend/src/lib/hwAccel.js` lo lanza y supervisa como proceso hijo del
backend de redroid-forge (que corre `--privileged --pid=host --network=host`, ver
`docker-compose.yml`), y expone su socket (`/dev/vaapi-helper/socket`) bind-mounteado tanto
en el propio contenedor del backend como en cada instancia redroid que lo necesite — mismo
patrón que `binder.js` con `/dev/binderfs`.
