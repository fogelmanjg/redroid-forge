# Troubleshooting — problemas que la gente realmente tuvo

**Idiomas:** [English](TROUBLESHOOTING.md) | Español

Esta página solo cubre problemas que alguien realmente tuvo usando redroid-forge — no es una lista
especulativa de todo lo que podría fallar en teoría. Si te pasa algo que no está acá, abrí un issue
(ver `CONTRIBUTING.md`); una vez entendido, se agrega acá para que la próxima persona no tenga que
debuggearlo de cero.

Ver también [`docs/SCRCPY-TIPS.md`](SCRCPY-TIPS.es.md) para problemas específicos de conectar con
el cliente `scrcpy` real desde una terminal (audio, códec de video, bitrate) — esta página es sobre
la app en sí (instancias, el visor web integrado, recursos).

| Síntoma | Por qué | Solución |
|---|---|---|
| Una instancia informa muchísima más RAM que su límite asignado (por ejemplo `dumpsys meminfo` o `/proc/meminfo` adentro de la instancia muestra toda la RAM del host, no el límite real) | Android solo ve el límite real del cgroup gracias a un workaround (ver el comentario propio de `meminfoFix.js`): el propio init de Android monta un `/proc/meminfo` falso al bootear, disparado por un archivo `.rc`. Encontrado en vivo (17/11/2026): si el permiso de ese `.rc` en disco se degrada a escritura de grupo/otros, el init de Android lo rechaza en silencio ("insecure file") y el bind nunca pasa — la instancia sigue informando toda la RAM del host aunque el límite del cgroup sí se esté aplicando por debajo. | Arreglado de forma defensiva desde el build en la rama hacia `1.0.0` posterior al 17/11/2026 (la copia siempre fuerza el permiso correcto, sin depender del archivo fuente en disco). Una instancia **creada o recreada antes de ese fix** puede seguir con una copia rota — un simple restart **no** lo vuelve a aplicar (el `.rc` solo se (re)instala al crear/recrear, ver el comentario arriba de `installRcTrigger` en `meminfoFix.js`); recrear la instancia sí. |
| En el visor "expandida" (pantalla completa), escribir con el teclado físico no hace nada — solo responde tocar el teclado en pantalla de Android | Es así a propósito, no es un bug: el campo de texto oculto que captura el tipeo físico solo se enfoca si clickeás primero el botón **⌨** (pasale el mouse o enfocalo para ver un recordatorio). Aun así, solo se manda el texto plano ya confirmado — Backspace, Enter, Tab y las flechas nunca se mandan (sin IME/composición propia, ver las decisiones de diseño de "expandida" en `ROADMAP.md` Fase 11). | Clickeá **⌨** antes de escribir. Para Backspace/Enter/flechas, usá el propio teclado en pantalla de Android (se ve en el video, tocalo directo) — todavía no hay reenvío de esas teclas específicas. |
| Usando una app de scrcpy de terceros en Android (ej. `ScrcpyForAndroid`/miuzarte) desde un celular o tablet para mirar una instancia de redroid-forge: pantalla negra al conectar, o la app se cierra sola al desconectar | Bugs conocidos del decoder de esa app de terceros específica al hablar con una instancia de redroid (rastreados hasta su propio código fuente — ver las notas internas del proyecto); no es algo que redroid-forge controle o pueda arreglar desde este lado. | Usar el visor web integrado **"expandida"** desde el propio navegador de la tablet en vez de esa app (mismo dispositivo, sin apps extra, sin los bugs de decoder de ese APK en particular). |
