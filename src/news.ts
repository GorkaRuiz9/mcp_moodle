import { MoodleClient, MoodleError, NotLoggedInError } from "./moodle.js";
import { formatBytes, formatDate, htmlToText, parseDateInput, summarize, truncate } from "./format.js";
import { cleanFileUrl, CourseModule, getContents, getScopeCourses, mapLimit, nowSeconds } from "./tools.js";

const DAY = 86400;

// --------------------------------------------------------- recent changes

interface ModuleUpdates {
  contextlevel: string;
  /** Course module id. */
  id: number;
  updates: { name: string; timeupdated?: number; itemids?: number[] }[];
}

/** What each update area reported by Moodle means for a student. */
const AREA_LABELS: Record<string, string> = {
  configuration: "added, or its settings or description changed",
  contentfiles: "files added or changed",
  introfiles: "files in the description changed",
  introattachmentfiles: "attached files changed",
  discussions: "new forum posts",
  gradeitems: "grade changed",
  grades: "grade changed",
  usergrades: "grade changed",
  outcomes: "outcome changed",
  comments: "new comments",
  ratings: "new ratings",
  completion: "completion state changed",
  submissions: "submission changed",
  attempts: "attempts changed",
  questions: "questions changed",
  entries: "new entries",
  pages: "pages changed",
  answers: "answers changed",
  tracks: "progress changed",
};

const MAX_CHANGED_MODULES = 40;
const MAX_NEW_FILES = 10;

function describeChange(change: ModuleUpdates, module: CourseModule | undefined, since: number): string {
  const head = module
    ? `- [cmid ${module.id}${module.instance !== undefined ? `, ${module.modname} ${module.instance}` : ""}] ${module.modname}: ${htmlToText(module.name)}`
    : `- [cmid ${change.id}] (not in the visible course contents)`;
  const lines = [head];
  const seen = new Set<string>();
  for (const update of change.updates) {
    let label = AREA_LABELS[update.name] ?? update.name;
    if (seen.has(label)) continue;
    seen.add(label);
    if (update.name === "discussions" && update.itemids?.length) {
      label += `: ${update.itemids.slice(0, 10).map((id) => `[discussion ${id}]`).join(", ")}`;
    }
    lines.push(`  · ${label}${update.timeupdated ? ` (${formatDate(update.timeupdated)})` : ""}`);
  }
  const files = (module?.contents ?? []).filter((file) => file.type !== "url" && file.fileurl && (file.timemodified ?? 0) >= since);
  for (const file of files.slice(0, MAX_NEW_FILES)) {
    lines.push(`  · file: ${file.filename ?? "unnamed"} (${formatBytes(file.filesize)}, ${formatDate(file.timemodified)}) ${cleanFileUrl(file.fileurl!)}`);
  }
  if (files.length > MAX_NEW_FILES) lines.push(`  · …and ${files.length - MAX_NEW_FILES} more files`);
  return lines.join("\n");
}

export async function getRecentChanges(client: MoodleClient, args: { since?: string; course_id?: number }): Promise<string> {
  const now = nowSeconds();
  let since = now - 7 * DAY;
  if (args.since !== undefined) {
    const parsed = parseDateInput(args.since);
    if (parsed === undefined) throw new MoodleError(`"${args.since}" is not a date. Use YYYY-MM-DD or YYYY-MM-DD HH:MM.`, "badargs");
    if (parsed > now) throw new MoodleError(`"${args.since}" is in the future.`, "badargs");
    since = parsed;
  }
  const scope = await getScopeCourses(client, args.course_id);
  const failed: string[] = [];
  const blocks = await mapLimit(scope, 4, async (course) => {
    let changes: ModuleUpdates[];
    try {
      const data = await client.call<{ instances: ModuleUpdates[] }>("core_course_get_updates_since", { courseid: course.id, since });
      changes = (data.instances ?? []).filter((instance) => instance.contextlevel === "module" && instance.updates?.length);
    } catch (err) {
      if (err instanceof NotLoggedInError) throw err;
      failed.push(course.fullname);
      return "";
    }
    if (!changes.length) return "";
    const modules = new Map<number, CourseModule>();
    try {
      for (const section of await getContents(client, course.id)) for (const module of section.modules) modules.set(module.id, module);
    } catch (err) {
      if (err instanceof NotLoggedInError) throw err;
      // Without the contents the changes are still worth listing by id.
    }
    const shown = changes.slice(0, MAX_CHANGED_MODULES).map((change) => describeChange(change, modules.get(change.id), since));
    const more = changes.length > shown.length ? `\n(${changes.length - shown.length} more changed activities not shown.)` : "";
    return `## ${course.fullname} [course ${course.id}] — ${changes.length} changed\n${shown.join("\n")}${more}`;
  });
  const found = blocks.filter(Boolean);
  const scopeNote = `${scope.length} ${scope.length === 1 ? "course" : "courses"} checked`;
  const failedNote = failed.length ? `\nCould not check: ${failed.join("; ")}.` : "";
  if (!found.length) return `Nothing has changed since ${formatDate(since)} (${scopeNote}).${failedNote}`;
  return `Changes since ${formatDate(since)} (${scopeNote}). Read new posts with get_discussion and new files with get_file.\n\n${found.join("\n\n")}${failedNote}`;
}

// ---------------------------------------------------------- notifications

export interface Notification {
  id: number;
  subject?: string;
  smallmessage?: string;
  fullmessage?: string;
  fullmessagehtml?: string;
  contexturl?: string | null;
  userfromfullname?: string;
  useridfrom?: number;
  timecreated?: number;
  read?: boolean;
  component?: string;
}

export interface NotificationPage {
  notifications: Notification[];
  unreadcount: number;
}

/** Reads notifications without marking any of them as read. */
export async function fetchNotifications(client: MoodleClient, limit: number): Promise<NotificationPage> {
  const info = await client.siteInfo();
  const data = await client.call<Partial<NotificationPage>>("message_popup_get_popup_notifications", {
    useridto: info.userid,
    newestfirst: true,
    limit,
    offset: 0,
  });
  return { notifications: data.notifications ?? [], unreadcount: data.unreadcount ?? 0 };
}

const UNREAD_SCAN = 100;

export async function getNotifications(client: MoodleClient, args: { unread_only?: boolean; limit?: number }): Promise<string> {
  const limit = args.limit ?? 20;
  const page = await fetchNotifications(client, args.unread_only ? Math.max(limit, UNREAD_SCAN) : limit);
  const wanted = (args.unread_only ? page.notifications.filter((n) => !n.read) : page.notifications).slice(0, limit);
  const total = `${page.unreadcount} unread in total`;
  if (!wanted.length) return args.unread_only ? "No unread notifications." : "No notifications.";
  const lines = wanted.map((n) => {
    const subject = htmlToText(n.subject) || "(no subject)";
    // Moodle's own system user has no useful name.
    const from = n.userfromfullname && (n.useridfrom ?? 0) > 0 ? ` — from ${n.userfromfullname}` : "";
    const out = [`- [notification ${n.id}]${n.read ? "" : " (unread)"} ${formatDate(n.timecreated)} — ${subject}${from}`];
    // Moodle's plain-text emails separate their parts with long rules of dashes.
    const body = truncate(summarize(n.fullmessage || n.fullmessagehtml || n.smallmessage, 2000).replace(/\s*[-_=]{5,}\s*/g, " — "), 500);
    if (body && body !== subject) out.push(`  ${body}`);
    if (n.contexturl) out.push(`  ${n.contexturl}`);
    return out.join("\n");
  });
  const kind = args.unread_only ? "unread notifications" : "notifications";
  return `${wanted.length} ${kind}, newest first (${total}). Reading them here does not mark them as read in Moodle.\n${lines.join("\n")}`;
}

// --------------------------------------------------------------- messages

interface Member {
  id: number;
  fullname?: string;
}

interface ChatMessage {
  id: number;
  useridfrom: number;
  text?: string;
  timecreated?: number;
}

interface Conversation {
  id: number;
  name?: string | null;
  /** 1 = between two people, 2 = group, 3 = notes to self. */
  type?: number;
  membercount?: number;
  unreadcount?: number | null;
  isread?: boolean;
  members?: Member[];
  messages?: ChatMessage[];
}

const DISABLED_CODES = new Set(["disabled", "disabledmessaging"]);

async function messaging<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (err) {
    if (err instanceof MoodleError && err.errorcode && DISABLED_CODES.has(err.errorcode)) {
      throw new MoodleError("Private messaging is switched off on this Moodle site, so there are no conversations to read.", err.errorcode);
    }
    throw err;
  }
}

function conversationTitle(conversation: Conversation, self: number): string {
  if (conversation.type === 3) return "Notes to self";
  const name = htmlToText(conversation.name ?? "");
  if (name) return name;
  const others = (conversation.members ?? []).filter((member) => member.id !== self).map((member) => member.fullname ?? `user ${member.id}`);
  return others.join(", ") || "Unnamed conversation";
}

export async function getMessages(client: MoodleClient, args: { conversation_id?: number; limit?: number }): Promise<string> {
  const info = await client.siteInfo();
  if (args.conversation_id === undefined) {
    const data = await messaging(() =>
      client.call<{ conversations: Conversation[] }>("core_message_get_conversations", {
        userid: info.userid,
        limitfrom: 0,
        limitnum: args.limit ?? 20,
        mergeself: true,
      }),
    );
    const conversations = data.conversations ?? [];
    if (!conversations.length) return "No conversations.";
    const lines = conversations.map((conversation) => {
      const unread = conversation.unreadcount ? ` (${conversation.unreadcount} unread)` : "";
      const group = conversation.type === 2 ? `, group of ${conversation.membercount ?? "?"}` : "";
      const head = `- [conversation ${conversation.id}] ${conversationTitle(conversation, info.userid)}${group}${unread}`;
      const last = conversation.messages?.[conversation.messages.length - 1];
      if (!last) return head;
      const author = last.useridfrom === info.userid ? "you" : (conversation.members?.find((m) => m.id === last.useridfrom)?.fullname ?? "them");
      return `${head}\n  last message, ${formatDate(last.timecreated)}, ${author}: ${summarize(last.text, 200)}`;
    });
    return `${conversations.length} conversations, most recent first. Read one with get_messages and its conversation_id. Reading here does not mark anything as read.\n${lines.join("\n")}`;
  }

  const data = await messaging(() =>
    client.call<{ id: number; members?: Member[]; messages?: ChatMessage[] }>("core_message_get_conversation_messages", {
      currentuserid: info.userid,
      convid: args.conversation_id,
      limitfrom: 0,
      limitnum: args.limit ?? 30,
      newest: true,
    }),
  );
  const messages = (data.messages ?? []).slice().sort((a, b) => (a.timecreated ?? 0) - (b.timecreated ?? 0));
  if (!messages.length) return `Conversation ${args.conversation_id} has no messages.`;
  const names = new Map((data.members ?? []).map((member) => [member.id, member.fullname ?? `user ${member.id}`]));
  const lines = messages.map((message) => {
    const author = message.useridfrom === info.userid ? "You" : (names.get(message.useridfrom) ?? `user ${message.useridfrom}`);
    return `${formatDate(message.timecreated)} — ${author}:\n${truncate(htmlToText(message.text), 2000)}`;
  });
  return `Conversation ${args.conversation_id}, latest ${messages.length} messages, oldest first:\n\n${lines.join("\n\n")}`;
}
