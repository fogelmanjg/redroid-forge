# Cómo se hace esto — tareas comunes, paso a paso

**Idiomas:** [English](HOWTO.md) | Español

Recetas cortas y orientadas a la tarea, para cosas que alguien preguntó "¿cómo hago esto?". Mismo
espíritu que `TROUBLESHOOTING.md`: esto crece a partir de preguntas reales, no es una lista
especulativa escrita de una sentada — abrí un issue si la tarea que buscás todavía no está acá.

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
