import { describe, expect, it } from "vitest";
import {
  getCourseContents,
  getDiscussion,
  getGrades,
  getUpcomingDeadlines,
  listAssignments,
  listCourses,
  listForumDiscussions,
  searchCoursesContent,
} from "../src/tools.js";
import { DAY, fakeMoodle, now, SITE } from "./helpers.js";

const courses = () => [
  { id: 10, fullname: "Cálculo I", shortname: "CALC1", enddate: now() + 60 * DAY, progress: 41.6, lastaccess: 200 },
  { id: 11, fullname: "Programación\n (es)(1)", shortname: "2026-27 Programación (es)(1)[2026_0_144_520292_1_3]", enddate: 0, lastaccess: 300 },
  { id: 12, fullname: "Historia antigua", shortname: "HIST", enddate: now() - 200 * DAY, lastaccess: 100 },
];

const contents = (courseId: string | null) =>
  courseId === "10"
    ? [
        {
          id: 1,
          name: "Tema 1: Límites",
          section: 1,
          summary: "<p>Introducción a los <b>límites</b></p>",
          modules: [
            {
              id: 501,
              name: "Apuntes del tema",
              modname: "resource",
              instance: 31,
              url: `${SITE}/mod/resource/view.php?id=501`,
              contents: [
                {
                  type: "file",
                  filename: "limites.pdf",
                  filesize: 2048,
                  mimetype: "application/pdf",
                  fileurl: `${SITE}/webservice/pluginfile.php/9/mod_resource/content/1/limites.pdf?forcedownload=1`,
                },
              ],
            },
            { id: 502, name: "Aviso", modname: "label", description: "<p>El examen parcial es el día 20</p>" },
            { id: 503, name: "Vídeo", modname: "url", url: `${SITE}/mod/url/view.php?id=503`, contents: [{ type: "url", fileurl: "https://video.example/v" }] },
          ],
        },
        { id: 2, name: "Tema 2", section: 2, summary: "", modules: [] },
      ]
    : [{ id: 3, name: "General", section: 0, summary: "", modules: [{ id: 601, name: "Guía docente", modname: "page", description: "" }] }];

describe("list_courses", () => {
  it("hides past courses by default and orders by last access", async () => {
    const { client } = fakeMoodle({ core_enrol_get_users_courses: courses });
    const text = await listCourses(client, {});
    expect(text).toContain("2 courses");
    expect(text).toContain("- [course 11] Programación (es)(1)\n");
    expect(text.indexOf("[course 11] Programación")).toBeLessThan(text.indexOf("[course 10] Cálculo I"));
    expect(text).toContain("progress 42%");
    expect(text).not.toContain("Historia antigua");
    expect(text).toContain("1 past courses hidden");
  });

  it("shows everything with filter all", async () => {
    const { client } = fakeMoodle({ core_enrol_get_users_courses: courses });
    expect(await listCourses(client, { filter: "all" })).toContain("[course 12] Historia antigua (HIST) — ended");
  });

  it("asks for the user id of the token owner", async () => {
    let userid: string | null = null;
    const { client } = fakeMoodle({
      core_enrol_get_users_courses: (params) => {
        userid = params.get("userid");
        return [];
      },
    });
    expect(await listCourses(client, {})).toContain("not enrolled");
    expect(userid).toBe("7");
  });
});

describe("get_course_contents", () => {
  it("lists sections, modules and downloadable files", async () => {
    const { client } = fakeMoodle({ core_course_get_contents: (p) => contents(p.get("courseid")) });
    const text = await getCourseContents(client, { course_id: 10 });
    expect(text).toContain("## Section 1: Tema 1: Límites\nIntroducción a los límites");
    expect(text).toContain("- [cmid 501, resource 31] resource: Apuntes del tema — https://moodle.example/mod/resource/view.php?id=501");
    expect(text).toContain("· file: limites.pdf (2.0 KB, application/pdf) https://moodle.example/webservice/pluginfile.php/9/mod_resource/content/1/limites.pdf");
    expect(text).not.toContain("forcedownload");
    expect(text).toContain("- [cmid 502] label: Aviso\n  El examen parcial es el día 20");
    expect(text).toContain("· link: https://video.example/v");
    expect(text).toContain("## Section 2: Tema 2\n(empty)");
  });

  it("can return a single section, and explains a wrong number", async () => {
    const { client } = fakeMoodle({ core_course_get_contents: (p) => contents(p.get("courseid")) });
    const one = await getCourseContents(client, { course_id: 10, section_number: 2 });
    expect(one).toContain("Tema 2");
    expect(one).not.toContain("Límites");
    expect(await getCourseContents(client, { course_id: 10, section_number: 9 })).toContain("Sections: 1: Tema 1: Límites; 2: Tema 2");
  });
});

describe("list_assignments", () => {
  const assignments = () => ({
    courses: [
      {
        id: 10,
        fullname: "Cálculo I",
        assignments: [
          { id: 71, cmid: 701, name: "Entrega 1", duedate: now() + 3 * DAY, intro: "<p>Resolver los ejercicios</p>" },
          { id: 72, cmid: 702, name: "Entrega 0", duedate: now() - 10 * DAY },
          { id: 73, cmid: 703, name: "Proyecto", duedate: now() + 30 * DAY },
          { id: 74, cmid: 704, name: "Sin fecha", duedate: 0 },
        ],
      },
    ],
  });
  const status = (params: URLSearchParams) => {
    switch (params.get("assignid")) {
      case "71":
        return { lastattempt: { submission: { status: "submitted", timemodified: now() - DAY }, graded: true }, feedback: { gradefordisplay: "8,50&nbsp;/&nbsp;10,00" } };
      case "73":
        return { lastattempt: { submission: { status: "new" }, teamsubmission: { status: "draft" } } };
      case "74":
        return { exception: "x", errorcode: "nopermissions", message: "no" };
      default:
        return { lastattempt: { submission: { status: "new" } } };
    }
  };
  const handlers = { core_enrol_get_users_courses: courses, mod_assign_get_assignments: assignments, mod_assign_get_submission_status: status };

  it("shows open assignments soonest first with submission state", async () => {
    const { client } = fakeMoodle(handlers);
    const text = await listAssignments(client, {});
    expect(text).toContain("3 open assignments");
    expect(text).not.toContain("Entrega 0");
    const order = ["Entrega 1", "Proyecto", "Sin fecha"].map((name) => text.indexOf(name));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(text).toMatch(/\[assign 71, cmid 701\] Entrega 1 — Cálculo I \[course 10\]\n  due: .*\(in 3 d\)\n  submission: submitted .*, grade 8,50 \/ 10,00\n  Resolver los ejercicios/);
    expect(text).toContain("submission: draft saved but NOT submitted");
    expect(text).toContain("due: none\n  submission: status unavailable");
  });

  it("only asks about current courses, or the one requested", async () => {
    const seen: string[][] = [];
    const { client } = fakeMoodle({
      ...handlers,
      mod_assign_get_assignments: (params) => {
        seen.push([...params.entries()].filter(([key]) => key.startsWith("courseids")).map(([, value]) => value));
        return { courses: [] };
      },
    });
    await listAssignments(client, {});
    await listAssignments(client, { course_id: 12 });
    expect(seen).toEqual([["10", "11"], ["12"]]);
  });

  it("includes past ones on request", async () => {
    const { client } = fakeMoodle(handlers);
    const text = await listAssignments(client, { include_past: true });
    expect(text).toContain("4 assignments");
    expect(text).toMatch(/Entrega 0[^\n]*\n  due: .*\(10 d ago\)\n  submission: not submitted/);
  });
});

describe("get_upcoming_deadlines", () => {
  it("lists timeline events in the requested window", async () => {
    let window = 0;
    const { client } = fakeMoodle({
      core_calendar_get_action_events_by_timesort: (params) => {
        window = Number(params.get("timesortto")) - Number(params.get("timesortfrom"));
        return {
          events: [
            { id: 1, name: "Vencimiento de Entrega 1", timesort: now() + 2 * DAY, modulename: "assign", instance: 71, url: `${SITE}/mod/assign/view.php?id=701`, course: { id: 10, fullname: "Cálculo I" } },
          ],
        };
      },
    });
    const text = await getUpcomingDeadlines(client, { days: 7 });
    expect(window).toBe(7 * DAY);
    expect(text).toContain("1 events in the next 7 days");
    expect(text).toMatch(/\(in 2 d\): Vencimiento de Entrega 1 — Cálculo I \[course 10\] \[assign, cmid 71\] https:\/\/moodle\.example\/mod\/assign\/view\.php\?id=701/);
  });

  it("says so when nothing is due", async () => {
    const { client } = fakeMoodle({ core_calendar_get_action_events_by_timesort: () => ({ events: [] }) });
    expect(await getUpcomingDeadlines(client, {})).toBe("No deadlines or action events in the next 14 days.");
  });
});

describe("get_grades", () => {
  it("gives course totals, current courses first", async () => {
    const { client } = fakeMoodle({
      core_enrol_get_users_courses: courses,
      gradereport_overview_get_course_grades: () => ({ grades: [{ courseid: 12, grade: "7,00" }, { courseid: 10, grade: "-" }] }),
    });
    const text = await getGrades(client, {});
    expect(text).toContain("- [course 10] Cálculo I: no grade yet");
    expect(text).toContain("- [course 12] Historia antigua: 7,00 (past course)");
    expect(text.indexOf("[course 10]")).toBeLessThan(text.indexOf("[course 12]"));
  });

  it("breaks one course down by item", async () => {
    const { client } = fakeMoodle({
      gradereport_user_get_grade_items: () => ({
        usergrades: [
          {
            gradeitems: [
              { itemname: "Entrega 1", itemtype: "mod", itemmodule: "assign", gradeformatted: "8,50", rangeformatted: "0&ndash;10", percentageformatted: "85,00 %", weightformatted: "20,00 %", feedback: "<p>Bien</p>" },
              { itemname: null, itemtype: "course", gradeformatted: "-", rangeformatted: "0&ndash;10", percentageformatted: "-" },
            ],
          },
        ],
      }),
    });
    const text = await getGrades(client, { course_id: 10 });
    expect(text).toContain("- Entrega 1 (assign): 8,50 (range 0–10, 85,00 %, weight 20,00 %)\n  feedback: Bien");
    expect(text).toContain("- COURSE TOTAL: no grade yet (range 0–10)");
  });
});

describe("forums", () => {
  const discussions = () => ({
    discussions: [{ id: 900, discussion: 90, name: "Cambio de aula", userfullname: "Ana Profesora", timemodified: now() - DAY, numreplies: 1, pinned: true, message: "<p>Mañana en el aula 12</p>" }],
  });

  it("lists every forum of a course with its discussions", async () => {
    const { client } = fakeMoodle({
      mod_forum_get_forums_by_courses: () => [{ id: 8, course: 10, name: "Avisos", type: "news" }],
      mod_forum_get_forum_discussions: discussions,
    });
    const text = await listForumDiscussions(client, { course_id: 10 });
    expect(text).toContain("## [forum 8] Avisos (news)");
    expect(text).toMatch(/- \[discussion 90\] Cambio de aula — Ana Profesora, .* — 1 reply \(pinned\)\n  Mañana en el aula 12/);
  });

  it("falls back to the older function on old Moodle versions", async () => {
    const { client, calls } = fakeMoodle({ mod_forum_get_forum_discussions_paginated: discussions });
    expect(await listForumDiscussions(client, { forum_id: 8 })).toContain("[discussion 90]");
    expect(calls).toEqual(["mod_forum_get_forum_discussions", "mod_forum_get_forum_discussions_paginated"]);
  });

  it("needs a course or a forum", async () => {
    const { client } = fakeMoodle({});
    await expect(listForumDiscussions(client, {})).rejects.toThrow(/course_id/);
  });

  it("prints a discussion oldest first with reply links", async () => {
    const { client } = fakeMoodle({
      mod_forum_get_discussion_posts: () => ({
        posts: [
          { id: 2, subject: "Re: Cambio de aula", message: "<p>Gracias</p>", author: { fullname: "Test Student" }, timecreated: 2000, parentid: 1 },
          { id: 1, subject: "Cambio de aula", message: "<p>Mañana en el aula 12</p>", author: { fullname: "Ana Profesora" }, timecreated: 1000, parentid: null },
        ],
      }),
    });
    const text = await getDiscussion(client, { discussion_id: 90 });
    expect(text.indexOf("[post 1]")).toBeLessThan(text.indexOf("[post 2]"));
    expect(text).toMatch(/### \[post 2\] Re: Cambio de aula — Test Student, .* \(reply to post 1\)\nGracias/);
  });
});

describe("search_courses_content", () => {
  const handlers = { core_enrol_get_users_courses: courses, core_course_get_contents: (p: URLSearchParams) => contents(p.get("courseid")) };

  it("matches titles, descriptions and file names, ignoring accents and case", async () => {
    const { client } = fakeMoodle(handlers);
    const byDescription = await searchCoursesContent(client, { query: "EXAMEN parcial" });
    expect(byDescription).toContain("1 matches");
    expect(byDescription).toContain('[course 10] Cálculo I › section 1 "Tema 1: Límites" › label "Aviso" [cmid 502]');
    const byFile = await searchCoursesContent(client, { query: "limites" });
    expect(byFile).toContain("› file limites.pdf https://moodle.example/webservice/pluginfile.php/9/mod_resource/content/1/limites.pdf");
    expect(byFile).toContain('- [course 10] Cálculo I › section 1 "Tema 1: Límites"\n');
    expect(await searchCoursesContent(client, { query: "calculo" })).toContain("[course 10] Cálculo I (course name)");
  });

  it("searches current courses only, and reuses cached contents", async () => {
    const { client, calls } = fakeMoodle(handlers);
    const text = await searchCoursesContent(client, { query: "nada de nada" });
    expect(text).toContain('No matches for "nada de nada". Searched titles, descriptions and file names in 2 courses');
    await searchCoursesContent(client, { query: "guía" });
    expect(calls.filter((c) => c === "core_course_get_contents")).toHaveLength(2);
  });
});
