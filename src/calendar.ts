import { MoodleClient, MoodleError, NotLoggedInError } from "./moodle.js";
import { formatDate, formatDateRelative, formatDuration, htmlToText, parseDateInput, summarize } from "./format.js";
import { getScopeCourses, nowSeconds } from "./tools.js";

export interface CalendarEvent {
  id: number;
  name: string;
  description?: string;
  courseid?: number | null;
  groupid?: number | null;
  userid?: number | null;
  modulename?: string | null;
  eventtype?: string;
  timestart: number;
  timeduration?: number;
}

const DAY = 86400;
const MAX_CALENDAR_EVENTS = 100;

export function parseWhen(text: string, what: string): number {
  const parsed = parseDateInput(text);
  if (parsed === undefined) throw new MoodleError(`${what} "${text}" is not a date. Use YYYY-MM-DD or YYYY-MM-DD HH:MM (local time).`, "badargs");
  return parsed;
}

/** Group events only show up when their group ids are asked for explicitly. */
async function ownGroupIds(client: MoodleClient, userId: number): Promise<number[]> {
  try {
    const data = await client.call<{ groups: { id: number }[] }>("core_group_get_course_user_groups", { courseid: 0, userid: userId });
    return (data.groups ?? []).map((group) => group.id);
  } catch (err) {
    if (err instanceof NotLoggedInError) throw err;
    return [];
  }
}

function eventKind(event: CalendarEvent): string {
  if (event.modulename) return `${event.modulename}${event.eventtype ? " " + event.eventtype : ""}`;
  switch (event.eventtype) {
    case "user":
      return "personal";
    case "group":
      return "group event";
    case "course":
      return "course event";
    case "site":
      return "site event";
    case "category":
      return "category event";
    default:
      return event.eventtype ?? "event";
  }
}

export async function getCalendarEvents(client: MoodleClient, args: { from?: string; days?: number; course_id?: number }): Promise<string> {
  const now = nowSeconds();
  const start = args.from === undefined ? now : parseWhen(args.from, "from");
  const days = args.days ?? 30;
  const end = start + days * DAY;
  const info = await client.siteInfo();
  const [scope, groupIds] = await Promise.all([getScopeCourses(client, args.course_id), ownGroupIds(client, info.userid)]);
  const names = new Map(scope.map((course) => [course.id, course.fullname]));
  const personal = args.course_id === undefined;
  const data = await client.call<{ events: CalendarEvent[] }>("core_calendar_get_calendar_events", {
    events: { courseids: scope.map((course) => course.id), groupids: groupIds },
    options: { userevents: personal, siteevents: personal, timestart: start, timeend: end, ignorehidden: true },
  });
  let events = (data.events ?? []).slice().sort((a, b) => a.timestart - b.timestart);
  // Asking for groups returns the events of those groups in every course.
  if (!personal) events = events.filter((event) => event.courseid === args.course_id);
  const window = `${formatDate(start)} to ${formatDate(end)}`;
  if (!events.length) return `No calendar events from ${window}.`;
  const lines = events.slice(0, MAX_CALENDAR_EVENTS).map((event) => {
    const ends = event.timeduration ? ` (lasts ${formatDuration(event.timeduration)})` : "";
    const course = event.courseid && names.has(event.courseid) ? ` — ${names.get(event.courseid)} [course ${event.courseid}]` : "";
    let line = `- [event ${event.id}] ${formatDateRelative(event.timestart, now)}${ends}: ${htmlToText(event.name)} (${eventKind(event)})${course}`;
    // Activity events repeat the activity description, which the activity tools already give.
    const description = event.modulename ? "" : summarize(event.description, 300);
    if (description) line += `\n  ${description}`;
    return line;
  });
  const more = events.length > MAX_CALENDAR_EVENTS ? `\n\n(${events.length - MAX_CALENDAR_EVENTS} more not shown; use a smaller "days" value.)` : "";
  return `${events.length} calendar events from ${window}, soonest first:\n${lines.join("\n")}${more}`;
}
