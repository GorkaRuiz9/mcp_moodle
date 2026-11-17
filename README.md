# moodle-mcp

Servidor [MCP](https://modelcontextprotocol.io) para Moodle, pensado para estudiantes. Conecta tu asistente de IA (Claude Code, Claude Desktop, Cursor, Codex, Gemini CLI…) con tu cuenta de Moodle para que pueda consultar tus asignaturas, apuntes, entregas, plazos, calendario, notas, cuestionarios, foros, notificaciones y mensajes.

Viene configurado por defecto para **ALUD**, el Moodle de la Universidad de Deusto, pero funciona con cualquier Moodle que tenga activado el servicio de la app móvil.

- **Solo lee por defecto.** Tal como se instala no puede entregar tareas, escribir en foros ni cambiar nada en Moodle. Las herramientas que escriben son opcionales: hay que [activarlas a propósito](#herramientas-que-escriben-opcional) y, aun activadas, cada cambio te pide confirmación.
- **Corre en tu ordenador.** Tu token se guarda en tu equipo y solo se envía a tu Moodle.
- **Ve lo mismo que tú.** Usa la API oficial de Moodle (la de la app móvil) con tu propia cuenta.

## Requisitos

- Node.js 20 o superior.

## Instalación

```bash
git clone <url-de-este-repositorio> moodle-mcp
cd moodle-mcp
npm install
npm run build
```

## Iniciar sesión

```bash
node dist/cli.js login
```

El comando te da una dirección y estos pasos:

1. Abre una ventana **privada** (incógnito) del navegador. No debe tener ya la sesión de Moodle iniciada.
2. Abre las herramientas de desarrollador (F12), pestaña **Red / Network**, y marca **Conservar registro / Preserve log**.
3. Pega la dirección que te da el comando e inicia sesión como siempre (en ALUD, con tu cuenta de Google de Deusto).
4. Al terminar, la página se queda en blanco o da error. Es lo esperado: Moodle ha intentado abrir una dirección que empieza por `moodlemobile://token=`. Cópiala entera:
   - **Firefox:** aparece en la barra de direcciones o en la página de error.
   - **Chrome / Edge:** en la pestaña Red, pulsa la última petición `launch.php` y copia la cabecera de respuesta `Location`.
5. Pégala en la terminal.

El token se guarda en `~/.config/moodle-mcp/config.json`, legible solo por tu usuario. Suele durar unas semanas; cuando caduque, las herramientas te pedirán que repitas el `login`.

Otros comandos:

| Comando | Qué hace |
| --- | --- |
| `node dist/cli.js status` | Muestra con qué usuario y en qué sitio estás conectado. |
| `node dist/cli.js logout` | Borra el token guardado. |
| `node dist/cli.js login --url https://moodle.otra-uni.es` | Inicia sesión en otro Moodle. |
| `node dist/cli.js login --token <token>` | Guarda un token que ya tienes. |

## Conectarlo a tu asistente

El servidor se arranca con `node /ruta/a/moodle-mcp/dist/cli.js` y habla MCP por stdio. Usa la ruta absoluta a tu copia.

**Claude Code**

```bash
claude mcp add moodle -- node /ruta/a/moodle-mcp/dist/cli.js
```

**Claude Desktop, Cursor y la mayoría de clientes** (fichero de configuración de servidores MCP):

```json
{
  "mcpServers": {
    "moodle": {
      "command": "node",
      "args": ["/ruta/a/moodle-mcp/dist/cli.js"]
    }
  }
}
```

Si prefieres no guardar el token en disco, pásalo por variables de entorno. Tienen prioridad sobre el fichero de configuración:

| Variable | Para qué |
| --- | --- |
| `MOODLE_URL` | Dirección del Moodle. Por defecto, `https://alud.deusto.es`. |
| `MOODLE_TOKEN` | Token del servicio web. |
| `MOODLE_MCP_WRITE` | Grupos de herramientas que pueden escribir en Moodle. Sin definir, solo lectura. Ver [Herramientas que escriben](#herramientas-que-escriben-opcional). |

## Herramientas

Estas 16 son de solo lectura y están siempre disponibles:

| Herramienta | Qué devuelve |
| --- | --- |
| `list_courses` | Tus asignaturas, con su identificador. |
| `get_course_contents` | Secciones, recursos y actividades de una asignatura, con los enlaces de los ficheros. |
| `get_recent_changes` | Lo que se ha subido o cambiado en tus asignaturas desde una fecha (por defecto, los últimos 7 días): ficheros, actividades, mensajes de foro, notas. |
| `list_assignments` | Tareas con su plazo, el estado de tu entrega y la nota. |
| `get_upcoming_deadlines` | Lo que vence en los próximos días en todas tus asignaturas. |
| `get_calendar_events` | Todo el calendario de un periodo: exámenes, clases, eventos personales y fechas de actividades. |
| `get_grades` | Tu nota total por asignatura, o el desglose de una. |
| `list_quizzes` | Cuestionarios con sus fechas, intentos permitidos, y tus intentos con su nota. |
| `get_quiz_attempt` | La revisión de un intento tuyo ya terminado: preguntas, lo que contestaste, si acertaste y la respuesta correcta, hasta donde el profesor lo permita. |
| `list_forum_discussions` | Foros y avisos de una asignatura. |
| `get_discussion` | Todos los mensajes de un debate. |
| `get_notifications` | Tus notificaciones (la campana de Moodle). No las marca como leídas. |
| `get_messages` | Tus conversaciones privadas y sus mensajes. No las marca como leídas. |
| `get_course_participants` | Profesores (con su correo), compañeros (solo el nombre) y grupos de una asignatura. |
| `get_file` | Descarga un fichero a una carpeta local. De los PDF y ficheros de texto devuelve además el texto. |
| `search_courses_content` | Busca por título, descripción o nombre de fichero en tus asignaturas. |

Ejemplos de lo que puedes pedirle a tu asistente:

- «¿Qué tengo que entregar esta semana?»
- «¿Qué han subido nuevo desde el lunes?»
- «Resúmeme el PDF del tema 3 de Cálculo.»
- «¿Tengo algún examen en el calendario este mes?»
- «Repasa conmigo los fallos de mi último test de Programación.»
- «¿Quién da Cálculo y cuál es su correo?»
- «¿Qué nota llevo en cada asignatura?»

## Herramientas que escriben (opcional)

Tal como se instala, el servidor no puede cambiar nada. Si quieres que tu asistente también pueda hacer cosas en Moodle, tienes que activarlo tú, por grupos, con la variable de entorno `MOODLE_MCP_WRITE`. Sin esa variable, estas herramientas ni siquiera aparecen.

| Grupo | Herramientas | Qué permite |
| --- | --- | --- |
| `calendario` | `create_calendar_event`, `delete_calendar_event` | Crear eventos personales en tu calendario y borrar los tuyos. No toca eventos de curso. |
| `seguimiento` | `set_activity_completion` | Marcar o desmarcar una actividad como completada, solo en las que se marcan a mano. |
| `notificaciones` | `mark_notifications_read` | Marcar notificaciones como leídas. |
| `foros` | `add_forum_discussion`, `reply_to_forum_post` | Abrir un hilo o responder en un foro, con tu nombre. Solo texto, sin adjuntos. |
| `entregas` | `save_assignment_submission` | Subir ficheros o texto a tu entrega de una tarea. |

### Cómo activarlas

Pon en `MOODLE_MCP_WRITE` los grupos que quieras, separados por comas (`todo` los activa todos). Un nombre mal escrito hace que el servidor no arranque, para que no te quedes sin herramientas sin saber por qué.

**Claude Code**

```bash
claude mcp add moodle --env MOODLE_MCP_WRITE=calendario,entregas -- node /ruta/a/moodle-mcp/dist/cli.js
```

**Claude Desktop, Cursor y la mayoría de clientes**

```json
{
  "mcpServers": {
    "moodle": {
      "command": "node",
      "args": ["/ruta/a/moodle-mcp/dist/cli.js"],
      "env": { "MOODLE_MCP_WRITE": "calendario,entregas" }
    }
  }
}
```

Después reinicia el cliente (o reconecta el servidor) para que cargue las herramientas nuevas. Para volver a solo lectura, quita la variable.

### Cada cambio te pide permiso

Activar un grupo solo hace visibles sus herramientas; no aprueba nada. Cada vez que el asistente usa una, el servidor te enseña una ventana de confirmación con lo que va a enviar exactamente y no hace nada hasta que marcas «Confirmo esta acción» y aceptas. Por ejemplo:

```text
Vas a guardar una entrega en una tarea de Moodle.

Curso: Computación Cloud
Tarea: Entrega para evaluación
Fecha límite: mar 17/11/2026 23:59

Efecto: ESTA TAREA NO TIENE FASE DE BORRADOR. Al guardar, ESTO CUENTA COMO ENTREGA y tu profesor ya puede verla y calificarla.
Podrás modificarla hasta el mar 17/11/2026 23:59.

Ficheros que se suben desde tu ordenador (1):
  + /home/yo/practica/memoria.pdf (1.2 MB)
Ficheros que ya estaban y se conservan (1):
  = /codigo.zip (340.0 KB)
```

- La confirmación se repite en cada llamada. No hay «no volver a preguntar».
- La ventana la muestra tu cliente, no el modelo: el asistente no puede aprobarse a sí mismo.
- Si la rechazas, la cierras o no marcas la casilla, no se envía nada.
- Usa el mecanismo *elicitation* de MCP. Si tu cliente no lo soporta, las herramientas de escritura responden con un error y no cambian nada; no hay otra vía. Las pruebas automáticas ejercitan el diálogo con el cliente del SDK oficial de MCP. Claude Code lo [documenta como soportado](https://code.claude.com/docs/en/mcp); en otros clientes, consulta su documentación.
- La confirmación es tan fiable como tu cliente. Si configuras en él algo que responda a estos diálogos automáticamente (por ejemplo, un *hook* de elicitation en Claude Code), estarás aprobando sin mirar.

### Lo que hacen las entregas, con detalle

- **Tareas con borrador** (el profesor exige pulsar «Entregar tarea»): la herramienta solo guarda el borrador. Entregar lo haces tú en la web de Moodle.
- **Tareas sin borrador** (lo habitual en muchos Moodle): guardar ya es entregar. La confirmación lo dice en mayúsculas y te indica hasta cuándo podrás modificarla.
- Los ficheros que ya tenías subidos se conservan. Uno nuevo sustituye al que tenga el mismo nombre. Solo se vacía la entrega si el asistente lo pide expresamente, y la confirmación lista qué ficheros se eliminan.
- Se niega a tocar una tarea ya entregada para calificar, ya calificada, cerrada o bloqueada, y las que exigen aceptar una declaración de autoría al guardar.
- Comprueba antes de preguntarte el número máximo de ficheros, el tamaño y, cuando la tarea lista extensiones concretas, el tipo.
- En las entregas en grupo avisa de que el cambio afecta a todo tu grupo.

### Lo que no hará nunca

- Empezar o contestar cuestionarios, lecciones o encuestas evaluables. Tampoco lee las preguntas de un intento en curso.
- Pulsar el «Entregar tarea» definitivo de una tarea con borrador.
- Enviar mensajes privados.
- Editar o borrar lo que no es tuyo: eventos de curso, mensajes de otros.

## Límites conocidos

- `get_file` extrae texto de PDF y ficheros de texto. PowerPoint, Word e imágenes solo se descargan.
- Los PDF escaneados (sin capa de texto) no se pueden leer.
- `search_courses_content` no busca dentro de los ficheros, solo en títulos, descripciones y nombres.
- `get_quiz_attempt` solo funciona si el profesor ha abierto la revisión del cuestionario; muchos no la abren hasta que se cierra, o nunca.
- `get_messages` no funciona en los Moodle que tienen la mensajería desactivada (ALUD es uno de ellos); la herramienta lo dice.
- `get_recent_changes` muestra lo que Moodle registra como cambiado. No distingue una actividad nueva de una a la que el profesor solo le ha retocado la descripción.
- Los ficheros descargados se guardan en `~/.cache/moodle-mcp/files/` y no se borran solos.

## Desarrollo

```bash
npm test          # tests con respuestas simuladas; no necesitan credenciales
npm run typecheck
npm run build
```

El código está en [src/](src/):

- [moodle.ts](src/moodle.ts): el cliente de la API (llamadas, descargas y subidas).
- [tools.ts](src/tools.ts), [files.ts](src/files.ts), [news.ts](src/news.ts), [quiz.ts](src/quiz.ts), [calendar.ts](src/calendar.ts) y [people.ts](src/people.ts): las herramientas de lectura.
- [writes.ts](src/writes.ts): las herramientas que escriben. Todas siguen el mismo orden: leer, negarse a lo que no se permite, pedir confirmación y solo entonces escribir.
- [confirm.ts](src/confirm.ts): los grupos de `MOODLE_MCP_WRITE` y el contrato de la confirmación.
- [server.ts](src/server.ts): el registro en MCP y el diálogo de confirmación.
- [login.ts](src/login.ts): el inicio de sesión.

### Pruebas contra un Moodle de verdad

Las herramientas que escriben **no se prueban nunca contra un Moodle real**: una prueba fallida acabaría en un foro que leen tus profesores o en una entrega de verdad. Para eso hay un Moodle local desechable en Docker, con un curso de pruebas, un profesor y dos estudiantes:

```bash
npm run test:e2e        # arranca el Moodle local si hace falta, recarga los datos y lanza las pruebas
tests/e2e/down.sh       # lo para y borra todo lo que guardó
```

Necesita Docker. La primera vez descarga e instala Moodle 4.5 y tarda unos minutos; después, unos segundos. El Moodle queda en `http://localhost:8099` por si quieres entrar a mirar (`student1` / `Student.1234`, `teacher1` / `Teacher.1234`, `admin` / `Admin.1234`). Las pruebas se niegan a ejecutarse contra cualquier dirección que no sea local.

Qué hay en [tests/e2e/](tests/e2e/): [docker-compose.yml](tests/e2e/docker-compose.yml) y [up.sh](tests/e2e/up.sh) montan el Moodle, [fixtures.php](tests/e2e/fixtures.php) crea el curso (tareas con y sin borrador, foros, cuestionarios con intentos, notificaciones…) y [e2e.test.ts](tests/e2e/e2e.test.ts) contiene las pruebas, incluido el servidor arrancado por stdio con un cliente MCP que acepta, rechaza o no soporta la confirmación.

## Licencia

MIT
