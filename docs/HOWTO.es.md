# Cómo se hace esto — tareas comunes, paso a paso

**Idiomas:** [English](HOWTO.md) | Español

Recetas cortas y orientadas a la tarea, para cosas que alguien preguntó "¿cómo hago esto?". Mismo
espíritu que `TROUBLESHOOTING.md`: esto crece a partir de preguntas reales, no es una lista
especulativa escrita de una sentada — abrí un issue si la tarea que buscás todavía no está acá.

## Abrir una instancia en scrcpy en tu computadora

El botón **📲** de una instancia encendida la abre en la app de escritorio real de
[scrcpy](https://github.com/Genymobile/scrcpy) en la computadora desde la que estás navegando —
ventana nativa, con tu propia configuración de scrcpy. Una página web no puede ejecutar programas por
sí sola, así que hace falta instalar una vez el pequeño **lanzador local** en esa computadora; es el
que atiende los links `scrcpy-redroid://` que usa el botón. Por ahora solo Linux.

1. **Instalá scrcpy y adb** en tu computadora (Debian/Ubuntu:
   `sudo apt install scrcpy adb desktop-file-utils xdg-utils`). `desktop-file-utils` importa: sin él
   algunos navegadores no ven el manejador aunque esté registrado.
2. **Instalá el lanzador**, con tu usuario normal (sin root). redroid-forge sirve su propia copia; el
   diálogo de **Configuración → scrcpy local** muestra estas líneas con la dirección de tu forge ya puesta:

   ```
   mkdir -p ~/redroid-forge-launcher && cd ~/redroid-forge-launcher
   curl -fsSLO http://<tu-forge>/launcher/linux/scrcpy-redroid-launcher \
        -O http://<tu-forge>/launcher/linux/install.sh -O http://<tu-forge>/launcher/linux/config.example
   bash install.sh
   ```

   (Los mismos archivos están en el repositorio, en `launcher/linux/`.)
3. En redroid-forge, andá a **Configuración → scrcpy local**, apretá **▶ Probar scrcpy local** y después **Probar**. La
   primera vez el navegador pregunta si abrir el link con "redroid-forge scrcpy launcher": aceptá, y
   tildá "siempre" si lo ofrece. La prueba es real, no una suposición: el forge abre un dispositivo
   ADB falso y temporal en su host, el lanzador se conecta con tu adb y responde, y recién ahí se
   activa la función.
4. Queda **activado en este navegador** (el botón dice "scrcpy local ● activado") y cada instancia
   encendida muestra **📲**. La preferencia vive en el navegador: se prueba una vez por navegador o
   computadora. Volvé a apretar el mismo botón en Configuración → scrcpy local para desactivarlo, o
   para probar de nuevo si cambiaste algo.

**Tus propias opciones de scrcpy** van en `~/.config/redroid-forge-launcher/config` (lo crea el
instalador): por ejemplo `SCRCPY_ARGS=(--hwdec=disabled)` para forzar decodificación por software, o
`ALLOWED_HOSTS=(...)` para aceptar solo links a tus forges. El lanzador nunca toma opciones de
scrcpy/adb del link — un link solo dice qué `host:puerto` abrir.

**Si la prueba falla:**

- No pasó nada (ni una notificación): el lanzador no está instalado, o el navegador no lo dejó abrir.
  Revisá que `xdg-mime query default x-scheme-handler/scrcpy-redroid` devuelva
  `scrcpy-redroid-launcher.desktop`, y que el navegador no haya recordado un "no abrir nunca".
- Una notificación dice que adb no llegó al host: la computadora no tiene camino de red al host del
  forge en el puerto de prueba (por defecto TCP **15599**, `REDROID_FORGE_LAUNCHER_TEST_PORT`). El
  forge abre ese puerto (y, si tiene acceso a iptables, una regla temporal de firewall) solo mientras
  dura la prueba, y cierra las dos cosas enseguida. Una VPN, un router o un firewall entre vos y el
  host igual pueden bloquearlo — y entonces también bloquearían los puertos ADB de las instancias.
- El lanzador anota todo lo que hace en `~/.cache/redroid-forge-launcher/launcher.log`.

Desinstalar: `bash install.sh --uninstall` (y desactivá la función en el navegador — no puede darse
cuenta sola).

## Escribir en una instancia desde la vista expandida (pantalla completa)

1. Abrí la **vista expandida** de la instancia (pantalla completa, video/audio/input en tiempo
   real).
2. Clickeá el botón **⌨** de la barra inferior — hay que clickearlo una vez antes de que escribir
   con el teclado físico haga algo; aparece un globo de ayuda arriba al pasar el mouse o enfocarlo.
3. Escribí normal con tu teclado físico. Solo llega texto plano al dispositivo.

Para Backspace, Enter o las flechas, tocá directamente el propio teclado en pantalla de Android
(se ve en el video) — ver `TROUBLESHOOTING.md` para el por qué esas no se reenvían desde el
teclado físico.

## Fijar una instancia a cores de CPU específicos (y leer bien el selector)

Abrí el panel **Recursos** de la instancia. La grilla de cores de CPU pone una columna por cada
core *físico* y una fila por cada *hilo* — en un host con SMT/Hyper-Threading (por ejemplo un AMD
5700G), el core lógico `N` y el `N + (total de cores / 2)` son dos hilos del **mismo** core físico
y comparten parte de su circuitería (en la convención de este host, el core `0` se empareja con el
`8`, el `7` con el `15`, y así). La grilla los pone en la misma columna, uno arriba del otro,
justamente para que eso se vea de un vistazo en vez de tener que contarlo.

En la práctica: fijar una instancia a, por ejemplo, los cores `0` y `8` **no** le da el margen de
dos cores independientes — le da los dos hilos de un mismo core físico, que comparten capacidad.
Si querés que dos instancias realmente no compitan por la misma circuitería, elegí cores de
columnas distintas en la grilla, no solo números distintos.
