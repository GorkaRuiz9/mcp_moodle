# moodle-mcp

Servidor [MCP](https://modelcontextprotocol.io) de solo lectura para Moodle, pensado para estudiantes. Conecta tu asistente de IA (Claude Code, Claude Desktop, Cursor, Codex, Gemini CLI…) con tu cuenta de Moodle para que pueda consultar tus asignaturas, apuntes, entregas, plazos, notas y foros.

Viene configurado por defecto para **ALUD**, el Moodle de la Universidad de Deusto, pero funciona con cualquier Moodle que tenga activado el servicio de la app móvil.

- **Solo lee.** No puede entregar tareas, escribir en foros ni cambiar nada en Moodle.
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

## Herramientas

| Herramienta | Qué devuelve |
| --- | --- |
| `list_courses` | Tus asignaturas, con su identificador. |
| `get_course_contents` | Secciones, recursos y actividades de una asignatura, con los enlaces de los ficheros. |
| `list_assignments` | Tareas con su plazo, el estado de tu entrega y la nota. |
| `get_upcoming_deadlines` | Lo que vence en los próximos días en todas tus asignaturas. |
| `get_grades` | Tu nota total por asignatura, o el desglose de una. |
| `list_forum_discussions` | Foros y avisos de una asignatura. |
| `get_discussion` | Todos los mensajes de un debate. |
| `get_file` | Descarga un fichero a una carpeta local. De los PDF y ficheros de texto devuelve además el texto. |
| `search_courses_content` | Busca por título, descripción o nombre de fichero en tus asignaturas. |

Ejemplos de lo que puedes pedirle a tu asistente:

- «¿Qué tengo que entregar esta semana?»
- «Resúmeme el PDF del tema 3 de Cálculo.»
- «¿Hay algún aviso nuevo en Programación?»
- «¿Qué nota llevo en cada asignatura?»

## Límites conocidos

- `get_file` extrae texto de PDF y ficheros de texto. PowerPoint, Word e imágenes solo se descargan.
- Los PDF escaneados (sin capa de texto) no se pueden leer.
- `search_courses_content` no busca dentro de los ficheros, solo en títulos, descripciones y nombres.
- Cuestionarios, mensajería y notificaciones no están incluidos.
- Los ficheros descargados se guardan en `~/.cache/moodle-mcp/files/` y no se borran solos.

## Desarrollo

```bash
npm test          # tests con respuestas simuladas; no necesitan credenciales
npm run typecheck
npm run build
```

El código está en [src/](src/): [moodle.ts](src/moodle.ts) es el cliente de la API, [tools.ts](src/tools.ts) y [files.ts](src/files.ts) las herramientas, [server.ts](src/server.ts) su registro en MCP y [login.ts](src/login.ts) el inicio de sesión.

## Licencia

MIT
