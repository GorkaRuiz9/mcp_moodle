# Plan de moodle-mcp

Decisiones de diseño de las herramientas nuevas, su estado y lo que queda para más adelante.

## Estado

**Implementado en la versión 0.2.0**: las cinco áreas de lectura y todas las escrituras acordadas, con activación por grupos y confirmación en cada cambio. El uso está documentado en el [README](README.md).

| Área | Herramientas | Estado |
| --- | --- | --- |
| Novedades | `get_recent_changes` | Hecho |
| Notificaciones y mensajes | `get_notifications`, `get_messages` | Hecho |
| Cuestionarios | `list_quizzes`, `get_quiz_attempt` | Hecho |
| Calendario completo | `get_calendar_events` | Hecho |
| Gente del curso | `get_course_participants` | Hecho |
| Escritura: calendario | `create_calendar_event`, `delete_calendar_event` | Hecho |
| Escritura: seguimiento | `set_activity_completion` | Hecho |
| Escritura: notificaciones | `mark_notifications_read` | Hecho |
| Escritura: foros | `add_forum_discussion`, `reply_to_forum_post` | Hecho |
| Escritura: entregas | `save_assignment_submission` | Hecho |

Quedan 16 herramientas de lectura visibles por defecto y 7 de escritura ocultas.

### Cómo se ha probado

- **Pruebas unitarias** (`npm test`): contra una API de Moodle simulada. Cubren cada herramienta, cada negativa y que nada se escribe antes de la confirmación.
- **Pruebas de extremo a extremo** (`npm run test:e2e`): contra un Moodle 4.5 local en Docker, con un curso de pruebas. Leen y escriben de verdad, y comprueban el resultado preguntando a Moodle. Incluyen el servidor arrancado por stdio con un cliente MCP que acepta, rechaza o no soporta la confirmación.
- **Lecturas contra ALUD**: las herramientas de lectura nuevas se han ejecutado contra la cuenta real, que solo se ha leído.
- **Sin probar**: el diálogo de confirmación en un cliente interactivo (Claude Code, Cursor…). Las pruebas lo ejercitan con el cliente del SDK oficial de MCP, que habla el mismo protocolo, pero nadie ha visto todavía la ventana en pantalla.

## Decisiones tomadas

### Público

- Se diseña para cualquier estudiante de cualquier Moodle, usando solo módulos estándar. ALUD es el banco de pruebas de lectura.
- Los plugins propios de Deusto (por ejemplo Kuet) quedan fuera salvo que más adelante se vea que hacen falta.

### Escritura: activación y aprobación

- Las herramientas de escritura vienen **desactivadas por defecto**. Sin activarlas no aparecen en la lista de herramientas, y la instalación por defecto sigue siendo de solo lectura.
- Se activan con la variable de entorno `MOODLE_MCP_WRITE`, que lista los grupos: `entregas`, `foros`, `calendario`, `seguimiento`, `notificaciones` (o `todo`). Un nombre desconocido impide que el servidor arranque.
- Aunque estén activadas, **cada ejecución pide permiso al humano**. Activarlas no equivale a aprobarlas, y no hay opción de «no volver a preguntar».
- La confirmación usa elicitation de MCP: el servidor muestra un resumen de lo que va a enviar y espera a que el humano marque la casilla y acepte. La muestra el cliente, así que el modelo no puede confirmarse a sí mismo.
- Si el cliente no soporta elicitation, la operación se rechaza. No se busca una vía alternativa.
- La confirmación muestra todo lo necesario: curso, actividad, el texto exacto o la lista de ficheros con ruta y tamaño, y el efecto en Moodle.
- En las entregas, además de la confirmación, donde Moodle tiene borrador solo se guarda el borrador y el humano pulsa «Entregar» en la web.

### Lectura

- **Novedades** no guarda estado: recibe una fecha «desde», por defecto los últimos 7 días.
- **Leer no marca como leído**: consultar notificaciones y mensajes no cambia nada en Moodle. Marcar como leído es una herramienta de escritura aparte.
- **Cuestionarios**: solo intentos terminados y con revisión permitida por el profesor. Nunca las preguntas de un intento en curso.
- **Gente del curso**: nombre, rol y grupos de todos; el correo solo de los profesores.
- **Mensajes privados**: lectura activa por defecto, en una herramienta separada de la de notificaciones.
- Una herramienta por tarea, con nombre claro. El calendario es una herramienta nueva y `get_upcoming_deadlines` se queda como estaba.

### Escritura

- **Entregas**:
  - Se acepta cualquier ruta local que el usuario confirme, sin limitar a una carpeta.
  - No se toca una tarea ya entregada para calificar.
  - **Tareas sin fase de borrador**: guardar ya es entregar. Se permiten, con una confirmación que dice claramente que cuenta como entrega y hasta cuándo se puede modificar. En ALUD es el caso habitual.
  - Por defecto se añaden los ficheros nuevos y se conservan los que hubiera, sustituyendo solo los del mismo nombre. Vaciar la entrega es una opción explícita que la confirmación señala.
  - También se soportan las tareas de texto en línea.
- **Foros**: solo texto (Markdown convertido a HTML), sin adjuntos.
- **Calendario**: crea eventos personales y borra solo eventos personales propios.
- **Finalización**: marca y desmarca, solo en actividades con finalización manual.
- **Fuera de la primera versión**: enviar mensajes privados.
- **Nunca**: empezar o contestar cuestionarios, lecciones o encuestas evaluables, y pulsar «Entregar» definitivo en una tarea.

### Pruebas

- Las escrituras se prueban contra un Moodle local en Docker, más tests unitarios con la API simulada.
- Nunca se prueban contra asignaturas reales de ALUD. Las pruebas de extremo a extremo se niegan a ejecutarse contra una dirección que no sea local.

## Decisiones tomadas durante la implementación

Casos que el plan no cubría y cómo se han resuelto. Conviene revisarlos:

- **Quinto grupo, `notificaciones`**: marcar notificaciones como leídas va en su propio grupo en vez de dentro de `seguimiento`, para poder activar una cosa sin la otra. Por eso hay 7 herramientas de escritura y no 6.
- **Nombres de grupo en inglés**: `MOODLE_MCP_WRITE` acepta también `assignments`, `forums`, `calendar`, `completion`, `notifications` y `all`.
- **Tareas ya calificadas**: no se tocan, aunque Moodle lo permitiría en las tareas sin borrador.
- **Tareas que exigen declaración de autoría al guardar** (sin borrador): se rechazan. Aceptar esa declaración es algo que debe hacer la persona en la web.
- **Texto en línea con imágenes incrustadas**: si la entrega ya tiene texto con ficheros incrustados y solo se envían ficheros nuevos, se rechaza, porque desde aquí no se pueden conservar esas imágenes.
- **Tipos de fichero**: solo se comprueba el tipo cuando la tarea lista extensiones concretas (`.pdf`). Si lista grupos de tipos («documento»), la confirmación los muestra y decide la persona.
- **Entregas en grupo**: se permiten, con un aviso en la confirmación de que el cambio afecta a todo el grupo.
- **Notificaciones a marcar**: solo se pueden marcar por id las que están entre las 100 más recientes, porque la confirmación tiene que poder enseñar cuáles son.
- **Profesores**: se considera profesor a quien tiene uno de los roles estándar de Moodle (`editingteacher`, `teacher`, `manager`, `coursecreator`) o figura como contacto del curso. Alguien con un rol propio del sitio que no sea contacto aparece sin correo.
- **Ficheros que cambian durante la confirmación**: si un fichero cambia de tamaño entre que se aprueba y se sube, no se guarda nada.

## Comprobado sobre los clientes

- **Claude Code** documenta el soporte de elicitation en modo formulario, que es el que se usa aquí.
- Claude Code permite configurar *hooks* que responden a estos diálogos automáticamente. Quien lo haga estará aprobando sin mirar; el README lo advierte.
- **Otros clientes** (Claude Desktop, Cursor, VS Code…): no verificado. En los que no lo soporten, las herramientas de escritura devuelven un error y no cambian nada.

## Para más adelante

- Estado de finalización («qué me falta por hacer»).
- Grabaciones de BigBlueButton.
- Consultas «choice» (por ejemplo, elegir grupo de prácticas).
- Talleres de evaluación entre pares.
- Wikis y glosarios.
- Adjuntos en los foros.
- Enviar mensajes privados, si algún día compensa el riesgo.
- Probar el diálogo de confirmación en cada cliente y anotar aquí cuáles funcionan.
