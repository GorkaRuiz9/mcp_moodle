import { MoodleClient, MoodleError, NotLoggedInError } from "./moodle.js";
import { formatBytes, formatDate, formatDateRelative, htmlToText, normalizeForSearch, summarize, truncate } from "./format.js";

/** Courses and their contents change rarely; grades, deadlines and forums are always fetched fresh. */
export const STATIC_TTL_MS = 5 * 60 * 1000;

export const nowSeconds = () => Math.floor(Date.now() / 1000);

export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// ---------------------------------------------------------------- courses

export interface Course {
  id: number;
  fullname: string;
  shortname: string;
  startdate?: number;
  enddate?: number;
  progress?: number | null;
  lastaccess?: number | null;
  hidden?: boolean;
}

export async function getCourses(client: MoodleClient): Promise<Course[]> {
  const info = await client.siteInfo();
  const courses = await client.call<Course[]>("core_enrol_get_users_courses", { userid: info.userid }, STATIC_TTL_MS);
  return courses.map((course) => ({ ...course, fullname: oneLine(course.fullname) }));
}

export const isCurrent = (course: Course, now: number) => !course.enddate || course.enddate > now;
export const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();

export async function getScopeCourses(client: MoodleClient, courseId?: number): Promise<Course[]> {
  const courses = await getCourses(client);
  if (courseId !== undefined) {
    const match = courses.find((c) => c.id === courseId);
    // Still try a course we are not enrolled in; Moodle decides on access.
    return [match ?? { id: courseId, fullname: `Course ${courseId}`, shortname: "" }];
  }
  const now = nowSeconds();
  const current = courses.filter((c) => isCurrent(c, now));
  return current.length ? current : courses;
}

export async function listCourses(client: MoodleClient, args: { filter?: "current" | "all" }): Promise<string> {
  const all = await getCourses(client);
  const now = nowSeconds();
  const filter = args.filter ?? "current";
  const courses = (filter === "all" ? all : all.filter((c) => isCurrent(c, now))).sort(
    (a, b) => (b.lastaccess ?? 0) - (a.lastaccess ?? 0),
  );
  if (!courses.length) {
    return all.length
      ? `No current courses (all ${all.length} enrolled courses have ended). Call again with filter "all".`
      : "The user is not enrolled in any course.";
  }
  const lines = courses.map((c) => {
    const parts = [`- [course ${c.id}] ${oneLine(c.fullname)}`];
    // Some sites use long internal codes as short names; those are only noise.
    const short = oneLine(c.shortname ?? "");
    if (short && short !== oneLine(c.fullname) && short.length <= 20) parts.push(`(${short})`);
    if (typeof c.progress === "number") parts.push(`— progress ${Math.round(c.progress)}%`);
    if (c.enddate) parts.push(`— ${c.enddate > now ? "ends" : "ended"} ${formatDate(c.enddate)}`);
    return parts.join(" ");
  });
  const hiddenCount = all.length - courses.length;
  const footer = filter === "current" && hiddenCount > 0 ? `\n\n(${hiddenCount} past courses hidden; use filter "all" to see them.)` : "";
  return `${courses.length} courses, most recently accessed first:\n${lines.join("\n")}${footer}`;
}

// --------------------------------------------------------------- contents

export interface ContentFile {
  type: string;
  filename?: string;
  filesize?: number;
  fileurl?: string;
  mimetype?: string;
  timemodified?: number;
}

export interface CourseModule {
  id: number;
  name: string;
  modname: string;
  instance?: number;
  url?: string;
  description?: string;
  uservisible?: boolean;
  availabilityinfo?: string;
  contents?: ContentFile[];
}

export interface Section {
  id: number;
  name: string;
  section?: number;
  summary?: string;
  uservisible?: boolean;
  modules: CourseModule[];
}

export function getContents(client: MoodleClient, courseId: number): Promise<Section[]> {
  return client.call<Section[]>("core_course_get_contents", { courseid: courseId }, STATIC_TTL_MS);
}

export const cleanFileUrl = (url: string) => url.replace(/[?&]forcedownload=1$/, "");
const MAX_FILES_PER_MODULE = 30;

function formatModule(mod: CourseModule): string {
  const lines: string[] = [];
  const instance = mod.instance !== undefined ? `, ${mod.modname} ${mod.instance}` : "";
  let head = `- [cmid ${mod.id}${instance}] ${mod.modname}: ${htmlToText(mod.name)}`;
  if (mod.uservisible === false) head += " (not available to the user)";
  if (mod.url && mod.modname !== "label") head += ` — ${mod.url}`;
  lines.push(head);
  if (mod.availabilityinfo) lines.push(`  availability: ${summarize(mod.availabilityinfo, 200)}`);
  const description = summarize(mod.description, mod.modname === "label" ? 600 : 300);
  if (description && description !== htmlToText(mod.name)) lines.push(`  ${description}`);
  const contents = mod.contents ?? [];
  for (const file of contents.slice(0, MAX_FILES_PER_MODULE)) {
    if (!file.fileurl) continue;
    if (file.type === "url") {
      lines.push(`  · link: ${file.fileurl}`);
    } else {
      const meta = [formatBytes(file.filesize), file.mimetype].filter(Boolean).join(", ");
      lines.push(`  · file: ${file.filename ?? "unnamed"} (${meta}) ${cleanFileUrl(file.fileurl)}`);
    }
  }
  if (contents.length > MAX_FILES_PER_MODULE) lines.push(`  · …and ${contents.length - MAX_FILES_PER_MODULE} more files`);
  return lines.join("\n");
}

export async function getCourseContents(client: MoodleClient, args: { course_id: number; section_number?: number }): Promise<string> {
  const sections = await getContents(client, args.course_id);
  const wanted = args.section_number === undefined ? sections : sections.filter((s) => s.section === args.section_number);
  if (!wanted.length) {
    const available = sections.map((s) => `${s.section}: ${htmlToText(s.name)}`).join("; ");
    return `Course ${args.course_id} has no section number ${args.section_number}. Sections: ${available || "none"}.`;
  }
  const blocks = wanted.map((section) => {
    const lines = [`## Section ${section.section ?? "?"}: ${htmlToText(section.name)}`];
    const summary = summarize(section.summary, 500);
    if (summary) lines.push(summary);
    if (section.uservisible === false) lines.push("(section not available to the user)");
    if (section.modules.length) lines.push(...section.modules.map(formatModule));
    else lines.push("(empty)");
    return lines.join("\n");
  });
  return `Contents of course ${args.course_id}. Download any "file:" URL with get_file.\n\n${blocks.join("\n\n")}`;
}

// ------------------------------------------------------------ assignments

interface Assignment {
  id: number;
  cmid: number;
  name: string;
  duedate?: number;
  cutoffdate?: number;
  allowsubmissionsfromdate?: number;
  intro?: string;
}

interface AssignCourses {
  courses: { id: number; fullname: string; assignments: Assignment[] }[];
}

interface SubmissionStatus {
  lastattempt?: {
    submission?: { status?: string; timemodified?: number };
    teamsubmission?: { status?: string; timemodified?: number };
    graded?: boolean;
    gradingstatus?: string;
  };
  feedback?: { gradefordisplay?: string };
}

function describeSubmission(status: SubmissionStatus): string {
  const attempt = status.lastattempt;
  const submission = attempt?.teamsubmission ?? attempt?.submission;
  const state = submission?.status;
  const parts: string[] = [];
  if (state === "submitted") parts.push(`submitted ${formatDate(submission?.timemodified)}`);
  else if (state === "draft") parts.push("draft saved but NOT submitted");
  else if (state === "reopened") parts.push("reopened, not submitted again");
  else parts.push("not submitted");
  const grade = htmlToText(status.feedback?.gradefordisplay);
  if (grade) parts.push(`grade ${grade}`);
  else if (attempt?.graded) parts.push("graded");
  return parts.join(", ");
}

const MAX_ASSIGNMENTS = 40;

export async function listAssignments(client: MoodleClient, args: { course_id?: number; include_past?: boolean }): Promise<string> {
  const scope = await getScopeCourses(client, args.course_id);
  const data = await client.call<AssignCourses>("mod_assign_get_assignments", { courseids: scope.map((c) => c.id) });
  const now = nowSeconds();
  let items = data.courses.flatMap((course) => course.assignments.map((assignment) => ({ course, assignment })));
  const total = items.length;
  if (!args.include_past) items = items.filter(({ assignment }) => !assignment.duedate || assignment.duedate >= now);
  // Dated ones first, soonest first; undated at the end.
  items.sort((a, b) => (a.assignment.duedate || Infinity) - (b.assignment.duedate || Infinity));
  if (args.include_past) items.reverse();
  if (!items.length) {
    return total
      ? `No open assignments (${total} assignments have a due date in the past; pass include_past to see them).`
      : "No assignments found in these courses.";
  }
  const shown = items.slice(0, MAX_ASSIGNMENTS);
  const statuses = await mapLimit(shown, 5, async ({ assignment }) => {
    try {
      return describeSubmission(await client.call<SubmissionStatus>("mod_assign_get_submission_status", { assignid: assignment.id }));
    } catch (err) {
      if (err instanceof NotLoggedInError) throw err;
      return "status unavailable";
    }
  });
  const lines = shown.map(({ course, assignment }, index) => {
    const out = [`- [assign ${assignment.id}, cmid ${assignment.cmid}] ${htmlToText(assignment.name)} — ${course.fullname} [course ${course.id}]`];
    let dates = `  due: ${formatDateRelative(assignment.duedate, now)}`;
    if (assignment.cutoffdate && assignment.cutoffdate !== assignment.duedate) dates += ` | hard cut-off: ${formatDate(assignment.cutoffdate)}`;
    if (assignment.allowsubmissionsfromdate && assignment.allowsubmissionsfromdate > now) dates += ` | opens: ${formatDate(assignment.allowsubmissionsfromdate)}`;
    out.push(dates);
    out.push(`  submission: ${statuses[index]}`);
    const intro = summarize(assignment.intro, 300);
    if (intro) out.push(`  ${intro}`);
    return out.join("\n");
  });
  const more = items.length > shown.length ? `\n\n(${items.length - shown.length} more not shown; narrow down with course_id.)` : "";
  const header = args.include_past ? `${items.length} assignments, latest due date first:` : `${items.length} open assignments, soonest due date first:`;
  return `${header}\n${lines.join("\n")}${more}`;
}

// -------------------------------------------------------------- deadlines

interface ActionEvent {
  id: number;
  name: string;
  timesort?: number;
  timestart?: number;
  modulename?: string;
  instance?: number;
  url?: string;
  course?: { id: number; fullname: string };
  action?: { name?: string; actionable?: boolean };
}

const MAX_EVENTS = 50;

export async function getUpcomingDeadlines(client: MoodleClient, args: { days?: number }): Promise<string> {
  const days = args.days ?? 14;
  const now = nowSeconds();
  const data = await client.call<{ events: ActionEvent[] }>("core_calendar_get_action_events_by_timesort", {
    timesortfrom: now,
    timesortto: now + days * 86400,
    limitnum: MAX_EVENTS,
  });
  const events = data.events ?? [];
  if (!events.length) return `No deadlines or action events in the next ${days} days.`;
  const lines = events.map((event) => {
    const when = formatDateRelative(event.timesort ?? event.timestart, now);
    const course = event.course ? ` — ${event.course.fullname} [course ${event.course.id}]` : "";
    // In calendar events "instance" is the course module id, not the activity id.
    const ref = event.modulename ? ` [${event.modulename}${event.instance ? ", cmid " + event.instance : ""}]` : "";
    return `- ${when}: ${htmlToText(event.name)}${course}${ref}${event.url ? ` ${event.url}` : ""}`;
  });
  const more = events.length >= MAX_EVENTS ? `\n\n(Showing the first ${MAX_EVENTS}; there may be more. Use a smaller "days" value.)` : "";
  return `${events.length} events in the next ${days} days, soonest first:\n${lines.join("\n")}${more}`;
}

// ----------------------------------------------------------------- grades

interface GradeItem {
  itemname?: string | null;
  itemtype?: string;
  itemmodule?: string | null;
  gradeformatted?: string;
  rangeformatted?: string;
  percentageformatted?: string;
  weightformatted?: string;
  feedback?: string;
}

export async function getGrades(client: MoodleClient, args: { course_id?: number }): Promise<string> {
  const info = await client.siteInfo();
  if (args.course_id === undefined) {
    const [courses, data] = await Promise.all([
      getCourses(client),
      client.call<{ grades: { courseid: number; grade?: string }[] }>("gradereport_overview_get_course_grades", { userid: info.userid }),
    ]);
    const names = new Map(courses.map((c) => [c.id, c.fullname]));
    const now = nowSeconds();
    const current = new Set(courses.filter((c) => isCurrent(c, now)).map((c) => c.id));
    const grades = (data.grades ?? []).slice().sort((a, b) => Number(current.has(b.courseid)) - Number(current.has(a.courseid)));
    if (!grades.length) return "No course grades available.";
    const lines = grades.map((g) => {
      const grade = htmlToText(g.grade) || "-";
      const past = current.has(g.courseid) ? "" : " (past course)";
      return `- [course ${g.courseid}] ${names.get(g.courseid) ?? "Unknown course"}: ${grade === "-" ? "no grade yet" : grade}${past}`;
    });
    return `Course total grades. Call get_grades with a course_id for the item-by-item breakdown.\n${lines.join("\n")}`;
  }
  const data = await client.call<{ usergrades: { gradeitems: GradeItem[] }[] }>("gradereport_user_get_grade_items", {
    courseid: args.course_id,
    userid: info.userid,
  });
  const items = data.usergrades?.[0]?.gradeitems ?? [];
  if (!items.length) return `No grade items visible in course ${args.course_id}.`;
  const lines = items.map((item) => {
    let name = htmlToText(item.itemname ?? "");
    if (item.itemtype === "course") name = "COURSE TOTAL";
    else if (item.itemtype === "category") name = `Category total${name ? ": " + name : ""}`;
    else if (!name) name = "Unnamed item";
    const kind = item.itemmodule ? ` (${item.itemmodule})` : "";
    const grade = htmlToText(item.gradeformatted) || "-";
    const extras = [
      item.rangeformatted ? `range ${htmlToText(item.rangeformatted)}` : "",
      item.percentageformatted && item.percentageformatted !== "-" ? htmlToText(item.percentageformatted) : "",
      item.weightformatted && item.weightformatted !== "-" ? `weight ${htmlToText(item.weightformatted)}` : "",
    ].filter(Boolean);
    let line = `- ${name}${kind}: ${grade === "-" ? "no grade yet" : grade}${extras.length ? ` (${extras.join(", ")})` : ""}`;
    const feedback = summarize(item.feedback, 400);
    if (feedback) line += `\n  feedback: ${feedback}`;
    return line;
  });
  return `Grade items of course ${args.course_id}:\n${lines.join("\n")}`;
}

// ----------------------------------------------------------------- forums

export interface Forum {
  id: number;
  course: number;
  name: string;
  type?: string;
  cmid?: number;
  numdiscussions?: number;
}

interface Discussion {
  /** Post id of the first post. */
  id: number;
  /** The discussion id, which is what get_discussion needs. */
  discussion: number;
  name?: string;
  subject?: string;
  message?: string;
  userfullname?: string;
  created?: number;
  timemodified?: number;
  numreplies?: number | string;
  pinned?: boolean;
}

/** Tries the current function and falls back to its pre-3.7 predecessor. */
export async function withFallback<T>(primary: () => Promise<T>, fallback: () => Promise<T>): Promise<T> {
  try {
    return await primary();
  } catch (err) {
    if (err instanceof NotLoggedInError || !(err instanceof MoodleError) || err.errorcode === "network") throw err;
    try {
      return await fallback();
    } catch {
      throw err;
    }
  }
}

async function getDiscussions(client: MoodleClient, forumId: number, limit: number): Promise<Discussion[]> {
  const data = await withFallback(
    () => client.call<{ discussions: Discussion[] }>("mod_forum_get_forum_discussions", { forumid: forumId, page: 0, perpage: limit }),
    () =>
      client.call<{ discussions: Discussion[] }>("mod_forum_get_forum_discussions_paginated", {
        forumid: forumId,
        sortby: "timemodified",
        sortdirection: "DESC",
        page: 0,
        perpage: limit,
      }),
  );
  return (data.discussions ?? []).slice(0, limit);
}

function formatDiscussion(d: Discussion): string {
  const replies = Number(d.numreplies ?? 0);
  const head = `- [discussion ${d.discussion}] ${htmlToText(d.name ?? d.subject ?? "")} — ${d.userfullname ?? "unknown"}, ${formatDate(d.timemodified ?? d.created)} — ${replies} ${replies === 1 ? "reply" : "replies"}${d.pinned ? " (pinned)" : ""}`;
  const preview = summarize(d.message, 200);
  return preview ? `${head}\n  ${preview}` : head;
}

export async function listForumDiscussions(client: MoodleClient, args: { course_id?: number; forum_id?: number; limit?: number }): Promise<string> {
  if (args.forum_id !== undefined) {
    const discussions = await getDiscussions(client, args.forum_id, args.limit ?? 15);
    if (!discussions.length) return `Forum ${args.forum_id} has no discussions.`;
    return `Latest discussions of forum ${args.forum_id}. Read one with get_discussion.\n${discussions.map(formatDiscussion).join("\n")}`;
  }
  if (args.course_id === undefined) {
    throw new MoodleError("Pass a course_id (to see every forum of a course) or a forum_id.", "badargs");
  }
  const forums = await client.call<Forum[]>("mod_forum_get_forums_by_courses", { courseids: [args.course_id] });
  if (!forums.length) return `Course ${args.course_id} has no forums.`;
  const perForum = args.limit ?? 5;
  const blocks = await mapLimit(forums, 4, async (forum) => {
    const head = `## [forum ${forum.id}] ${htmlToText(forum.name)}${forum.type ? ` (${forum.type})` : ""}`;
    try {
      const discussions = await getDiscussions(client, forum.id, perForum);
      return `${head}\n${discussions.length ? discussions.map(formatDiscussion).join("\n") : "(no discussions)"}`;
    } catch (err) {
      if (err instanceof NotLoggedInError) throw err;
      return `${head}\n(could not read: ${(err as Error).message})`;
    }
  });
  return `Forums of course ${args.course_id}, with up to ${perForum} latest discussions each. Read one with get_discussion.\n\n${blocks.join("\n\n")}`;
}

interface Post {
  id: number;
  subject?: string;
  message?: string;
  // Current API shape.
  author?: { fullname?: string };
  timecreated?: number;
  parentid?: number | null;
  // Pre-3.7 shape.
  userfullname?: string;
  created?: number;
  parent?: number;
}

export async function getDiscussion(client: MoodleClient, args: { discussion_id: number }): Promise<string> {
  const data = await withFallback(
    () =>
      client.call<{ posts: Post[] }>("mod_forum_get_discussion_posts", {
        discussionid: args.discussion_id,
        sortby: "created",
        sortdirection: "ASC",
      }),
    () =>
      client.call<{ posts: Post[] }>("mod_forum_get_forum_discussion_posts", {
        discussionid: args.discussion_id,
        sortby: "created",
        sortdirection: "ASC",
      }),
  );
  const posts = (data.posts ?? []).slice().sort((a, b) => (a.timecreated ?? a.created ?? 0) - (b.timecreated ?? b.created ?? 0));
  if (!posts.length) return `Discussion ${args.discussion_id} has no visible posts.`;
  const blocks = posts.map((post) => {
    const author = post.author?.fullname ?? post.userfullname ?? "unknown";
    const parent = post.parentid ?? post.parent;
    const reply = parent ? ` (reply to post ${parent})` : "";
    return `### [post ${post.id}] ${htmlToText(post.subject)} — ${author}, ${formatDate(post.timecreated ?? post.created)}${reply}\n${truncate(htmlToText(post.message), 4000)}`;
  });
  return `Discussion ${args.discussion_id}, ${posts.length} posts, oldest first:\n\n${blocks.join("\n\n")}`;
}

// ----------------------------------------------------------------- search

const MAX_HITS = 50;

export async function searchCoursesContent(client: MoodleClient, args: { query: string; course_id?: number }): Promise<string> {
  const terms = normalizeForSearch(args.query).split(/\s+/).filter(Boolean);
  if (!terms.length) throw new MoodleError("The query is empty.", "badargs");
  const matches = (...texts: (string | undefined | null)[]) => {
    const haystack = normalizeForSearch(texts.filter(Boolean).join(" "));
    return terms.every((term) => haystack.includes(term));
  };
  const scope = await getScopeCourses(client, args.course_id);
  const failed: string[] = [];
  const perCourse = await mapLimit(scope, 4, async (course) => {
    const hits: string[] = [];
    const where = `[course ${course.id}] ${course.fullname}`;
    if (matches(course.fullname, course.shortname)) hits.push(`- ${where} (course name)`);
    let sections: Section[];
    try {
      sections = await getContents(client, course.id);
    } catch (err) {
      if (err instanceof NotLoggedInError) throw err;
      failed.push(course.fullname);
      return hits;
    }
    for (const section of sections) {
      const sectionName = htmlToText(section.name);
      const inSection = `${where} › section ${section.section ?? "?"} "${sectionName}"`;
      if (matches(sectionName, htmlToText(section.summary))) hits.push(`- ${inSection}`);
      for (const mod of section.modules) {
        const modName = htmlToText(mod.name);
        if (matches(modName, htmlToText(mod.description))) {
          hits.push(`- ${inSection} › ${mod.modname} "${modName}" [cmid ${mod.id}]${mod.url ? ` ${mod.url}` : ""}`);
        }
        for (const file of mod.contents ?? []) {
          if (file.type !== "url" && file.fileurl && matches(file.filename)) {
            hits.push(`- ${inSection} › ${mod.modname} "${modName}" › file ${file.filename} ${cleanFileUrl(file.fileurl)}`);
          }
        }
      }
    }
    return hits;
  });
  const hits = perCourse.flat();
  const scopeNote = `Searched titles, descriptions and file names in ${scope.length} ${scope.length === 1 ? "course" : "courses"} (not the text inside files).`;
  const failedNote = failed.length ? `\nCould not read: ${failed.join("; ")}.` : "";
  if (!hits.length) return `No matches for "${args.query}". ${scopeNote}${failedNote}`;
  const more = hits.length > MAX_HITS ? `\n(${hits.length - MAX_HITS} more matches not shown; refine the query.)` : "";
  return `${hits.length} matches for "${args.query}". ${scopeNote}\n${hits.slice(0, MAX_HITS).join("\n")}${more}${failedNote}`;
}
