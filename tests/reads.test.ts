import { describe, expect, it } from "vitest";
import { getCalendarEvents } from "../src/calendar.js";
import { getMessages, getNotifications, getRecentChanges } from "../src/news.js";
import { getCourseParticipants } from "../src/people.js";
import { getQuizAttempt, listQuizzes } from "../src/quiz.js";
import { DAY, fakeMoodle, now, SITE } from "./helpers.js";

const courses = () => [
  { id: 10, fullname: "Cálculo I", shortname: "CALC1", enddate: now() + 60 * DAY },
  { id: 12, fullname: "Historia antigua", shortname: "HIST", enddate: now() - 200 * DAY },
];

describe("get_recent_changes", () => {
  const contents = () => [
    {
      id: 1,
      name: "Tema 1",
      section: 1,
      modules: [
        {
          id: 501,
          name: "Apuntes",
          modname: "resource",
          instance: 31,
          contents: [
            { type: "file", filename: "nuevo.pdf", filesize: 2048, timemodified: now() - DAY, fileurl: `${SITE}/webservice/pluginfile.php/9/mod_resource/content/2/nuevo.pdf?forcedownload=1` },
            { type: "file", filename: "viejo.pdf", filesize: 1024, timemodified: now() - 90 * DAY, fileurl: `${SITE}/webservice/pluginfile.php/9/mod_resource/content/1/viejo.pdf` },
          ],
        },
        { id: 502, name: "Avisos", modname: "forum", instance: 8 },
      ],
    },
  ];
  const updates = () => ({
    instances: [
      { contextlevel: "module", id: 501, updates: [{ name: "configuration", timeupdated: now() - DAY }, { name: "contentfiles", itemids: [1] }] },
      { contextlevel: "module", id: 502, updates: [{ name: "discussions", itemids: [90, 91] }] },
      { contextlevel: "module", id: 777, updates: [{ name: "somethingnew" }] },
      { contextlevel: "module", id: 503, updates: [] },
    ],
  });

  it("names what changed, the new files and the new discussions", async () => {
    const { client, paramsOf } = fakeMoodle({ core_enrol_get_users_courses: courses, core_course_get_updates_since: updates, core_course_get_contents: contents });
    const text = await getRecentChanges(client, {});
    expect(text).toContain("## Cálculo I [course 10] — 3 changed");
    expect(text).toContain("- [cmid 501, resource 31] resource: Apuntes\n  · added, or its settings or description changed (");
    expect(text).toContain("· file: nuevo.pdf (2.0 KB, ");
    expect(text).toContain("/content/2/nuevo.pdf\n");
    expect(text).not.toContain("viejo.pdf");
    expect(text).toContain("· new forum posts: [discussion 90], [discussion 91]");
    expect(text).toContain("- [cmid 777] (not in the visible course contents)\n  · somethingnew");
    // Past courses are not checked, and the default window is a week.
    const asked = paramsOf("core_course_get_updates_since");
    expect(asked.map((p) => p.get("courseid"))).toEqual(["10"]);
    expect(now() - Number(asked[0]!.get("since"))).toBeGreaterThanOrEqual(7 * DAY - 5);
    expect(now() - Number(asked[0]!.get("since"))).toBeLessThanOrEqual(7 * DAY + 5);
  });

  it("takes a date and keeps no state between calls", async () => {
    const { client, paramsOf } = fakeMoodle({ core_enrol_get_users_courses: courses, core_course_get_updates_since: () => ({ instances: [] }) });
    const text = await getRecentChanges(client, { since: "2026-01-15", course_id: 10 });
    expect(text).toContain("Nothing has changed since Thu 2026-01-15 00:00 (1 course checked).");
    expect(paramsOf("core_course_get_updates_since")[0]!.get("since")).toBe(String(Math.floor(new Date(2026, 0, 15).getTime() / 1000)));
    await getRecentChanges(client, {});
    expect(Number(paramsOf("core_course_get_updates_since")[1]!.get("since"))).toBeGreaterThan(now() - 8 * DAY);
  });

  it("rejects dates it cannot read, and dates in the future", async () => {
    const { client } = fakeMoodle({ core_enrol_get_users_courses: courses });
    await expect(getRecentChanges(client, { since: "last week" })).rejects.toThrow(/not a date/);
    await expect(getRecentChanges(client, { since: "2999-01-01" })).rejects.toThrow(/future/);
  });

  it("reports the courses it could not check", async () => {
    const { client } = fakeMoodle({ core_enrol_get_users_courses: courses, core_course_get_updates_since: () => ({ exception: "x", errorcode: "nopermissions", message: "no" }) });
    expect(await getRecentChanges(client, {})).toContain("Could not check: Cálculo I.");
  });
});

describe("get_notifications", () => {
  const page = () => ({
    unreadcount: 1,
    notifications: [
      { id: 3, subject: "Tarea calificada", fullmessage: "Curso -> Tarea\n-----------------------------\nTienes un 8", contexturl: `${SITE}/mod/assign/view.php?id=1`, timecreated: now() - 3600, read: false, useridfrom: -10, userfromfullname: "No reply" },
      { id: 2, subject: "Cambio de aula", smallmessage: "Cambio de aula", timecreated: now() - DAY, read: true, useridfrom: 4, userfromfullname: "Ana Profesora" },
    ],
  });

  it("lists them without marking anything as read", async () => {
    const { client, calls } = fakeMoodle({ message_popup_get_popup_notifications: page });
    const text = await getNotifications(client, {});
    expect(text).toContain("2 notifications, newest first (1 unread in total).");
    expect(text).toContain("does not mark them as read");
    expect(text).toMatch(/- \[notification 3\] \(unread\) .* — Tarea calificada\n  Curso -> Tarea — Tienes un 8\n  https:\/\/moodle\.example\/mod\/assign\/view\.php\?id=1/);
    expect(text).toMatch(/- \[notification 2\] \S+ \S+ \S+ — Cambio de aula — from Ana Profesora$/m);
    expect(text).not.toContain("No reply");
    // Only the reading function was used.
    expect(calls.filter((name) => name !== "core_webservice_get_site_info")).toEqual(["message_popup_get_popup_notifications"]);
  });

  it("can keep only the unread ones", async () => {
    const { client, paramsOf } = fakeMoodle({ message_popup_get_popup_notifications: page });
    const text = await getNotifications(client, { unread_only: true, limit: 5 });
    expect(text).toContain("1 unread notifications");
    expect(text).not.toContain("Cambio de aula");
    // Looks further back than the limit, since read ones are filtered out afterwards.
    expect(paramsOf("message_popup_get_popup_notifications")[0]!.get("limit")).toBe("100");
    expect(paramsOf("message_popup_get_popup_notifications")[0]!.get("useridto")).toBe("7");
  });

  it("says when there are none", async () => {
    const { client } = fakeMoodle({ message_popup_get_popup_notifications: () => ({ notifications: [], unreadcount: 0 }) });
    expect(await getNotifications(client, { unread_only: true })).toBe("No unread notifications.");
  });
});

describe("get_messages", () => {
  const members = [
    { id: 7, fullname: "Test Student" },
    { id: 4, fullname: "Ana Profesora" },
  ];

  it("lists conversations with the last message", async () => {
    const { client } = fakeMoodle({
      core_message_get_conversations: () => ({
        conversations: [
          { id: 40, name: "", type: 1, unreadcount: 2, members: [members[1]], messages: [{ id: 1, useridfrom: 4, text: "<p>¿Vienes a tutoría?</p>", timecreated: now() - 60 }] },
          { id: 41, name: "Grupo de prácticas", type: 2, membercount: 5, unreadcount: null, members: [], messages: [{ id: 2, useridfrom: 7, text: "Hecho", timecreated: now() - DAY }] },
        ],
      }),
    });
    const text = await getMessages(client, {});
    expect(text).toMatch(/- \[conversation 40\] Ana Profesora \(2 unread\)\n  last message, .*, Ana Profesora: ¿Vienes a tutoría\?/);
    expect(text).toMatch(/- \[conversation 41\] Grupo de prácticas, group of 5\n  last message, .*, you: Hecho/);
  });

  it("prints one conversation oldest first", async () => {
    const { client, paramsOf } = fakeMoodle({
      core_message_get_conversation_messages: () => ({
        id: 40,
        members,
        messages: [
          { id: 2, useridfrom: 7, text: "Sí, voy", timecreated: 2000 },
          { id: 1, useridfrom: 4, text: "<p>¿Vienes a tutoría?</p>", timecreated: 1000 },
        ],
      }),
    });
    const text = await getMessages(client, { conversation_id: 40 });
    expect(text.indexOf("Ana Profesora:\n¿Vienes a tutoría?")).toBeGreaterThan(0);
    expect(text.indexOf("Ana Profesora:")).toBeLessThan(text.indexOf("You:\nSí, voy"));
    expect(paramsOf("core_message_get_conversation_messages")[0]!.get("convid")).toBe("40");
  });

  it("explains a site with messaging switched off", async () => {
    const { client } = fakeMoodle({ core_message_get_conversations: () => ({ exception: "moodle_exception", errorcode: "disabled", message: "La mensajería está deshabilitada" }) });
    await expect(getMessages(client, {})).rejects.toThrow(/switched off on this Moodle site/);
  });
});

describe("quizzes", () => {
  const quizzes = () => ({
    quizzes: [
      { id: 60, coursemodule: 601, course: 10, name: "Test tema 1", timeopen: now() - 10 * DAY, timeclose: now() - DAY, attempts: 1, sumgrades: 4, grade: 10, intro: "<p>Diez preguntas</p>" },
      { id: 61, coursemodule: 602, course: 10, name: "Test tema 2", timeopen: now() + DAY, timeclose: now() + 5 * DAY, timelimit: 1800, attempts: 0, sumgrades: 4, grade: 10 },
    ],
  });
  const attempts = (params: URLSearchParams) =>
    params.get("quizid") === "60"
      ? { attempts: [{ id: 900, quiz: 60, attempt: 1, state: "finished", timefinish: now() - 2 * DAY, sumgrades: 3 }, { id: 901, quiz: 60, attempt: 2, state: "inprogress", timestart: now() - 60 }] }
      : { attempts: [] };

  it("lists quizzes with the user's attempts and grades", async () => {
    const { client } = fakeMoodle({
      core_enrol_get_users_courses: courses,
      mod_quiz_get_quizzes_by_courses: quizzes,
      mod_quiz_get_user_attempts: attempts,
      mod_quiz_get_user_best_grade: (params) => (params.get("quizid") === "60" ? { hasgrade: true, grade: 7.5 } : { hasgrade: false }),
    });
    const text = await listQuizzes(client, {});
    expect(text).toContain("- [quiz 60, cmid 601] Test tema 1 — Cálculo I [course 10]");
    expect(text).toMatch(/opened: .* \| closes: .* \(\d+ \w+ ago\) \| attempts allowed: 1\n  best grade: 7\.50 \/ 10\n  attempt: \[attempt 900\] #1 finished .*, grade 7\.50 \/ 10\n  attempt: \[attempt 901\] #2 in progress since .* \(questions cannot be read here until it is finished\)\n  Diez preguntas/);
    expect(text).toMatch(/opens: .* \| closes: .* \(in 5 d\) \| time limit: 30 min \| attempts allowed: unlimited\n  attempts: none yet/);
  });

  const review = (state: string) => ({
    grade: "7,50",
    attempt: { id: 900, quiz: 60, state, timefinish: now() - 2 * DAY },
    additionaldata: [{ id: "feedback", title: "Comentario", content: "<p>Buen trabajo</p>" }],
    questions: [
      {
        slot: 1,
        type: "multichoice",
        questionnumber: "1",
        status: "Incorrecta",
        mark: "0,00",
        maxmark: 1,
        html:
          '<div class="que multichoice"><div class="info"><h3 class="no">Pregunta <span class="qno">1</span></h3><div class="state">Incorrecta</div></div>' +
          '<div class="content"><div class="formulation"><h4 class="accesshide">Texto de la pregunta</h4><div class="qtext"><p>¿Capital de Francia?</p></div>' +
          '<div class="answer"><div class="r0"><input type="radio" name="q1:1_answer" value="0" disabled="disabled" /><div class="flex-fill">a. París</div></div>' +
          '<div class="r1 incorrect"><input type="radio" name="q1:1_answer" value="1" checked="checked" disabled="disabled" /><div class="flex-fill">b. Lyon</div> <i class="icon fa fa-remove text-danger" title="Incorrecta" aria-label="Incorrecta"></i></div></div></div>' +
          '<div class="outcome"><div class="feedback"><div class="rightanswer">La respuesta correcta es: París</div></div></div></div></div>',
      },
      { slot: 2, type: "shortanswer", number: 2, status: "Correcta", mark: "1,00", maxmark: 1, html: '<div class="content"><div class="qtext">Animal verde</div><input type="text" name="q1:2_answer" value="rana" readonly /></div>' },
    ],
  });

  it("shows a finished attempt with the answers given and the right ones", async () => {
    const { client, calls } = fakeMoodle({ mod_quiz_get_attempt_review: () => review("finished") });
    const text = await getQuizAttempt(client, { attempt_id: 900 });
    expect(text).toContain("Review of attempt 900 (quiz 60), finished");
    expect(text).toContain("Grade: 7,50\nComentario: Buen trabajo");
    expect(text).toContain("### Question 1 (multichoice) — Incorrecta, mark 0,00 / 1\n¿Capital de Francia?");
    expect(text).toContain("( ) a. París");
    expect(text).toContain("(x) b. Lyon\n[Incorrecta]");
    expect(text).toContain("La respuesta correcta es: París");
    expect(text).not.toContain("Texto de la pregunta");
    expect(text).toContain("### Question 2 (shortanswer) — Correcta, mark 1,00 / 1\nAnimal verde\n[typed: rana]");
    // Only the review function: nothing that reads or changes an open attempt.
    expect(calls).toEqual(["mod_quiz_get_attempt_review"]);
  });

  it("never shows the questions of an attempt that is still open", async () => {
    const open = fakeMoodle({ mod_quiz_get_attempt_review: () => review("inprogress") });
    await expect(getQuizAttempt(open.client, { attempt_id: 901 })).rejects.toThrow(/not finished/);
    const refused = fakeMoodle({ mod_quiz_get_attempt_review: () => ({ exception: "moodle_exception", errorcode: "attemptclosed", message: "x" }) });
    await expect(getQuizAttempt(refused.client, { attempt_id: 901 })).rejects.toThrow(/Only finished attempts/);
  });

  it("explains a review the teacher has not released", async () => {
    const { client } = fakeMoodle({ mod_quiz_get_attempt_review: () => ({ exception: "moodle_exception", errorcode: "noreview", message: "No está autorizado" }) });
    await expect(getQuizAttempt(client, { attempt_id: 900 })).rejects.toThrow(/teacher has not made the review/);
  });
});

describe("get_calendar_events", () => {
  const events = () => ({
    events: [
      { id: 2, name: "Vencimiento de Entrega 1", description: "<p>larga</p>", courseid: 10, modulename: "assign", eventtype: "due", timestart: now() + 3 * DAY, timeduration: 0 },
      { id: 1, name: "Examen parcial", description: "<p>Aula 12</p>", courseid: 10, eventtype: "course", timestart: now() + 2 * DAY, timeduration: 7200 },
      { id: 3, name: "Dentista", description: "", courseid: 0, userid: 7, eventtype: "user", timestart: now() + 4 * DAY, timeduration: 0 },
    ],
  });
  const handlers = { core_enrol_get_users_courses: courses, core_group_get_course_user_groups: () => ({ groups: [{ id: 33 }] }), core_calendar_get_calendar_events: events };

  it("lists every kind of event in the period, soonest first", async () => {
    const { client, paramsOf } = fakeMoodle(handlers);
    const text = await getCalendarEvents(client, { days: 10 });
    expect(text).toContain("3 calendar events from ");
    expect(text).toMatch(/- \[event 1\] .* \(in 2 d\) \(lasts 2 h\): Examen parcial \(course event\) — Cálculo I \[course 10\]\n  Aula 12/);
    expect(text).toMatch(/- \[event 2\] .*: Vencimiento de Entrega 1 \(assign due\) — Cálculo I \[course 10\]\n- \[event 3\]/);
    expect(text).toMatch(/- \[event 3\] .*: Dentista \(personal\)$/m);
    const sent = paramsOf("core_calendar_get_calendar_events")[0]!;
    // Courses and groups have to be named, or Moodle leaves their events out.
    expect(sent.get("events[courseids][0]")).toBe("10");
    expect(sent.get("events[groupids][0]")).toBe("33");
    expect(sent.get("options[userevents]")).toBe("1");
    expect(Number(sent.get("options[timeend]")) - Number(sent.get("options[timestart]"))).toBe(10 * DAY);
  });

  it("can start at a date and stick to one course", async () => {
    const { client, paramsOf } = fakeMoodle(handlers);
    const text = await getCalendarEvents(client, { from: "2026-12-01", course_id: 10 });
    const sent = paramsOf("core_calendar_get_calendar_events")[0]!;
    expect(sent.get("options[timestart]")).toBe(String(Math.floor(new Date(2026, 11, 1).getTime() / 1000)));
    expect(sent.get("options[userevents]")).toBe("0");
    expect(text).not.toContain("Dentista");
    await expect(getCalendarEvents(client, { from: "mañana" })).rejects.toThrow(/not a date/);
  });

  it("still works when the groups cannot be read", async () => {
    const { client } = fakeMoodle({ core_enrol_get_users_courses: courses, core_calendar_get_calendar_events: () => ({ events: [] }) });
    expect(await getCalendarEvents(client, {})).toMatch(/^No calendar events from /);
  });
});

describe("get_course_participants", () => {
  const people = () => [
    { id: 7, fullname: "Test Student", email: "me@example.com", roles: [{ name: "", shortname: "student" }], groups: [{ id: 1, name: "Grupo A" }] },
    { id: 8, fullname: "Marcos Compañero", email: "marcos@example.com", roles: [{ name: "", shortname: "student" }], groups: [{ id: 2, name: "Grupo B" }] },
    { id: 4, fullname: "Ana Profesora", email: "ana@example.com", roles: [{ name: "Docente", shortname: "editingteacher" }] },
    { id: 5, fullname: "Luis Invitado", email: "luis@example.com", roles: [{ name: "Ponente", shortname: "speaker" }] },
    { id: 6, fullname: "Eva Delegada", email: "eva@example.com", roles: [{ name: "", shortname: "student" }, { name: "Delegada", shortname: "delegate" }] },
  ];
  const handlers = {
    core_enrol_get_enrolled_users: people,
    core_course_get_courses_by_field: () => ({ courses: [{ contacts: [{ id: 5, fullname: "Luis Invitado" }] }] }),
  };

  it("gives teachers' addresses and never classmates'", async () => {
    const { client } = fakeMoodle(handlers);
    const text = await getCourseParticipants(client, { course_id: 10 });
    expect(text).toContain("Course 10: 5 participants visible to the user.\nThe user's own groups: Grupo A.");
    expect(text).toContain("## Teachers (2)\n- Ana Profesora — Docente — ana@example.com\n- Luis Invitado — Ponente — luis@example.com");
    expect(text).toContain("## Other participants (3)");
    expect(text).toContain("- Eva Delegada — student, Delegada");
    expect(text).toContain("- Marcos Compañero [groups: Grupo B]");
    expect(text).toContain("- Test Student (the user) [groups: Grupo A]");
    for (const address of ["marcos@example.com", "eva@example.com", "me@example.com"]) expect(text).not.toContain(address);
  });

  it("filters by role and by name, ignoring accents", async () => {
    const { client } = fakeMoodle(handlers);
    const teachers = await getCourseParticipants(client, { course_id: 10, only_teachers: true });
    expect(teachers).not.toContain("Other participants");
    const found = await getCourseParticipants(client, { course_id: 10, search: "companero" });
    expect(found).toContain("## Teachers (0)\n(none found)");
    expect(found).toContain("## Other participants (1)\n- Marcos Compañero");
  });

  it("does not need the course contacts", async () => {
    const { client } = fakeMoodle({ core_enrol_get_enrolled_users: people });
    expect(await getCourseParticipants(client, { course_id: 10 })).toContain("## Teachers (1)\n- Ana Profesora");
  });
});
