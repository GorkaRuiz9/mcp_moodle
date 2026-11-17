import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { parseWriteGroups } from "../src/confirm.js";
import {
  addForumDiscussion,
  createCalendarEvent,
  deleteCalendarEvent,
  markdownToHtml,
  markNotificationsRead,
  replyToForumPost,
  saveAssignmentSubmission,
  setActivityCompletion,
} from "../src/writes.js";
import { DAY, fakeConfirm, fakeMoodle, now, SITE } from "./helpers.js";

/** Web service functions that change something in Moodle. */
const WRITERS = /^(core_calendar_(create|delete)|core_completion_update|core_message_mark|mod_forum_add|mod_assign_save|mod_assign_submit)/;
const wrote = (calls: string[]) => calls.filter((name) => WRITERS.test(name));

const courses = () => [{ id: 10, fullname: "Cálculo I", shortname: "CALC1" }];

describe("MOODLE_MCP_WRITE", () => {
  it("is empty unless groups are named", () => {
    expect(parseWriteGroups(undefined).size).toBe(0);
    expect(parseWriteGroups("  ").size).toBe(0);
  });

  it("accepts a list of groups, in Spanish or English", () => {
    expect([...parseWriteGroups("entregas, Calendario")]).toEqual(["entregas", "calendario"]);
    expect([...parseWriteGroups("forums notifications completion")]).toEqual(["foros", "notificaciones", "seguimiento"]);
    expect(parseWriteGroups("todo").size).toBe(5);
  });

  it("refuses a name it does not know rather than ignoring it", () => {
    expect(() => parseWriteGroups("entregas,foro")).toThrow(/unknown group "foro"/);
  });
});

describe("calendar events", () => {
  it("creates a personal event only after approval", async () => {
    const { client, calls, paramsOf } = fakeMoodle({ core_calendar_create_calendar_events: () => ({ events: [{ id: 321 }], warnings: [] }) });
    const { confirm, shown } = fakeConfirm();
    const text = await createCalendarEvent(client, { name: "Estudiar Cálculo", start: "2026-12-01 18:30", duration_minutes: 90, description: "Temas **1 y 2**" }, confirm);
    expect(text).toContain("[event 321]");
    expect(shown[0]).toContain("evento PERSONAL");
    expect(shown[0]).toContain("Nombre: Estudiar Cálculo");
    expect(shown[0]).toContain("Empieza: mar 01/12/2026 18:30");
    expect(shown[0]).toContain("Duración: 1 h 30 min");
    expect(shown[0]).toContain("│ Temas **1 y 2**");
    const sent = paramsOf("core_calendar_create_calendar_events")[0]!;
    expect(sent.get("events[0][eventtype]")).toBe("user");
    expect(sent.get("events[0][timestart]")).toBe(String(Math.floor(new Date(2026, 11, 1, 18, 30).getTime() / 1000)));
    expect(sent.get("events[0][timeduration]")).toBe("5400");
    expect(sent.get("events[0][description]")).toBe("<p>Temas <strong>1 y 2</strong></p>");
    expect(wrote(calls)).toHaveLength(1);
  });

  it("writes nothing when the user declines", async () => {
    const { client, calls } = fakeMoodle({ core_calendar_create_calendar_events: () => ({ events: [{ id: 1 }] }) });
    await expect(createCalendarEvent(client, { name: "X", start: "2026-12-01 10:00" }, fakeConfirm("no").confirm)).rejects.toThrow(/did not approve/);
    expect(wrote(calls)).toEqual([]);
  });

  it("rejects a bad date before asking", async () => {
    const { client } = fakeMoodle({});
    const { confirm, shown } = fakeConfirm();
    await expect(createCalendarEvent(client, { name: "X", start: "el martes" }, confirm)).rejects.toThrow(/not a date/);
    expect(shown).toEqual([]);
  });

  it("reports an event Moodle did not create", async () => {
    const { client } = fakeMoodle({ core_calendar_create_calendar_events: () => ({ events: [], warnings: [{ message: "No permission" }] }) });
    await expect(createCalendarEvent(client, { name: "X", start: "2026-12-01" }, fakeConfirm().confirm)).rejects.toThrow(/did not create the event: No permission/);
  });

  const byId = (event: object) => ({ core_calendar_get_calendar_event_by_id: () => ({ event }), core_calendar_delete_calendar_events: () => null });

  it("deletes the user's own personal event after approval", async () => {
    const { client, calls, paramsOf } = fakeMoodle(byId({ id: 5, name: "Dentista", eventtype: "user", userid: 7, timestart: now() + DAY }));
    const { confirm, shown } = fakeConfirm();
    expect(await deleteCalendarEvent(client, { event_id: 5 }, confirm)).toContain('Deleted personal calendar event 5 ("Dentista")');
    expect(shown[0]).toContain("BORRAR");
    expect(shown[0]).toContain("Nombre: Dentista");
    expect(paramsOf("core_calendar_delete_calendar_events")[0]!.get("events[0][eventid]")).toBe("5");
    expect(wrote(calls)).toEqual(["core_calendar_delete_calendar_events"]);
  });

  it("never deletes course events or other people's events", async () => {
    for (const event of [
      { id: 5, name: "Examen", eventtype: "course", userid: 7, timestart: 1 },
      { id: 5, name: "Ajeno", eventtype: "user", userid: 99, timestart: 1 },
    ]) {
      const { client, calls } = fakeMoodle(byId(event));
      const { confirm, shown } = fakeConfirm();
      await expect(deleteCalendarEvent(client, { event_id: 5 }, confirm)).rejects.toThrow(/Only personal events can be deleted/);
      expect(shown).toEqual([]);
      expect(wrote(calls)).toEqual([]);
    }
  });
});

describe("set_activity_completion", () => {
  const handlers = (completion: number, state: number) => ({
    core_enrol_get_users_courses: courses,
    core_course_get_course_module: () => ({ cm: { id: 501, course: 10, name: "Lectura 1", modname: "page", completion } }),
    core_completion_get_activities_completion_status: () => ({ statuses: [{ cmid: 501, state }] }),
    core_completion_update_activity_completion_status_manually: () => ({ status: true, warnings: [] }),
  });

  it("ticks and unticks after approval", async () => {
    const tick = fakeMoodle(handlers(1, 0));
    const first = fakeConfirm();
    expect(await setActivityCompletion(tick.client, { cmid: 501, completed: true }, first.confirm)).toContain("now marked as completed");
    expect(first.shown[0]).toContain("COMPLETADA");
    expect(first.shown[0]).toContain("Curso: Cálculo I");
    expect(first.shown[0]).toContain("Actividad: Lectura 1 (page)");
    expect(tick.paramsOf("core_completion_update_activity_completion_status_manually")[0]!.get("completed")).toBe("1");

    const untick = fakeMoodle(handlers(1, 1));
    const second = fakeConfirm();
    expect(await setActivityCompletion(untick.client, { cmid: 501, completed: false }, second.confirm)).toContain("now marked as not completed");
    expect(second.shown[0]).toContain("DESMARCAR");
    expect(untick.paramsOf("core_completion_update_activity_completion_status_manually")[0]!.get("completed")).toBe("0");
  });

  it("refuses activities that are not ticked by hand", async () => {
    for (const [mode, reason] of [[2, /automatically/], [0, /does not track completion/]] as const) {
      const { client, calls } = fakeMoodle(handlers(mode, 0));
      const { confirm, shown } = fakeConfirm();
      await expect(setActivityCompletion(client, { cmid: 501, completed: true }, confirm)).rejects.toThrow(reason);
      expect(shown).toEqual([]);
      expect(wrote(calls)).toEqual([]);
    }
  });

  it("does not ask when there is nothing to change, nor write when declined", async () => {
    const same = fakeMoodle(handlers(1, 1));
    const quiet = fakeConfirm();
    expect(await setActivityCompletion(same.client, { cmid: 501, completed: true }, quiet.confirm)).toContain("already marked as completed");
    expect(quiet.shown).toEqual([]);
    const declined = fakeMoodle(handlers(1, 0));
    await expect(setActivityCompletion(declined.client, { cmid: 501, completed: true }, fakeConfirm("no").confirm)).rejects.toThrow(/did not approve/);
    expect(wrote(declined.calls)).toEqual([]);
  });
});

describe("mark_notifications_read", () => {
  const page = () => ({
    unreadcount: 2,
    notifications: [
      { id: 3, subject: "Tarea calificada", timecreated: now() - 3600, read: false },
      { id: 2, subject: "Cambio de aula", timecreated: now() - DAY, read: false },
      { id: 1, subject: "Antigua", timecreated: now() - 9 * DAY, read: true },
    ],
  });
  const handlers = { message_popup_get_popup_notifications: page, core_message_mark_notification_read: () => ({}), core_message_mark_all_notifications_as_read: () => true };

  it("marks the chosen ones, showing which", async () => {
    const { client, calls, paramsOf } = fakeMoodle(handlers);
    const { confirm, shown } = fakeConfirm();
    const text = await markNotificationsRead(client, { notification_ids: [3, 1] }, confirm);
    expect(text).toBe("Marked 1 notification as read: 3.");
    expect(shown[0]).toContain("esta notificación");
    expect(shown[0]).toContain("— Tarea calificada");
    expect(shown[0]).not.toContain("Antigua");
    expect(paramsOf("core_message_mark_notification_read").map((p) => p.get("notificationid"))).toEqual(["3"]);
    expect(wrote(calls)).toEqual(["core_message_mark_notification_read"]);
  });

  it("marks all unread ones up to the moment of approval", async () => {
    const { client, paramsOf } = fakeMoodle(handlers);
    const { confirm, shown } = fakeConfirm();
    expect(await markNotificationsRead(client, { all: true }, confirm)).toBe("Marked 2 notifications as read.");
    expect(shown[0]).toContain("todas tus notificaciones de Moodle sin leer (2)");
    expect(shown[0]).toContain("— Cambio de aula");
    const sent = paramsOf("core_message_mark_all_notifications_as_read")[0]!;
    expect(sent.get("useridto")).toBe("7");
    expect(Number(sent.get("timecreatedto"))).toBeGreaterThan(now() - 5);
  });

  it("refuses ids it cannot show, and bad combinations", async () => {
    const { client, calls } = fakeMoodle(handlers);
    await expect(markNotificationsRead(client, { notification_ids: [999] }, fakeConfirm().confirm)).rejects.toThrow(/not among the user's 100 most recent/);
    await expect(markNotificationsRead(client, {}, fakeConfirm().confirm)).rejects.toThrow(/either notification_ids or all/);
    await expect(markNotificationsRead(client, { notification_ids: [3], all: true }, fakeConfirm().confirm)).rejects.toThrow(/either notification_ids or all/);
    expect(wrote(calls)).toEqual([]);
  });

  it("does nothing when declined or when all is read", async () => {
    const declined = fakeMoodle(handlers);
    await expect(markNotificationsRead(declined.client, { all: true }, fakeConfirm("no").confirm)).rejects.toThrow(/did not approve/);
    expect(wrote(declined.calls)).toEqual([]);
    const { client } = fakeMoodle(handlers);
    const { confirm, shown } = fakeConfirm();
    expect(await markNotificationsRead(client, { notification_ids: [1] }, confirm)).toContain("already read");
    expect(shown).toEqual([]);
  });
});

describe("forums", () => {
  const forums = () => [{ id: 8, course: 10, name: "Dudas", type: "general" }];

  it("starts a discussion with the exact text approved", async () => {
    const { client, calls, paramsOf } = fakeMoodle({
      core_enrol_get_users_courses: courses,
      mod_forum_get_forums_by_courses: forums,
      mod_forum_can_add_discussion: () => ({ status: true }),
      mod_forum_add_discussion: () => ({ discussionid: 95, warnings: [] }),
    });
    const { confirm, shown } = fakeConfirm();
    const text = await addForumDiscussion(client, { forum_id: 8, subject: "Duda ejercicio 3", message: "Hola:\n\n¿El límite es **0** o no existe?" }, confirm);
    expect(text).toContain("[discussion 95]");
    expect(shown[0]).toContain("ABRIR UN HILO NUEVO");
    expect(shown[0]).toContain("Curso: Cálculo I\nForo: Dudas\nAsunto: Duda ejercicio 3\nMensaje:\n  │ Hola:\n  │ \n  │ ¿El límite es **0** o no existe?");
    expect(shown[0]).toContain("con tu nombre");
    const sent = paramsOf("mod_forum_add_discussion")[0]!;
    expect(sent.get("forumid")).toBe("8");
    expect(sent.get("message")).toBe("<p>Hola:</p>\n<p>¿El límite es <strong>0</strong> o no existe?</p>");
    expect(wrote(calls)).toEqual(["mod_forum_add_discussion"]);
  });

  it("refuses forums the student cannot post in, without asking", async () => {
    const { client, calls } = fakeMoodle({ mod_forum_get_forums_by_courses: forums, mod_forum_can_add_discussion: () => ({ status: false }) });
    const { confirm, shown } = fakeConfirm();
    await expect(addForumDiscussion(client, { forum_id: 8, subject: "a", message: "b" }, confirm)).rejects.toThrow(/not allowed to start discussions/);
    await expect(addForumDiscussion(client, { forum_id: 99, subject: "a", message: "b" }, confirm)).rejects.toThrow(/was not found/);
    await expect(addForumDiscussion(client, { forum_id: 8, subject: "a", message: "   " }, confirm)).rejects.toThrow(/message is empty/);
    expect(shown).toEqual([]);
    expect(wrote(calls)).toEqual([]);
  });

  const replyHandlers = {
    core_enrol_get_users_courses: courses,
    mod_forum_get_forums_by_courses: forums,
    mod_forum_get_discussion_post: () => ({ post: { id: 201, subject: "Duda ejercicio 3", discussionid: 95, author: { fullname: "Ana Profesora" }, capabilities: { reply: true } } }),
    mod_forum_get_discussion_posts: () => ({ forumid: 8, courseid: 10, posts: [{ id: 200, subject: "Dudas del tema 1", parentid: null }, { id: 201, subject: "Duda ejercicio 3", parentid: 200 }] }),
    mod_forum_add_discussion_post: () => ({ postid: 202, warnings: [] }),
  };

  it("replies to a post, showing where it goes", async () => {
    const { client, calls, paramsOf } = fakeMoodle(replyHandlers);
    const { confirm, shown } = fakeConfirm();
    const text = await replyToForumPost(client, { post_id: 201, message: "Gracias, entendido." }, confirm);
    expect(text).toBe("Posted. New reply [post 202] to post 201 in [discussion 95].");
    expect(shown[0]).toContain("RESPONDER");
    expect(shown[0]).toContain("Curso: Cálculo I\nForo: Dudas\nHilo: Dudas del tema 1\nRespondes a: Ana Profesora — «Duda ejercicio 3»\nAsunto: Re: Duda ejercicio 3\nMensaje:\n  │ Gracias, entendido.");
    const sent = paramsOf("mod_forum_add_discussion_post")[0]!;
    expect(sent.get("postid")).toBe("201");
    expect(sent.get("subject")).toBe("Re: Duda ejercicio 3");
    expect(sent.get("message")).toBe("<p>Gracias, entendido.</p>");
    expect(wrote(calls)).toEqual(["mod_forum_add_discussion_post"]);
  });

  it("does not post when declined or not allowed", async () => {
    const declined = fakeMoodle(replyHandlers);
    await expect(replyToForumPost(declined.client, { post_id: 201, message: "x" }, fakeConfirm("no").confirm)).rejects.toThrow(/did not approve/);
    expect(wrote(declined.calls)).toEqual([]);
    const locked = fakeMoodle({ ...replyHandlers, mod_forum_get_discussion_post: () => ({ post: { id: 201, subject: "s", capabilities: { reply: false } } }) });
    await expect(replyToForumPost(locked.client, { post_id: 201, message: "x" }, fakeConfirm().confirm)).rejects.toThrow(/not allowed to reply/);
    expect(wrote(locked.calls)).toEqual([]);
  });

  it("turns Markdown into the HTML Moodle stores", () => {
    expect(markdownToHtml("- uno\n- dos")).toBe("<ul>\n<li>uno</li>\n<li>dos</li>\n</ul>");
    expect(markdownToHtml("línea 1\nlínea 2")).toBe("<p>línea 1<br>línea 2</p>");
  });
});

describe("save_assignment_submission", () => {
  let dir = "";
  let memoria = "";
  let codigo = "";
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "moodle-mcp-test-"));
    memoria = join(dir, "memoria.pdf");
    codigo = join(dir, "codigo.zip");
    await writeFile(memoria, "contenido de la memoria");
    await writeFile(codigo, "contenido del zip");
    await writeFile(join(dir, "vacio.txt"), "");
  });

  const config = (plugin: string, name: string, value: string) => ({ plugin, subtype: "assignsubmission", name, value });
  interface Setup {
    drafts?: number;
    files?: boolean;
    text?: boolean;
    status?: string;
    stored?: { filename: string; filesize: number; fileurl: string; filepath?: string }[];
    storedText?: string;
    extra?: Record<string, unknown>;
    attempt?: Record<string, unknown>;
    types?: string;
    saveResult?: unknown;
  }
  function setup(options: Setup = {}) {
    const assignment = {
      id: 71,
      cmid: 701,
      course: 10,
      name: "Práctica 1",
      duedate: now() + 3 * DAY,
      cutoffdate: 0,
      submissiondrafts: options.drafts ?? 1,
      requiresubmissionstatement: 0,
      teamsubmission: 0,
      configs: [
        config("file", "enabled", options.files === false ? "0" : "1"),
        config("file", "maxfilesubmissions", "3"),
        config("file", "maxsubmissionsizebytes", "1048576"),
        config("file", "filetypeslist", options.types ?? ""),
        config("onlinetext", "enabled", options.text ? "1" : "0"),
      ],
      ...options.extra,
    };
    let saved = false;
    const stored = options.stored ?? [];
    const fake = fakeMoodle(
      {
        core_enrol_get_users_courses: courses,
        mod_assign_get_assignments: () => ({ courses: [{ id: 10, assignments: [assignment] }] }),
        mod_assign_get_submission_status: () => ({
          lastattempt: {
            canedit: true,
            submission: {
              status: saved ? (assignment.submissiondrafts ? "draft" : "submitted") : (options.status ?? "new"),
              plugins: [
                { type: "file", fileareas: [{ area: "submission_files", files: saved ? [...stored, { filename: "memoria.pdf", filesize: 23 }] : stored }] },
                { type: "onlinetext", editorfields: [{ name: "onlinetext", text: options.storedText ?? "" }] },
              ],
            },
            ...options.attempt,
          },
        }),
        core_files_get_unused_draft_itemid: () => ({ itemid: 777 }),
        mod_assign_save_submission: () => {
          saved = true;
          return options.saveResult ?? [];
        },
      },
      { "/webservice/pluginfile.php/9/assignsubmission_file/submission_files/1/anexo.pdf": { body: "anexo anterior", type: "application/pdf" } },
    );
    return fake;
  }
  const anexo = { filename: "anexo.pdf", filesize: 14, fileurl: `${SITE}/webservice/pluginfile.php/9/assignsubmission_file/submission_files/1/anexo.pdf` };

  it("saves a draft, saying that it is not submitted", async () => {
    const { client, calls, uploads, paramsOf } = setup();
    const { confirm, shown } = fakeConfirm();
    const text = await saveAssignmentSubmission(client, { assign_id: 71, files: [memoria] }, confirm);
    expect(shown).toHaveLength(1);
    expect(shown[0]).toContain("Curso: Cálculo I\nTarea: Práctica 1\nFecha límite: ");
    expect(shown[0]).toContain("se guarda como BORRADOR. No queda entregada");
    expect(shown[0]).toContain(`Ficheros que se suben desde tu ordenador (1):\n  + ${memoria} (23 B)`);
    expect(uploads).toEqual([{ name: "memoria.pdf", path: "/", itemid: 5000, text: "contenido de la memoria" }]);
    const sent = paramsOf("mod_assign_save_submission")[0]!;
    expect(sent.get("assignmentid")).toBe("71");
    expect(sent.get("plugindata[files_filemanager]")).toBe("5000");
    expect(sent.has("plugindata[onlinetext_editor][text]")).toBe(false);
    expect(text).toContain('Moodle now reports status "draft"');
    expect(text).toContain("It is a DRAFT: it is NOT submitted.");
    // Saving is the only write: it never presses "Submit assignment".
    expect(wrote(calls)).toEqual(["mod_assign_save_submission"]);
  });

  it("warns that saving is the submission when there is no draft stage", async () => {
    const { client } = setup({ drafts: 0, extra: { cutoffdate: now() + 5 * DAY } });
    const { confirm, shown } = fakeConfirm();
    const text = await saveAssignmentSubmission(client, { assign_id: 71, files: [memoria] }, confirm);
    expect(shown[0]).toContain("ESTA TAREA NO TIENE FASE DE BORRADOR. Al guardar, ESTO CUENTA COMO ENTREGA");
    expect(shown[0]).toMatch(/Podrás modificarla hasta el \S+ \d\d\/\d\d\/\d{4} \d\d:\d\d\./);
    expect(text).toContain("this counts as the submission");
  });

  it("uploads nothing and saves nothing when the user declines", async () => {
    const { client, calls, uploads } = setup();
    await expect(saveAssignmentSubmission(client, { assign_id: 71, files: [memoria] }, fakeConfirm("no").confirm)).rejects.toThrow(/did not approve/);
    expect(uploads).toEqual([]);
    expect(wrote(calls)).toEqual([]);
  });

  it("keeps the files already there by default", async () => {
    const { client, uploads } = setup({ status: "draft", stored: [anexo] });
    const { confirm, shown } = fakeConfirm();
    await saveAssignmentSubmission(client, { assign_id: 71, files: [memoria, codigo] }, confirm);
    expect(shown[0]).toContain("Ficheros que ya estaban y se conservan (1):\n  = /anexo.pdf (14 B)");
    expect(shown[0]).not.toContain("ELIMINAN");
    // The old file is carried over into the same draft area as the new ones.
    expect(uploads.map((upload) => [upload.name, upload.text])).toEqual([
      ["anexo.pdf", "anexo anterior"],
      ["memoria.pdf", "contenido de la memoria"],
      ["codigo.zip", "contenido del zip"],
    ]);
    expect(new Set(uploads.map((upload) => upload.itemid)).size).toBe(1);
  });

  it("replaces a file with the same name, and says so", async () => {
    const same = { ...anexo, filename: "memoria.pdf" };
    const { client, uploads } = setup({ status: "draft", stored: [same] });
    const { confirm, shown } = fakeConfirm();
    await saveAssignmentSubmission(client, { assign_id: 71, files: [memoria] }, confirm);
    expect(shown[0]).toContain("se SUSTITUYEN por tener el mismo nombre (1):\n  ~ memoria.pdf");
    expect(uploads.map((upload) => upload.text)).toEqual(["contenido de la memoria"]);
  });

  it("only drops existing files when asked, and names them", async () => {
    const { client, uploads } = setup({ status: "draft", stored: [anexo] });
    const { confirm, shown } = fakeConfirm();
    await saveAssignmentSubmission(client, { assign_id: 71, files: [memoria], replace_existing: true }, confirm);
    expect(shown[0]).toContain("Ficheros de la entrega que se ELIMINAN (1):\n  - /anexo.pdf (14 B)");
    expect(uploads.map((upload) => upload.name)).toEqual(["memoria.pdf"]);
  });

  it("refuses what is already submitted, graded, locked or closed, before asking", async () => {
    const cases: [Setup, RegExp][] = [
      [{ status: "submitted" }, /already been submitted for grading/],
      [{ drafts: 0, status: "submitted", attempt: { graded: true } }, /already been graded/],
      [{ attempt: { locked: true } }, /does not let the user edit/],
      [{ attempt: { canedit: false } }, /does not let the user edit/],
      [{ extra: { cutoffdate: now() - DAY } }, /stopped accepting submissions/],
      [{ extra: { allowsubmissionsfromdate: now() + DAY } }, /does not accept submissions until/],
      [{ drafts: 0, extra: { requiresubmissionstatement: 1 } }, /submission statement/],
      [{ files: false, text: true }, /does not accept file submissions/],
    ];
    for (const [options, reason] of cases) {
      const { client, calls, uploads } = setup(options);
      const { confirm, shown } = fakeConfirm();
      await expect(saveAssignmentSubmission(client, { assign_id: 71, files: [memoria] }, confirm)).rejects.toThrow(reason);
      expect(shown).toEqual([]);
      expect(uploads).toEqual([]);
      expect(wrote(calls)).toEqual([]);
    }
  });

  it("checks the files before asking", async () => {
    const { confirm, shown } = fakeConfirm();
    const attempt = (files: string[], options: Setup = {}) => saveAssignmentSubmission(setup(options).client, { assign_id: 71, files }, confirm);
    await expect(attempt(["memoria.pdf"])).rejects.toThrow(/not an absolute path/);
    await expect(attempt([join(dir, "no-existe.pdf")])).rejects.toThrow(/File not found/);
    await expect(attempt([dir])).rejects.toThrow(/Not a regular file/);
    await expect(attempt([join(dir, "vacio.txt")])).rejects.toThrow(/File is empty/);
    await expect(attempt([memoria, memoria])).rejects.toThrow(/same name/);
    await expect(attempt([codigo], { types: ".pdf,.docx" })).rejects.toThrow(/not an accepted file type/);
    await expect(attempt([memoria], { extra: { configs: [config("file", "enabled", "1"), config("file", "maxsubmissionsizebytes", "10")] } })).rejects.toThrow(/at most 10 B per file/);
    await expect(attempt([memoria, codigo], { status: "draft", stored: [anexo, { ...anexo, filename: "otro.pdf" }] })).rejects.toThrow(/at most 3 files/);
    await expect(saveAssignmentSubmission(setup().client, { assign_id: 71 }, confirm)).rejects.toThrow(/Pass files/);
    await expect(saveAssignmentSubmission(setup().client, { assign_id: 99, files: [memoria] }, confirm)).rejects.toThrow(/was not found/);
    expect(shown).toEqual([]);
  });

  it("saves online text, keeping the files that were there", async () => {
    const { client, uploads, paramsOf } = setup({ text: true, status: "draft", stored: [anexo], storedText: "<p>Texto viejo</p>" });
    const { confirm, shown } = fakeConfirm();
    await saveAssignmentSubmission(client, { assign_id: 71, text: "Mi **reflexión** final." }, confirm);
    expect(shown[0]).toContain("Texto en línea (SUSTITUYE al que había):\n  │ Mi **reflexión** final.");
    expect(shown[0]).toContain("Ficheros que ya estaban y se conservan (1)");
    expect(uploads.map((upload) => upload.name)).toEqual(["anexo.pdf"]);
    const sent = paramsOf("mod_assign_save_submission")[0]!;
    expect(sent.get("plugindata[onlinetext_editor][text]")).toBe("<p>Mi <strong>reflexión</strong> final.</p>");
    expect(sent.get("plugindata[onlinetext_editor][format]")).toBe("1");
    expect(sent.get("plugindata[files_filemanager]")).toBe("5000");
  });

  it("keeps the text that was there when only files are sent", async () => {
    const { client, paramsOf } = setup({ text: true, status: "draft", storedText: "<p>Texto viejo</p>" });
    const { confirm, shown } = fakeConfirm();
    await saveAssignmentSubmission(client, { assign_id: 71, files: [memoria] }, confirm);
    expect(shown[0]).toContain("El texto en línea que ya había se conserva sin cambios.");
    expect(paramsOf("mod_assign_save_submission")[0]!.get("plugindata[onlinetext_editor][text]")).toBe("<p>Texto viejo</p>");
  });

  it("will not flatten online text that has images embedded in it", async () => {
    const { client, calls, uploads } = setup({ text: true, status: "draft", storedText: '<p><img src="x/pluginfile.php/1/foto.png"></p>' });
    // Same answer as setup(), plus a file stored inside the text itself.
    const original = client.call.bind(client);
    client.call = (async (name: string, params?: never, ttl?: number) => {
      const data = (await original(name, params, ttl)) as { lastattempt?: { submission?: { plugins?: { type: string; fileareas?: unknown[] }[] } } };
      if (name === "mod_assign_get_submission_status") {
        data.lastattempt!.submission!.plugins!.find((plugin) => plugin.type === "onlinetext")!.fileareas = [{ area: "submissions_onlinetext", files: [{ filename: "foto.png" }] }];
      }
      return data;
    }) as typeof client.call;
    const { confirm, shown } = fakeConfirm();
    await expect(saveAssignmentSubmission(client, { assign_id: 71, files: [memoria] }, confirm)).rejects.toThrow(/images or files embedded/);
    expect(shown).toEqual([]);
    expect(uploads).toEqual([]);
    expect(wrote(calls)).toEqual([]);
  });

  it("reports what Moodle refused instead of claiming success", async () => {
    const { client } = setup({ saveResult: [{ item: "Práctica 1", warningcode: "couldnotsavesubmission", message: "No se envió nada" }] });
    await expect(saveAssignmentSubmission(client, { assign_id: 71, files: [memoria] }, fakeConfirm().confirm)).rejects.toThrow(/did not save the submission.*No se envió nada/);
  });
});
