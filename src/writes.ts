import { readFile, stat } from "node:fs/promises";
import { basename, extname, isAbsolute } from "node:path";
import { marked } from "marked";
import { CalendarEvent, parseWhen } from "./calendar.js";
import { Confirm, fecha } from "./confirm.js";
import { MAX_FILE_BYTES } from "./files.js";
import { formatBytes, formatDate, formatDuration, htmlToText } from "./format.js";
import { MoodleClient, MoodleError, NotLoggedInError } from "./moodle.js";
import { fetchNotifications } from "./news.js";
import { Forum, getCourses, nowSeconds } from "./tools.js";

/*
 * Everything in this file changes something in Moodle. Each function follows
 * the same order: read what is needed to describe the change, refuse what is
 * never allowed, ask the person for approval through `confirm`, and only then
 * write. Nothing is sent to Moodle before `confirm` resolves.
 */

const bad = (message: string, code = "badargs") => new MoodleError(message, code);

interface Warning {
  item?: string;
  warningcode?: string;
  message?: string;
}

const warningText = (warnings: Warning[] | undefined) =>
  (warnings ?? []).map((warning) => htmlToText(warning.message) || warning.warningcode || warning.item || "unknown problem").join("; ");

async function courseName(client: MoodleClient, courseId: number | undefined): Promise<string> {
  if (!courseId) return "curso desconocido";
  try {
    return (await getCourses(client)).find((course) => course.id === courseId)?.fullname ?? `curso ${courseId}`;
  } catch (err) {
    if (err instanceof NotLoggedInError) throw err;
    return `curso ${courseId}`;
  }
}

/** Students write Markdown; Moodle stores HTML. */
export function markdownToHtml(markdown: string): string {
  return (marked.parse(markdown, { async: false, gfm: true, breaks: true }) as string).trim();
}

function quote(text: string): string {
  return text
    .split("\n")
    .map((line) => `  │ ${line}`)
    .join("\n");
}

// --------------------------------------------------------------- calendar

export async function createCalendarEvent(
  client: MoodleClient,
  args: { name: string; start: string; duration_minutes?: number; description?: string },
  confirm: Confirm,
): Promise<string> {
  const name = args.name.trim();
  if (!name) throw bad("The event needs a name.");
  const start = parseWhen(args.start, "start");
  const duration = Math.round((args.duration_minutes ?? 0) * 60);
  const description = args.description?.trim() ?? "";

  const summary = [
    "Vas a crear un evento PERSONAL en tu calendario de Moodle. Solo lo ves tú.",
    "",
    `Nombre: ${name}`,
    `Empieza: ${fecha(start)}`,
    `Duración: ${duration ? formatDuration(duration) : "sin duración"}`,
  ];
  if (description) summary.push("Descripción:", quote(description));
  await confirm(summary.join("\n"));

  const data = await client.call<{ events?: { id: number }[]; warnings?: Warning[] }>("core_calendar_create_calendar_events", {
    events: [{ name, description: description ? markdownToHtml(description) : "", format: 1, timestart: start, timeduration: duration, eventtype: "user" }],
  });
  const created = data.events?.[0];
  if (!created) throw new MoodleError(`Moodle did not create the event: ${warningText(data.warnings) || "no reason given"}.`, "notcreated");
  client.clearCache();
  return `Created personal calendar event [event ${created.id}] "${name}" on ${formatDate(start)}.`;
}

export async function deleteCalendarEvent(client: MoodleClient, args: { event_id: number }, confirm: Confirm): Promise<string> {
  const info = await client.siteInfo();
  const data = await client.call<{ event?: CalendarEvent & { candelete?: boolean } }>("core_calendar_get_calendar_event_by_id", { eventid: args.event_id });
  const event = data.event;
  if (!event) throw new MoodleError(`Event ${args.event_id} was not found.`, "notfound");
  if (event.eventtype !== "user" || event.userid !== info.userid) {
    throw new MoodleError(
      `Event ${args.event_id} ("${htmlToText(event.name)}") is not one of the user's personal events, so it cannot be deleted here. Only personal events can be deleted.`,
      "notpersonal",
    );
  }
  await confirm(
    [
      "Vas a BORRAR un evento personal de tu calendario de Moodle. No se puede deshacer.",
      "",
      `Nombre: ${htmlToText(event.name)}`,
      `Empieza: ${fecha(event.timestart)}`,
      `Duración: ${event.timeduration ? formatDuration(event.timeduration) : "sin duración"}`,
    ].join("\n"),
  );
  await client.call("core_calendar_delete_calendar_events", { events: [{ eventid: args.event_id, repeat: false }] });
  client.clearCache();
  return `Deleted personal calendar event ${args.event_id} ("${htmlToText(event.name)}").`;
}

// ------------------------------------------------------------- completion

interface CourseModuleInfo {
  id: number;
  course: number;
  name: string;
  modname: string;
  /** 0 = not tracked, 1 = the student ticks it, 2 = Moodle decides. */
  completion?: number;
}

export async function setActivityCompletion(client: MoodleClient, args: { cmid: number; completed: boolean }, confirm: Confirm): Promise<string> {
  const info = await client.siteInfo();
  const { cm } = await client.call<{ cm: CourseModuleInfo }>("core_course_get_course_module", { cmid: args.cmid });
  const label = `${cm.modname} "${htmlToText(cm.name)}" [cmid ${cm.id}]`;
  if (cm.completion === 2) {
    throw new MoodleError(`${label} is completed automatically by Moodle when its conditions are met; it cannot be ticked by hand.`, "notmanual");
  }
  if (cm.completion !== 1) throw new MoodleError(`${label} does not track completion.`, "notmanual");

  const statuses = await client.call<{ statuses?: { cmid: number; state: number }[] }>("core_completion_get_activities_completion_status", {
    courseid: cm.course,
    userid: info.userid,
  });
  const current = statuses.statuses?.find((status) => status.cmid === cm.id);
  const isComplete = (current?.state ?? 0) !== 0;
  if (current && isComplete === args.completed) {
    return `${label} is already marked as ${args.completed ? "completed" : "not completed"}. Nothing was changed.`;
  }

  await confirm(
    [
      args.completed ? "Vas a marcar una actividad como COMPLETADA en Moodle." : "Vas a DESMARCAR una actividad como completada en Moodle.",
      "",
      `Curso: ${await courseName(client, cm.course)}`,
      `Actividad: ${htmlToText(cm.name)} (${cm.modname})`,
      `Estado actual: ${isComplete ? "completada" : "no completada"}`,
      `Estado nuevo: ${args.completed ? "completada" : "no completada"}`,
      "",
      "Tu profesor puede ver este estado. Puedes volver a cambiarlo cuando quieras.",
    ].join("\n"),
  );
  const result = await client.call<{ status?: boolean; warnings?: Warning[] }>("core_completion_update_activity_completion_status_manually", {
    cmid: cm.id,
    completed: args.completed,
  });
  if (!result.status) throw new MoodleError(`Moodle did not change the completion state: ${warningText(result.warnings) || "no reason given"}.`, "notchanged");
  client.clearCache();
  return `${label} is now marked as ${args.completed ? "completed" : "not completed"}.`;
}

// ---------------------------------------------------------- notifications

const NOTIFICATION_SCAN = 100;
const MAX_LISTED = 15;

export async function markNotificationsRead(
  client: MoodleClient,
  args: { notification_ids?: number[]; all?: boolean },
  confirm: Confirm,
): Promise<string> {
  const ids = [...new Set(args.notification_ids ?? [])];
  if (args.all ? ids.length > 0 : ids.length === 0) throw bad("Pass either notification_ids or all: true (not both).");
  const info = await client.siteInfo();
  const page = await fetchNotifications(client, NOTIFICATION_SCAN);
  const describe = (n: { subject?: string; timecreated?: number }) => `  - ${fecha(n.timecreated)} — ${htmlToText(n.subject) || "(sin asunto)"}`;

  if (args.all) {
    if (!page.unreadcount) return "There are no unread notifications. Nothing was changed.";
    const unread = page.notifications.filter((n) => !n.read);
    const listed = unread.slice(0, MAX_LISTED).map(describe);
    if (page.unreadcount > listed.length) listed.push(`  - …y ${page.unreadcount - listed.length} más`);
    await confirm(
      [
        `Vas a marcar como LEÍDAS todas tus notificaciones de Moodle sin leer (${page.unreadcount}).`,
        "Dejarán de aparecer como pendientes en la web y en la app. No se puede deshacer.",
        "",
        ...listed,
      ].join("\n"),
    );
    // The cut-off keeps anything that arrives after the prompt out of the sweep.
    const cutoff = nowSeconds();
    await client.call("core_message_mark_all_notifications_as_read", { useridto: info.userid, useridfrom: 0, timecreatedto: cutoff });
    return `Marked ${page.unreadcount} notifications as read.`;
  }

  const known = new Map(page.notifications.map((n) => [n.id, n]));
  const missing = ids.filter((id) => !known.has(id));
  if (missing.length) {
    throw new MoodleError(
      `Notification ${missing.join(", ")} is not among the user's ${NOTIFICATION_SCAN} most recent notifications. Use ids shown by get_notifications.`,
      "notfound",
    );
  }
  const pending = ids.map((id) => known.get(id)!).filter((n) => !n.read);
  if (!pending.length) return "Those notifications are already read. Nothing was changed.";
  await confirm(
    [
      `Vas a marcar como LEÍDAS ${pending.length === 1 ? "esta notificación" : `estas ${pending.length} notificaciones`} de Moodle.`,
      "Dejarán de aparecer como pendientes en la web y en la app. No se puede deshacer.",
      "",
      ...pending.map(describe),
    ].join("\n"),
  );
  for (const notification of pending) {
    await client.call("core_message_mark_notification_read", { notificationid: notification.id });
  }
  return `Marked ${pending.length} ${pending.length === 1 ? "notification" : "notifications"} as read: ${pending.map((n) => n.id).join(", ")}.`;
}

// ----------------------------------------------------------------- forums

const FORUM_NOTE =
  "Lo verán los participantes del foro con tu nombre, y Moodle puede enviarlo por correo a quienes estén suscritos. " +
  "Después solo podrás editarlo o borrarlo en la web durante un tiempo limitado (normalmente 30 minutos).";

function requireText(value: string, what: string): string {
  const text = value.trim();
  if (!text) throw bad(`The ${what} is empty.`);
  return text;
}

export async function addForumDiscussion(
  client: MoodleClient,
  args: { forum_id: number; subject: string; message: string },
  confirm: Confirm,
): Promise<string> {
  const subject = requireText(args.subject, "subject");
  const message = requireText(args.message, "message");
  const forums = await client.call<Forum[]>("mod_forum_get_forums_by_courses", {});
  const forum = forums.find((candidate) => candidate.id === args.forum_id);
  if (!forum) throw new MoodleError(`Forum ${args.forum_id} was not found in the user's courses.`, "notfound");
  const allowed = await client.call<{ status?: boolean }>("mod_forum_can_add_discussion", { forumid: forum.id });
  if (!allowed.status) {
    throw new MoodleError(`The user is not allowed to start discussions in forum ${forum.id} ("${htmlToText(forum.name)}").`, "cannotpost");
  }

  await confirm(
    [
      "Vas a ABRIR UN HILO NUEVO en un foro de Moodle.",
      "",
      `Curso: ${await courseName(client, forum.course)}`,
      `Foro: ${htmlToText(forum.name)}`,
      `Asunto: ${subject}`,
      "Mensaje:",
      quote(message),
      "",
      FORUM_NOTE,
    ].join("\n"),
  );
  const result = await client.call<{ discussionid?: number; warnings?: Warning[] }>("mod_forum_add_discussion", {
    forumid: forum.id,
    subject,
    message: markdownToHtml(message),
  });
  if (!result.discussionid) throw new MoodleError(`Moodle did not create the discussion: ${warningText(result.warnings) || "no reason given"}.`, "notcreated");
  client.clearCache();
  return `Posted. New discussion [discussion ${result.discussionid}] "${subject}" in forum ${forum.id} ("${htmlToText(forum.name)}").`;
}

interface ParentPost {
  id: number;
  subject?: string;
  message?: string;
  discussionid?: number;
  author?: { fullname?: string };
  capabilities?: { reply?: boolean };
}

export async function replyToForumPost(
  client: MoodleClient,
  args: { post_id: number; message: string; subject?: string },
  confirm: Confirm,
): Promise<string> {
  const message = requireText(args.message, "message");
  const { post: parent } = await client.call<{ post: ParentPost }>("mod_forum_get_discussion_post", { postid: args.post_id });
  if (parent.capabilities?.reply === false) {
    throw new MoodleError(`The user is not allowed to reply to post ${args.post_id}.`, "cannotpost");
  }
  const parentSubject = htmlToText(parent.subject);
  const subject = args.subject?.trim() || (/^re:/i.test(parentSubject) ? parentSubject : `Re: ${parentSubject}`);

  // Where the post lives, so the person sees the forum and course it goes to.
  let place: string[] = [];
  if (parent.discussionid) {
    try {
      const discussion = await client.call<{ posts?: { subject?: string; parentid?: number | null }[]; forumid?: number; courseid?: number }>(
        "mod_forum_get_discussion_posts",
        { discussionid: parent.discussionid },
      );
      const first = discussion.posts?.find((post) => !post.parentid);
      let forumName = discussion.forumid ? `foro ${discussion.forumid}` : "";
      if (discussion.courseid && discussion.forumid) {
        const forums = await client.call<Forum[]>("mod_forum_get_forums_by_courses", { courseids: [discussion.courseid] });
        forumName = htmlToText(forums.find((forum) => forum.id === discussion.forumid)?.name) || forumName;
      }
      place = [
        `Curso: ${await courseName(client, discussion.courseid)}`,
        ...(forumName ? [`Foro: ${forumName}`] : []),
        ...(first?.subject ? [`Hilo: ${htmlToText(first.subject)}`] : []),
      ];
    } catch (err) {
      if (err instanceof NotLoggedInError) throw err;
    }
  }

  await confirm(
    [
      "Vas a RESPONDER en un foro de Moodle.",
      "",
      ...place,
      `Respondes a: ${parent.author?.fullname ?? "autor desconocido"} — «${parentSubject}»`,
      `Asunto: ${subject}`,
      "Mensaje:",
      quote(message),
      "",
      FORUM_NOTE,
    ].join("\n"),
  );
  const result = await client.call<{ postid?: number; warnings?: Warning[] }>("mod_forum_add_discussion_post", {
    postid: parent.id,
    subject,
    message: markdownToHtml(message),
  });
  if (!result.postid) throw new MoodleError(`Moodle did not save the reply: ${warningText(result.warnings) || "no reason given"}.`, "notcreated");
  client.clearCache();
  return `Posted. New reply [post ${result.postid}] to post ${parent.id}${parent.discussionid ? ` in [discussion ${parent.discussionid}]` : ""}.`;
}

// ------------------------------------------------------------ assignments

interface AssignConfig {
  plugin: string;
  subtype: string;
  name: string;
  value: string;
}

interface AssignmentDetail {
  id: number;
  cmid: number;
  course: number;
  name: string;
  duedate?: number;
  cutoffdate?: number;
  allowsubmissionsfromdate?: number;
  /** 1 when students must press "Submit assignment" after saving a draft. */
  submissiondrafts?: number;
  requiresubmissionstatement?: number;
  teamsubmission?: number;
  configs?: AssignConfig[];
}

interface StoredFile {
  filename: string;
  filepath?: string;
  filesize?: number;
  fileurl?: string;
}

interface SubmissionPlugin {
  type: string;
  fileareas?: { area: string; files?: StoredFile[] }[];
  editorfields?: { name: string; text?: string; format?: number }[];
}

interface Submission {
  status?: string;
  timemodified?: number;
  plugins?: SubmissionPlugin[];
}

interface SubmissionState {
  lastattempt?: {
    submission?: Submission;
    teamsubmission?: Submission;
    canedit?: boolean;
    locked?: boolean;
    graded?: boolean;
    submissionsenabled?: boolean;
  };
}

function submissionOf(state: SubmissionState, team: boolean): Submission | undefined {
  const attempt = state.lastattempt;
  return (team ? attempt?.teamsubmission : undefined) ?? attempt?.submission;
}

function storedFiles(submission: Submission | undefined): StoredFile[] {
  const plugin = submission?.plugins?.find((candidate) => candidate.type === "file");
  return plugin?.fileareas?.find((area) => area.area === "submission_files")?.files ?? [];
}

function storedText(submission: Submission | undefined): { text: string; hasEmbeddedFiles: boolean } {
  const plugin = submission?.plugins?.find((candidate) => candidate.type === "onlinetext");
  const text = plugin?.editorfields?.find((field) => field.name === "onlinetext")?.text ?? "";
  const embedded = (plugin?.fileareas ?? []).some((area) => (area.files ?? []).length > 0);
  return { text, hasEmbeddedFiles: embedded };
}

const setting = (assignment: AssignmentDetail, plugin: string, name: string) =>
  assignment.configs?.find((config) => config.subtype === "assignsubmission" && config.plugin === plugin && config.name === name)?.value;

const storedKey = (file: StoredFile) => `${file.filepath ?? "/"}${file.filename}`;

interface LocalFile {
  path: string;
  name: string;
  size: number;
}

async function inspectLocalFiles(paths: string[]): Promise<LocalFile[]> {
  const files: LocalFile[] = [];
  const names = new Set<string>();
  for (const path of paths) {
    if (!isAbsolute(path)) throw bad(`"${path}" is not an absolute path. Pass the full path of each file.`);
    let info;
    try {
      info = await stat(path);
    } catch {
      throw bad(`File not found: ${path}`, "nofile");
    }
    if (!info.isFile()) throw bad(`Not a regular file: ${path}`, "nofile");
    if (info.size === 0) throw bad(`File is empty: ${path}`, "nofile");
    const name = basename(path);
    if (names.has(name)) throw bad(`Two of the files are called "${name}". A submission cannot hold two files with the same name.`);
    names.add(name);
    files.push({ path, name, size: info.size });
  }
  return files;
}

export async function saveAssignmentSubmission(
  client: MoodleClient,
  args: { assign_id: number; files?: string[]; text?: string; replace_existing?: boolean },
  confirm: Confirm,
): Promise<string> {
  const wantsFiles = (args.files?.length ?? 0) > 0;
  const wantsText = args.text !== undefined;
  if (!wantsFiles && !wantsText) throw bad("Pass files (absolute paths), text, or both.");
  const newText = wantsText ? requireText(args.text!, "text") : "";

  const all = await client.call<{ courses: { id: number; assignments: AssignmentDetail[] }[] }>("mod_assign_get_assignments", {});
  const assignment = all.courses.flatMap((course) => course.assignments).find((candidate) => candidate.id === args.assign_id);
  if (!assignment) throw new MoodleError(`Assignment ${args.assign_id} was not found in the user's courses. Use an id shown by list_assignments.`, "notfound");
  const title = `"${htmlToText(assignment.name)}" [assign ${assignment.id}]`;

  const filesEnabled = setting(assignment, "file", "enabled") === "1";
  const textEnabled = setting(assignment, "onlinetext", "enabled") === "1";
  if (wantsFiles && !filesEnabled) throw new MoodleError(`Assignment ${title} does not accept file submissions.`, "notaccepted");
  if (wantsText && !textEnabled) throw new MoodleError(`Assignment ${title} does not accept online text.`, "notaccepted");

  const now = nowSeconds();
  if (assignment.allowsubmissionsfromdate && assignment.allowsubmissionsfromdate > now) {
    throw new MoodleError(`Assignment ${title} does not accept submissions until ${formatDate(assignment.allowsubmissionsfromdate)}.`, "notopen");
  }
  if (assignment.cutoffdate && assignment.cutoffdate < now) {
    throw new MoodleError(`Assignment ${title} stopped accepting submissions on ${formatDate(assignment.cutoffdate)}.`, "closed");
  }
  const hasDraftStage = assignment.submissiondrafts === 1;
  if (!hasDraftStage && assignment.requiresubmissionstatement === 1) {
    throw new MoodleError(
      `Assignment ${title} makes the student accept a submission statement when saving, which has to be done by the student on the Moodle website. Nothing was changed.`,
      "needsstatement",
    );
  }

  const state = await client.call<SubmissionState>("mod_assign_get_submission_status", { assignid: assignment.id });
  const attempt = state.lastattempt;
  const submission = submissionOf(state, assignment.teamsubmission === 1);
  if (hasDraftStage && submission?.status === "submitted") {
    throw new MoodleError(`Assignment ${title} has already been submitted for grading, so it is not touched. Nothing was changed.`, "alreadysubmitted");
  }
  if (attempt?.graded && submission?.status === "submitted") {
    throw new MoodleError(`Assignment ${title} has already been graded, so it is not touched. Nothing was changed.`, "alreadygraded");
  }
  if (attempt?.locked || attempt?.canedit === false || attempt?.submissionsenabled === false) {
    throw new MoodleError(`Moodle does not let the user edit the submission of ${title} right now (locked, closed or not allowed). Nothing was changed.`, "cannotedit");
  }

  // Work out the final set of files: by default what was there plus the new ones.
  const local = wantsFiles ? await inspectLocalFiles(args.files!) : [];
  const existing = filesEnabled ? storedFiles(submission) : [];
  const localNames = new Set(local.map((file) => file.name));
  const overwritten = existing.filter((file) => (file.filepath ?? "/") === "/" && localNames.has(file.filename));
  const dropAll = args.replace_existing === true && wantsFiles;
  const kept = dropAll ? [] : existing.filter((file) => !overwritten.includes(file));
  const removed = dropAll ? existing.filter((file) => !overwritten.includes(file)) : [];

  const maxFiles = Number(setting(assignment, "file", "maxfilesubmissions") ?? 0);
  const maxBytes = Number(setting(assignment, "file", "maxsubmissionsizebytes") ?? 0);
  if (maxFiles && kept.length + local.length > maxFiles) {
    throw new MoodleError(
      `Assignment ${title} accepts at most ${maxFiles} files; this would leave ${kept.length + local.length} (${kept.length} already there, ${local.length} new). ` +
        "Upload fewer files, or pass replace_existing to drop the ones already there.",
      "toomany",
    );
  }
  for (const file of local) {
    if (maxBytes && file.size > maxBytes) {
      throw new MoodleError(`${file.path} is ${formatBytes(file.size)}; assignment ${title} accepts at most ${formatBytes(maxBytes)} per file.`, "toolarge");
    }
  }
  const accepted = (setting(assignment, "file", "filetypeslist") ?? "").split(/[\s,;]+/).filter(Boolean);
  // Only a list made of plain extensions can be checked here; type groups ("document") are left to the person.
  if (accepted.length && accepted.every((type) => type.startsWith("."))) {
    const allowed = new Set(accepted.map((type) => type.toLowerCase()));
    for (const file of local) {
      if (!allowed.has(extname(file.name).toLowerCase())) {
        throw new MoodleError(`${file.name} is not an accepted file type for assignment ${title} (accepted: ${accepted.join(", ")}).`, "badtype");
      }
    }
  }
  for (const file of kept) {
    if (!file.fileurl) throw new MoodleError(`Cannot keep the existing file ${file.filename}: Moodle gave no download address for it. Nothing was changed.`, "cannotkeep");
  }

  const previous = textEnabled ? storedText(submission) : { text: "", hasEmbeddedFiles: false };
  if (textEnabled && !wantsText && previous.hasEmbeddedFiles) {
    throw new MoodleError(
      `The online text already saved in ${title} has images or files embedded in it, which cannot be preserved from here. Edit this submission on the Moodle website. Nothing was changed.`,
      "cannotkeep",
    );
  }

  // ---- what the person approves
  const deadline = assignment.cutoffdate || assignment.duedate;
  const summary = ["Vas a guardar una entrega en una tarea de Moodle.", "", `Curso: ${await courseName(client, assignment.course)}`, `Tarea: ${htmlToText(assignment.name)}`];
  summary.push(`Fecha límite: ${fecha(assignment.duedate)}${assignment.duedate && assignment.duedate < now ? " (YA HA PASADO: se registrará como entrega tardía)" : ""}`);
  if (assignment.teamsubmission === 1) summary.push("Es una entrega EN GRUPO: lo que guardes afecta a la entrega de todo tu grupo.");
  summary.push("");
  if (hasDraftStage) {
    summary.push("Efecto: se guarda como BORRADOR. No queda entregada: después tendrás que pulsar tú «Entregar tarea» en la web de Moodle.");
  } else {
    summary.push(
      "Efecto: ESTA TAREA NO TIENE FASE DE BORRADOR. Al guardar, ESTO CUENTA COMO ENTREGA y tu profesor ya puede verla y calificarla.",
      deadline ? `Podrás modificarla hasta el ${fecha(deadline)}.` : "Podrás modificarla mientras la tarea siga abierta.",
    );
  }
  if (filesEnabled) {
    summary.push("");
    if (local.length) {
      summary.push(`Ficheros que se suben desde tu ordenador (${local.length}):`, ...local.map((file) => `  + ${file.path} (${formatBytes(file.size)})`));
    }
    if (overwritten.length) {
      summary.push(`Ficheros de la entrega que se SUSTITUYEN por tener el mismo nombre (${overwritten.length}):`, ...overwritten.map((file) => `  ~ ${file.filename}`));
    }
    if (removed.length) {
      summary.push(`Ficheros de la entrega que se ELIMINAN (${removed.length}):`, ...removed.map((file) => `  - ${storedKey(file)} (${formatBytes(file.filesize)})`));
    }
    if (kept.length) {
      summary.push(`Ficheros que ya estaban y se conservan (${kept.length}):`, ...kept.map((file) => `  = ${storedKey(file)} (${formatBytes(file.filesize)})`));
    }
    if (!local.length && !kept.length) summary.push("Ficheros: ninguno.");
    if (accepted.length) summary.push(`Tipos de fichero que acepta la tarea: ${accepted.join(", ")}`);
  }
  if (wantsText) {
    summary.push("", previous.text ? "Texto en línea (SUSTITUYE al que había):" : "Texto en línea:", quote(newText));
  } else if (textEnabled && previous.text) {
    summary.push("", "El texto en línea que ya había se conserva sin cambios.");
  }
  await confirm(summary.join("\n"));

  // ---- write: everything goes to a private draft area first, then one save.
  let draftId = 0;
  for (const file of kept) {
    const { data } = await client.download(file.fileurl!, MAX_FILE_BYTES);
    draftId = await client.upload({ name: file.filename, data, path: file.filepath ?? "/" }, draftId);
  }
  for (const file of local) {
    const data = new Uint8Array(await readFile(file.path));
    // The file may have changed while the prompt was open; send only what was approved.
    if (data.byteLength !== file.size) {
      throw new MoodleError(`${file.path} changed size after it was approved (${formatBytes(file.size)} → ${formatBytes(data.byteLength)}). Nothing was saved in the assignment.`, "changed");
    }
    draftId = await client.upload({ name: file.name, data }, draftId);
  }
  const unusedDraft = async () => (await client.call<{ itemid: number }>("core_files_get_unused_draft_itemid")).itemid;
  const plugindata: Record<string, number | { text: string; format: number; itemid: number }> = {};
  if (filesEnabled) plugindata.files_filemanager = draftId || (await unusedDraft());
  if (textEnabled) {
    plugindata.onlinetext_editor = { text: wantsText ? markdownToHtml(newText) : previous.text, format: 1, itemid: await unusedDraft() };
  }
  const warnings = await client.call<Warning[]>("mod_assign_save_submission", { assignmentid: assignment.id, plugindata });
  if (Array.isArray(warnings) && warnings.length) {
    throw new MoodleError(`Moodle did not save the submission of ${title}: ${warningText(warnings)}.`, "notsaved");
  }
  client.clearCache();

  // ---- report what Moodle now holds, not what was intended.
  const after = submissionOf(await client.call<SubmissionState>("mod_assign_get_submission_status", { assignid: assignment.id }), assignment.teamsubmission === 1);
  const nowStored = filesEnabled ? storedFiles(after) : [];
  const report = [`Saved the submission of assignment ${title}. Moodle now reports status "${after?.status ?? "unknown"}".`];
  if (hasDraftStage) {
    report.push('It is a DRAFT: it is NOT submitted. The user still has to press "Submit assignment" on the Moodle website before the deadline.');
  } else {
    report.push("This assignment has no draft stage, so this counts as the submission. It can still be changed while the assignment is open.");
  }
  if (filesEnabled) report.push(`Files in the submission (${nowStored.length}): ${nowStored.map((file) => `${file.filename} (${formatBytes(file.filesize)})`).join(", ") || "none"}.`);
  if (textEnabled) report.push(`Online text: ${storedText(after).text ? "saved" : "empty"}.`);
  return report.join("\n");
}
