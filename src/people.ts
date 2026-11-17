import { MoodleClient, NotLoggedInError } from "./moodle.js";
import { htmlToText, normalizeForSearch } from "./format.js";
import { STATIC_TTL_MS } from "./tools.js";

interface Role {
  name?: string;
  shortname?: string;
}

interface Participant {
  id: number;
  fullname?: string;
  email?: string;
  roles?: Role[];
  groups?: { id: number; name?: string }[];
}

/** Short names of Moodle's built-in teaching and managing roles. */
const STAFF_ROLES = new Set(["editingteacher", "teacher", "manager", "coursecreator"]);
const MAX_PEOPLE = 150;

const roleLabel = (role: Role) => htmlToText(role.name ?? "") || role.shortname || "role";

/** The people the site lists as contacts of the course: its teachers. */
async function courseContactIds(client: MoodleClient, courseId: number): Promise<Set<number>> {
  try {
    const data = await client.call<{ courses: { contacts?: { id: number }[] }[] }>("core_course_get_courses_by_field", { field: "id", value: courseId }, STATIC_TTL_MS);
    return new Set((data.courses?.[0]?.contacts ?? []).map((contact) => contact.id));
  } catch (err) {
    if (err instanceof NotLoggedInError) throw err;
    return new Set();
  }
}

export async function getCourseParticipants(
  client: MoodleClient,
  args: { course_id: number; only_teachers?: boolean; search?: string },
): Promise<string> {
  const info = await client.siteInfo();
  const [people, contacts] = await Promise.all([
    client.call<Participant[]>(
      "core_enrol_get_enrolled_users",
      { courseid: args.course_id, options: [{ name: "userfields", value: "id,fullname,email,roles,groups" }] },
      STATIC_TTL_MS,
    ),
    courseContactIds(client, args.course_id),
  ]);
  if (!people.length) return `No participants visible in course ${args.course_id}.`;

  const isStaff = (person: Participant) => contacts.has(person.id) || (person.roles ?? []).some((role) => STAFF_ROLES.has(role.shortname ?? ""));
  const terms = normalizeForSearch(args.search ?? "").split(/\s+/).filter(Boolean);
  const matches = (person: Participant) => {
    const name = normalizeForSearch(person.fullname ?? "");
    return terms.every((term) => name.includes(term));
  };
  const byName = (a: Participant, b: Participant) => (a.fullname ?? "").localeCompare(b.fullname ?? "");
  const staff = people.filter((person) => isStaff(person) && matches(person)).sort(byName);
  const others = args.only_teachers ? [] : people.filter((person) => !isStaff(person) && matches(person)).sort(byName);

  const me = people.find((person) => person.id === info.userid);
  const myGroups = (me?.groups ?? []).map((group) => htmlToText(group.name ?? "")).filter(Boolean);
  const out = [
    `Course ${args.course_id}: ${people.length} participants visible to the user.`,
    `The user's own groups: ${myGroups.length ? myGroups.join(", ") : "none"}.`,
  ];

  const line = (person: Participant, withEmail: boolean) => {
    const roles = (person.roles ?? []).map(roleLabel);
    const groups = (person.groups ?? []).map((group) => htmlToText(group.name ?? "")).filter(Boolean);
    let text = `- ${person.fullname ?? `user ${person.id}`}${person.id === info.userid ? " (the user)" : ""}`;
    if (withEmail || roles.some((role) => role !== "student")) text += roles.length ? ` — ${roles.join(", ")}` : "";
    // Classmates' addresses are deliberately left out; teachers' are how students reach them.
    if (withEmail && person.email) text += ` — ${person.email}`;
    if (groups.length) text += ` [groups: ${groups.join(", ")}]`;
    return text;
  };

  out.push("", `## Teachers (${staff.length})`);
  out.push(staff.length ? staff.map((person) => line(person, true)).join("\n") : "(none found)");
  if (!args.only_teachers) {
    out.push("", `## Other participants (${others.length})`);
    out.push(others.length ? others.slice(0, MAX_PEOPLE).map((person) => line(person, false)).join("\n") : "(none found)");
    if (others.length > MAX_PEOPLE) out.push(`(${others.length - MAX_PEOPLE} more not shown; narrow down with search.)`);
  }
  if (terms.length) out.push("", `Filtered by name: "${args.search}".`);
  return out.join("\n");
}
