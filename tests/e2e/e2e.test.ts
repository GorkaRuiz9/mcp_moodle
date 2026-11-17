/*
 * End-to-end tests against the throwaway Moodle started by tests/e2e/up.sh.
 * They really write: submissions, forum posts, calendar events. That is why
 * they refuse to run against anything that is not on this machine.
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { beforeAll, describe, expect, it } from "vitest";
import { getCalendarEvents } from "../../src/calendar.js";
import { MoodleClient } from "../../src/moodle.js";
import { getMessages, getNotifications, getRecentChanges } from "../../src/news.js";
import { getCourseParticipants } from "../../src/people.js";
import { getQuizAttempt, listQuizzes } from "../../src/quiz.js";
import { getDiscussion, listAssignments, listForumDiscussions } from "../../src/tools.js";
import {
  addForumDiscussion,
  createCalendarEvent,
  deleteCalendarEvent,
  markNotificationsRead,
  replyToForumPost,
  saveAssignmentSubmission,
  setActivityCompletion,
} from "../../src/writes.js";
import { fakeConfirm } from "../helpers.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const URL_ = `http://localhost:${process.env.MOODLE_E2E_PORT ?? "8099"}`;

if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(URL_)) {
  throw new Error(`The end-to-end tests write to Moodle and only run against a local one, not ${URL_}.`);
}

interface Fixtures {
  course: number;
  assign: Record<"draft" | "direct" | "submitted" | "closed" | "pdfonly" | "textonly" | "statement" | "team", number>;
  forum: { general: number; news: number; discussion: number; firstpost: number };
  cm: { manual: number; automatic: number; none: number };
  quiz: { reviewable: number; unreviewable: number; open: number; attempt_finished: number; attempt_noreview: number; attempt_inprogress: number };
  event: { exam: number };
  notification: { first: number; second: number; third: number };
  conversation: number;
  users: { student: number; mate: number; teacher: number };
}

let ids: Fixtures;
let studentToken = "";
let student: MoodleClient;
let teacher: MoodleClient;
let dir = "";

async function login(username: string, password: string): Promise<string> {
  const response = await fetch(`${URL_}/login/token.php`, {
    method: "POST",
    body: new URLSearchParams({ username, password, service: "moodle_mobile_app" }),
  });
  const data = (await response.json()) as { token?: string; error?: string };
  if (!data.token) throw new Error(`Could not log in as ${username}: ${data.error ?? "no token"}. Is the local Moodle up? Run tests/e2e/up.sh.`);
  return data.token;
}

async function localFile(name: string, content: string | Uint8Array): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, content);
  return path;
}

interface Status {
  lastattempt?: {
    graded?: boolean;
    submission?: { status?: string; plugins?: { type: string; fileareas?: { files?: { filename: string; fileurl: string }[] }[]; editorfields?: { text?: string }[] }[] };
  };
}

/** What Moodle itself says the student's submission holds right now. */
async function submission(assignId: number) {
  const status = await student.call<Status>("mod_assign_get_submission_status", { assignid: assignId });
  const plugins = status.lastattempt?.submission?.plugins ?? [];
  const files = plugins.find((plugin) => plugin.type === "file")?.fileareas?.[0]?.files ?? [];
  return {
    status: status.lastattempt?.submission?.status,
    files: files.map((file) => file.filename).sort(),
    urls: Object.fromEntries(files.map((file) => [file.filename, file.fileurl])),
    text: plugins.find((plugin) => plugin.type === "onlinetext")?.editorfields?.[0]?.text ?? "",
  };
}

const unread = async () => Number(/\((\d+) unread in total\)/.exec(await getNotifications(student, { limit: 50 }))?.[1] ?? 0);

beforeAll(async () => {
  ids = JSON.parse(readFileSync(join(here, ".fixtures.json"), "utf8")) as Fixtures;
  studentToken = await login("student1", "Student.1234");
  student = new MoodleClient({ url: URL_, token: studentToken });
  teacher = new MoodleClient({ url: URL_, token: await login("teacher1", "Teacher.1234") });
  dir = await mkdtemp(join(tmpdir(), "moodle-mcp-e2e-"));
});

describe("reading", () => {
  it("get_recent_changes sees what the teacher added", async () => {
    const text = await getRecentChanges(student, {});
    expect(text).toContain(`## Curso de pruebas E2E [course ${ids.course}]`);
    expect(text).toContain("assign: Práctica con borrador");
    expect(text).toMatch(/forum: Dudas de la asignatura\n(  · .*\n)*  · new forum posts: \[discussion \d+\]/);
    expect(await getRecentChanges(student, { since: new Date(Date.now() + 0).toISOString().slice(0, 10) + " 00:00", course_id: ids.course })).toContain("Changes since");
  });

  it("get_notifications lists them and leaves them unread", async () => {
    const before = await unread();
    const text = await getNotifications(student, { unread_only: true });
    expect(text).toContain(`[notification ${ids.notification.first}] (unread)`);
    expect(text).toContain("Tu práctica ha sido calificada\n  Has obtenido un 8,5 en la práctica 1.");
    expect(before).toBe(3);
    expect(await unread()).toBe(3);
  });

  it("get_messages reads conversations and leaves them unread", async () => {
    const list = await getMessages(student, {});
    expect(list).toContain(`[conversation ${ids.conversation}] Ana Profesora (1 unread)`);
    expect(await getMessages(student, { conversation_id: ids.conversation })).toContain("Ana Profesora:\nHola Sara, ¿puedes pasarte por mi despacho el lunes?");
    expect(await getMessages(student, {})).toContain("(1 unread)");
  });

  it("list_quizzes shows attempts; get_quiz_attempt only opens finished, reviewable ones", async () => {
    const list = await listQuizzes(student, { course_id: ids.course });
    expect(list).toContain(`attempt: [attempt ${ids.quiz.attempt_finished}] #1 finished`);
    expect(list).toContain("grade 6.67 / 10");
    expect(list).toContain(`[attempt ${ids.quiz.attempt_inprogress}] #1 in progress`);
    expect(list).toContain("time limit: 30 min | attempts allowed: 2");

    const review = await getQuizAttempt(student, { attempt_id: ids.quiz.attempt_finished });
    expect(review).toContain("Grade: 6.67");
    expect(review).toMatch(/### Question 1 \(multichoice\) — Incorrect, mark 0\.00 \/ 1\n¿Cuál es la capital de Francia\?/);
    expect(review).toContain("( ) a. París");
    expect(review).toContain("(x) b. Lyon");
    expect(review).toContain("The correct answer is: París");
    expect(review).toContain("[typed: rana]");

    await expect(getQuizAttempt(student, { attempt_id: ids.quiz.attempt_inprogress })).rejects.toThrow(/Only finished attempts can be read/);
    await expect(getQuizAttempt(student, { attempt_id: ids.quiz.attempt_noreview })).rejects.toThrow(/teacher has not made the review/);
    // Reading left the open attempt exactly as it was.
    expect(await listQuizzes(student, { course_id: ids.course })).toContain(`[attempt ${ids.quiz.attempt_inprogress}] #1 in progress`);
  });

  it("get_calendar_events shows course events and activity dates", async () => {
    const text = await getCalendarEvents(student, {});
    expect(text).toMatch(new RegExp(`\\[event ${ids.event.exam}\\] .* \\(lasts 2 h\\): Examen parcial \\(course event\\) — Curso de pruebas E2E \\[course ${ids.course}\\]\\n  Aula 12\\. Traed calculadora\\.`));
    expect(text).toContain("Práctica con borrador is due (assign due)");
    expect(await getCalendarEvents(student, { from: "2031-01-01", days: 5 })).toMatch(/^No calendar events/);
  });

  it("get_course_participants gives the teacher's address, not classmates'", async () => {
    const text = await getCourseParticipants(student, { course_id: ids.course });
    expect(text).toContain("The user's own groups: Grupo A.");
    expect(text).toMatch(/## Teachers \(1\)\n- Ana Profesora — .* — teacher1@example\.com/);
    expect(text).toContain("- Marcos Compañero [groups: Grupo A]");
    expect(text).not.toContain("student2@example.com");
    expect(text).not.toContain("student1@example.com");
  });
});

describe("personal calendar", () => {
  let eventId = 0;

  it("declining creates nothing", async () => {
    await expect(createCalendarEvent(student, { name: "Evento rechazado", start: "2030-03-10 10:00" }, fakeConfirm("no").confirm)).rejects.toThrow(/did not approve/);
    expect(await getCalendarEvents(student, { from: "2030-03-01", days: 30 })).not.toContain("Evento rechazado");
  });

  it("creates a personal event that then shows in the calendar", async () => {
    const { confirm, shown } = fakeConfirm();
    const text = await createCalendarEvent(student, { name: "Repasar para el parcial", start: "2030-03-10 17:00", duration_minutes: 120, description: "Temas **1 a 3**" }, confirm);
    eventId = Number(/\[event (\d+)\]/.exec(text)?.[1]);
    expect(eventId).toBeGreaterThan(0);
    expect(shown[0]).toContain("Empieza: dom 10/03/2030 17:00");
    const calendar = await getCalendarEvents(student, { from: "2030-03-01", days: 30 });
    expect(calendar).toMatch(new RegExp(`\\[event ${eventId}\\] Sun 2030-03-10 17:00 .*\\(lasts 2 h\\): Repasar para el parcial \\(personal\\)\\n  Temas 1 a 3`));
  });

  it("deletes it again, and only after approval", async () => {
    await expect(deleteCalendarEvent(student, { event_id: eventId }, fakeConfirm("no").confirm)).rejects.toThrow(/did not approve/);
    expect(await getCalendarEvents(student, { from: "2030-03-01", days: 30 })).toContain("Repasar para el parcial");
    expect(await deleteCalendarEvent(student, { event_id: eventId }, fakeConfirm().confirm)).toContain("Deleted personal calendar event");
    expect(await getCalendarEvents(student, { from: "2030-03-01", days: 30 })).toMatch(/^No calendar events/);
  });

  it("will not delete the teacher's exam", async () => {
    const { confirm, shown } = fakeConfirm();
    await expect(deleteCalendarEvent(student, { event_id: ids.event.exam }, confirm)).rejects.toThrow(/Only personal events can be deleted/);
    expect(shown).toEqual([]);
    expect(await getCalendarEvents(student, {})).toContain("Examen parcial");
  });
});

describe("activity completion", () => {
  const state = async (cmid: number) => {
    const data = await student.call<{ statuses: { cmid: number; state: number }[] }>("core_completion_get_activities_completion_status", { courseid: ids.course, userid: ids.users.student });
    return data.statuses.find((status) => status.cmid === cmid)?.state;
  };

  it("ticks and unticks an activity the student marks by hand", async () => {
    expect(await state(ids.cm.manual)).toBe(0);
    await expect(setActivityCompletion(student, { cmid: ids.cm.manual, completed: true }, fakeConfirm("no").confirm)).rejects.toThrow(/did not approve/);
    expect(await state(ids.cm.manual)).toBe(0);

    const { confirm, shown } = fakeConfirm();
    expect(await setActivityCompletion(student, { cmid: ids.cm.manual, completed: true }, confirm)).toContain("now marked as completed");
    expect(shown[0]).toContain("Curso: Curso de pruebas E2E\nActividad: Lectura del tema 1 (page)");
    expect(await state(ids.cm.manual)).toBe(1);

    expect(await setActivityCompletion(student, { cmid: ids.cm.manual, completed: true }, confirm)).toContain("already marked as completed");
    expect(shown).toHaveLength(1);

    expect(await setActivityCompletion(student, { cmid: ids.cm.manual, completed: false }, confirm)).toContain("now marked as not completed");
    expect(await state(ids.cm.manual)).toBe(0);
  });

  it("refuses automatic and untracked activities", async () => {
    await expect(setActivityCompletion(student, { cmid: ids.cm.automatic, completed: true }, fakeConfirm().confirm)).rejects.toThrow(/automatically/);
    await expect(setActivityCompletion(student, { cmid: ids.cm.none, completed: true }, fakeConfirm().confirm)).rejects.toThrow(/does not track completion/);
    expect(await state(ids.cm.automatic)).toBe(0);
  });
});

describe("notifications", () => {
  it("marks one as read, then the rest, only after approval", async () => {
    await expect(markNotificationsRead(student, { notification_ids: [ids.notification.first] }, fakeConfirm("no").confirm)).rejects.toThrow(/did not approve/);
    expect(await unread()).toBe(3);

    const one = fakeConfirm();
    expect(await markNotificationsRead(student, { notification_ids: [ids.notification.first] }, one.confirm)).toContain("Marked 1 notification as read");
    expect(one.shown[0]).toContain("— Tu práctica ha sido calificada");
    expect(await unread()).toBe(2);
    expect(await getNotifications(student, {})).toMatch(new RegExp(`\\[notification ${ids.notification.first}\\] \\w{3} `));

    const all = fakeConfirm();
    expect(await markNotificationsRead(student, { all: true }, all.confirm)).toBe("Marked 2 notifications as read.");
    expect(all.shown[0]).toContain("(2)");
    expect(await unread()).toBe(0);
    expect(await markNotificationsRead(student, { all: true }, all.confirm)).toContain("no unread notifications");
  });
});

describe("forums", () => {
  it("starts a discussion where students may post", async () => {
    await expect(addForumDiscussion(student, { forum_id: ids.forum.general, subject: "Hilo rechazado", message: "No debería publicarse" }, fakeConfirm("no").confirm)).rejects.toThrow(/did not approve/);
    expect(await listForumDiscussions(student, { forum_id: ids.forum.general })).not.toContain("Hilo rechazado");

    const { confirm, shown } = fakeConfirm();
    const text = await addForumDiscussion(student, { forum_id: ids.forum.general, subject: "Duda sobre la entrega", message: "Hola:\n\n¿Se puede entregar en **PDF**?\n\n- opción a\n- opción b" }, confirm);
    const discussionId = Number(/\[discussion (\d+)\]/.exec(text)?.[1]);
    expect(shown[0]).toContain("Curso: Curso de pruebas E2E\nForo: Dudas de la asignatura\nAsunto: Duda sobre la entrega");
    expect(await listForumDiscussions(student, { forum_id: ids.forum.general })).toContain(`[discussion ${discussionId}] Duda sobre la entrega — Sara Estudiante`);
    const thread = await getDiscussion(student, { discussion_id: discussionId });
    expect(thread).toContain("¿Se puede entregar en PDF?");
    expect(thread).toContain("- opción a\n- opción b");
  });

  it("replies to the teacher's post", async () => {
    const { confirm, shown } = fakeConfirm();
    const text = await replyToForumPost(student, { post_id: ids.forum.firstpost, message: "Tengo una duda con el *ejercicio 2*." }, confirm);
    expect(text).toMatch(/New reply \[post \d+\] to post \d+ in \[discussion \d+\]/);
    expect(shown[0]).toContain("Foro: Dudas de la asignatura\nHilo: Dudas sobre la práctica 1\nRespondes a: Ana Profesora — «Dudas sobre la práctica 1»\nAsunto: Re: Dudas sobre la práctica 1");
    const thread = await getDiscussion(student, { discussion_id: ids.forum.discussion });
    expect(thread).toMatch(/Re: Dudas sobre la práctica 1 — Sara Estudiante, .* \(reply to post \d+\)\nTengo una duda con el ejercicio 2\./);
  });

  it("cannot post in the announcements forum", async () => {
    const { confirm, shown } = fakeConfirm();
    await expect(addForumDiscussion(student, { forum_id: ids.forum.news, subject: "x", message: "y" }, confirm)).rejects.toThrow(/not allowed to start discussions/);
    expect(shown).toEqual([]);
  });
});

describe("assignment submissions", () => {
  it("declining leaves the assignment untouched", async () => {
    const file = await localFile("rechazado.txt", "no debería subirse");
    await expect(saveAssignmentSubmission(student, { assign_id: ids.assign.draft, files: [file] }, fakeConfirm("no").confirm)).rejects.toThrow(/did not approve/);
    expect(await submission(ids.assign.draft)).toMatchObject({ status: "new", files: [] });
  });

  it("saves a draft and never submits it", async () => {
    const memoria = await localFile("memoria.pdf", "%PDF-1.4 primera versión");
    const { confirm, shown } = fakeConfirm();
    const text = await saveAssignmentSubmission(student, { assign_id: ids.assign.draft, files: [memoria] }, confirm);
    expect(shown[0]).toContain("Tarea: Práctica con borrador");
    expect(shown[0]).toContain("se guarda como BORRADOR");
    expect(text).toContain('status "draft"');
    expect(text).toContain("Files in the submission (1): memoria.pdf");
    expect(await submission(ids.assign.draft)).toMatchObject({ status: "draft", files: ["memoria.pdf"] });
    expect(await listAssignments(student, { course_id: ids.course })).toMatch(/Práctica con borrador[^\n]*\n[^\n]*\n  submission: draft saved but NOT submitted/);
  });

  it("adds files next to the ones already there, and replaces same-named ones", async () => {
    const codigo = await localFile("codigo.zip", "PK primer zip");
    const first = fakeConfirm();
    await saveAssignmentSubmission(student, { assign_id: ids.assign.draft, files: [codigo] }, first.confirm);
    expect(first.shown[0]).toContain("Ficheros que ya estaban y se conservan (1):\n  = /memoria.pdf");
    expect((await submission(ids.assign.draft)).files).toEqual(["codigo.zip", "memoria.pdf"]);

    const nueva = await localFile("memoria.pdf", "%PDF-1.4 segunda versión, más larga");
    const second = fakeConfirm();
    await saveAssignmentSubmission(student, { assign_id: ids.assign.draft, files: [nueva] }, second.confirm);
    expect(second.shown[0]).toContain("se SUSTITUYEN por tener el mismo nombre (1):\n  ~ memoria.pdf");
    const after = await submission(ids.assign.draft);
    expect(after.files).toEqual(["codigo.zip", "memoria.pdf"]);
    // The kept file survived the round trip byte for byte, and the replaced one is the new version.
    const decode = async (name: string) => new TextDecoder().decode((await student.download(after.urls[name]!, 1e6)).data);
    expect(await decode("memoria.pdf")).toBe("%PDF-1.4 segunda versión, más larga");
    expect(await decode("codigo.zip")).toBe("PK primer zip");
  });

  it("respects the limit of files and only drops files when asked", async () => {
    const extra = [await localFile("anexo1.pdf", "a"), await localFile("anexo2.pdf", "b")];
    await expect(saveAssignmentSubmission(student, { assign_id: ids.assign.draft, files: extra }, fakeConfirm().confirm)).rejects.toThrow(/at most 3 files/);
    const { confirm, shown } = fakeConfirm();
    await saveAssignmentSubmission(student, { assign_id: ids.assign.draft, files: extra, replace_existing: true }, confirm);
    expect(shown[0]).toContain("Ficheros de la entrega que se ELIMINAN (2):");
    expect((await submission(ids.assign.draft)).files).toEqual(["anexo1.pdf", "anexo2.pdf"]);
  });

  it("saves online text and keeps the files", async () => {
    const { confirm } = fakeConfirm();
    await saveAssignmentSubmission(student, { assign_id: ids.assign.draft, text: "Mi **reflexión** sobre la práctica." }, confirm);
    const after = await submission(ids.assign.draft);
    expect(after.text).toContain("<strong>reflexión</strong>");
    expect(after.files).toEqual(["anexo1.pdf", "anexo2.pdf"]);
    expect(after.status).toBe("draft");

    // And the other way round: new files keep the text.
    const otro = await localFile("anexo3.pdf", "c");
    const again = fakeConfirm();
    await saveAssignmentSubmission(student, { assign_id: ids.assign.draft, files: [otro] }, again.confirm);
    expect(again.shown[0]).toContain("El texto en línea que ya había se conserva sin cambios.");
    const final = await submission(ids.assign.draft);
    expect(final.text).toContain("<strong>reflexión</strong>");
    expect(final.files).toEqual(["anexo1.pdf", "anexo2.pdf", "anexo3.pdf"]);
  });

  it("refuses files that are too big before asking", async () => {
    const big = await localFile("enorme.pdf", new Uint8Array(1024 * 1024 + 10));
    const { confirm, shown } = fakeConfirm();
    await expect(saveAssignmentSubmission(student, { assign_id: ids.assign.pdfonly, files: [big] }, confirm)).rejects.toThrow(/accepts at most 1\.0 MB per file/);
    expect(shown).toEqual([]);
  });

  it("checks accepted file types", async () => {
    const notes = await localFile("notas.txt", "texto");
    await expect(saveAssignmentSubmission(student, { assign_id: ids.assign.pdfonly, files: [notes] }, fakeConfirm().confirm)).rejects.toThrow(/not an accepted file type/);
    const pdf = await localFile("informe.pdf", "%PDF-1.4 informe");
    const { confirm, shown } = fakeConfirm();
    await saveAssignmentSubmission(student, { assign_id: ids.assign.pdfonly, files: [pdf] }, confirm);
    expect(shown[0]).toContain("Tipos de fichero que acepta la tarea: .pdf");
    expect((await submission(ids.assign.pdfonly)).files).toEqual(["informe.pdf"]);
  });

  it("warns that saving is submitting when there is no draft stage", async () => {
    const file = await localFile("entrega.pdf", "%PDF-1.4 entrega directa");
    const { confirm, shown } = fakeConfirm();
    const text = await saveAssignmentSubmission(student, { assign_id: ids.assign.direct, files: [file] }, confirm);
    expect(shown[0]).toContain("ESTA TAREA NO TIENE FASE DE BORRADOR. Al guardar, ESTO CUENTA COMO ENTREGA");
    expect(shown[0]).toMatch(/Podrás modificarla hasta el \S+ \d\d\/\d\d\/\d{4}/);
    expect(text).toContain('status "submitted"');
    expect(text).toContain("this counts as the submission");
    expect(await submission(ids.assign.direct)).toMatchObject({ status: "submitted", files: ["entrega.pdf"] });

    // Still open and not graded: it can be corrected.
    const fixed = await localFile("entrega.pdf", "%PDF-1.4 entrega directa corregida");
    await saveAssignmentSubmission(student, { assign_id: ids.assign.direct, files: [fixed] }, fakeConfirm().confirm);
    expect((await submission(ids.assign.direct)).files).toEqual(["entrega.pdf"]);
  });

  it("does not touch it once the teacher has graded it", async () => {
    await teacher.call("mod_assign_save_grade", {
      assignmentid: ids.assign.direct,
      userid: ids.users.student,
      grade: 80,
      attemptnumber: -1,
      addattempt: false,
      workflowstate: "",
      applytoall: false,
      plugindata: { assignfeedbackcomments_editor: { text: "Bien", format: 1 } },
    });
    student.clearCache();
    const file = await localFile("tarde.pdf", "%PDF-1.4");
    const { confirm, shown } = fakeConfirm();
    await expect(saveAssignmentSubmission(student, { assign_id: ids.assign.direct, files: [file] }, confirm)).rejects.toThrow(/already been graded/);
    expect(shown).toEqual([]);
    expect((await submission(ids.assign.direct)).files).toEqual(["entrega.pdf"]);
  });

  it("does not touch an assignment already submitted for grading", async () => {
    // The test itself plays the student pressing "Submit assignment" on the website.
    const file = await localFile("final.pdf", "%PDF-1.4 final");
    await saveAssignmentSubmission(student, { assign_id: ids.assign.submitted, files: [file] }, fakeConfirm().confirm);
    await student.call("mod_assign_submit_for_grading", { assignmentid: ids.assign.submitted, acceptsubmissionstatement: true });
    expect((await submission(ids.assign.submitted)).status).toBe("submitted");

    const other = await localFile("otro.pdf", "%PDF-1.4 otro");
    const { confirm, shown } = fakeConfirm();
    await expect(saveAssignmentSubmission(student, { assign_id: ids.assign.submitted, files: [other] }, confirm)).rejects.toThrow(/already been submitted for grading/);
    expect(shown).toEqual([]);
    expect((await submission(ids.assign.submitted)).files).toEqual(["final.pdf"]);
  });

  it("refuses closed assignments and ones that need a submission statement", async () => {
    const file = await localFile("x.pdf", "%PDF-1.4");
    await expect(saveAssignmentSubmission(student, { assign_id: ids.assign.closed, files: [file] }, fakeConfirm().confirm)).rejects.toThrow(/stopped accepting submissions/);
    await expect(saveAssignmentSubmission(student, { assign_id: ids.assign.statement, files: [file] }, fakeConfirm().confirm)).rejects.toThrow(/submission statement/);
    expect((await submission(ids.assign.statement)).files).toEqual([]);
  });

  it("says when a submission belongs to the whole group, and saves it for the group", async () => {
    const file = await localFile("trabajo.pdf", "%PDF-1.4 trabajo del grupo");
    const { confirm, shown } = fakeConfirm();
    const text = await saveAssignmentSubmission(student, { assign_id: ids.assign.team, files: [file] }, confirm);
    expect(shown[0]).toContain("Es una entrega EN GRUPO: lo que guardes afecta a la entrega de todo tu grupo.");
    expect(text).toContain("Files in the submission (1): trabajo.pdf");
    // The classmate in the same group now sees that file in the shared draft.
    const mate = new MoodleClient({ url: URL_, token: await login("student2", "Student.1234") });
    const seen = await mate.call<{ lastattempt?: { teamsubmission?: { status?: string; plugins?: { type: string; fileareas?: { files?: { filename: string }[] }[] }[] } } }>(
      "mod_assign_get_submission_status",
      { assignid: ids.assign.team },
    );
    expect(seen.lastattempt?.teamsubmission?.status).toBe("draft");
    expect(seen.lastattempt?.teamsubmission?.plugins?.find((plugin) => plugin.type === "file")?.fileareas?.[0]?.files?.map((f) => f.filename)).toEqual(["trabajo.pdf"]);

    // A second save keeps the group's file.
    const more = await localFile("anexo-grupo.pdf", "%PDF-1.4 anexo");
    const again = fakeConfirm();
    const second = await saveAssignmentSubmission(student, { assign_id: ids.assign.team, files: [more] }, again.confirm);
    expect(again.shown[0]).toContain("Ficheros que ya estaban y se conservan (1):\n  = /trabajo.pdf");
    expect(second).toContain("Files in the submission (2): ");
  });

  it("handles a text-only assignment", async () => {
    const file = await localFile("y.pdf", "%PDF-1.4");
    await expect(saveAssignmentSubmission(student, { assign_id: ids.assign.textonly, files: [file] }, fakeConfirm().confirm)).rejects.toThrow(/does not accept file submissions/);
    const { confirm, shown } = fakeConfirm();
    await saveAssignmentSubmission(student, { assign_id: ids.assign.textonly, text: "Primera línea.\n\nSegunda línea." }, confirm);
    expect(shown[0]).toContain("Texto en línea:\n  │ Primera línea.");
    const after = await submission(ids.assign.textonly);
    expect(after.status).toBe("submitted");
    expect(after.text).toContain("<p>Segunda línea.</p>");
  });
});

describe("the real server over stdio", () => {
  type Answer = { action: "accept" | "decline"; content?: Record<string, unknown> };

  async function start(write: string | undefined, answer?: Answer) {
    const env: Record<string, string> = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", MOODLE_URL: URL_, MOODLE_TOKEN: studentToken, MOODLE_MCP_CACHE_DIR: join(dir, "cache") };
    if (write !== undefined) env.MOODLE_MCP_WRITE = write;
    const transport = new StdioClientTransport({ command: process.execPath, args: [join(root, "dist", "cli.js")], env, stderr: "pipe" });
    const client = new Client({ name: "e2e", version: "1.0.0" }, { capabilities: answer ? { elicitation: {} } : {} });
    const prompts: string[] = [];
    if (answer) {
      client.setRequestHandler(ElicitRequestSchema, async (request) => {
        prompts.push(request.params.message);
        return answer;
      });
    }
    await client.connect(transport);
    return { client, prompts };
  }
  const text = (result: unknown) => (result as { content: { text: string }[] }).content[0]!.text;

  it("serves 16 read-only tools by default", async () => {
    const { client } = await start(undefined);
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(16);
    expect(tools.every((tool) => tool.annotations?.readOnlyHint)).toBe(true);
    const courses = await client.callTool({ name: "list_courses", arguments: {} });
    expect(text(courses)).toContain("Curso de pruebas E2E");
    const people = await client.callTool({ name: "get_course_participants", arguments: { course_id: String(ids.course), only_teachers: true } });
    expect(text(people)).toContain("Ana Profesora");
    await client.close();
  });

  it("with MOODLE_MCP_WRITE, writes only after the prompt is accepted", async () => {
    const accepted = await start("calendario", { action: "accept", content: { confirmar: true } });
    expect((await accepted.client.listTools()).tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(["create_calendar_event", "delete_calendar_event"]));
    expect((await accepted.client.listTools()).tools).toHaveLength(18);
    const created = await accepted.client.callTool({ name: "create_calendar_event", arguments: { name: "Tutoría con Ana", start: "2030-05-06 12:00", duration_minutes: 30 } });
    expect(created.isError).toBeFalsy();
    expect(accepted.prompts[0]).toContain("Nombre: Tutoría con Ana\nEmpieza: lun 06/05/2030 12:00\nDuración: 30 min");
    const eventId = /\[event (\d+)\]/.exec(text(created))![1];
    expect(text(await accepted.client.callTool({ name: "get_calendar_events", arguments: { from: "2030-05-01", days: 10 } }))).toContain("Tutoría con Ana (personal)");
    await accepted.client.close();

    const declined = await start("calendario", { action: "decline" });
    const refused = await declined.client.callTool({ name: "delete_calendar_event", arguments: { event_id: eventId } });
    expect(refused.isError).toBe(true);
    expect(text(refused)).toContain("did not approve");
    expect(text(await declined.client.callTool({ name: "get_calendar_events", arguments: { from: "2030-05-01", days: 10 } }))).toContain("Tutoría con Ana");
    await declined.client.close();

    const mute = await start("calendario");
    const blocked = await mute.client.callTool({ name: "delete_calendar_event", arguments: { event_id: eventId } });
    expect(blocked.isError).toBe(true);
    expect(text(blocked)).toContain("this MCP client cannot show one");
    expect(text(await mute.client.callTool({ name: "get_calendar_events", arguments: { from: "2030-05-01", days: 10 } }))).toContain("Tutoría con Ana");
    await mute.client.close();
  });

  it("refuses to start with a misspelt group", async () => {
    const child = spawn(process.execPath, [join(root, "dist", "cli.js")], { env: { PATH: process.env.PATH ?? "", MOODLE_URL: URL_, MOODLE_TOKEN: studentToken, MOODLE_MCP_WRITE: "entregas,foro" } });
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += String(chunk)));
    const code = await new Promise((resolve) => child.on("exit", resolve));
    expect(code).toBe(1);
    expect(stderr).toContain('unknown group "foro"');
  });
});
