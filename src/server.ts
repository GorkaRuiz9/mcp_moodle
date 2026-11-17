import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getCalendarEvents } from "./calendar.js";
import { Confirm, ConfirmationError, DECLINED_MESSAGE, UNSUPPORTED_MESSAGE, WriteGroup } from "./confirm.js";
import { getFile } from "./files.js";
import { MoodleClient } from "./moodle.js";
import { getMessages, getNotifications, getRecentChanges } from "./news.js";
import { getCourseParticipants } from "./people.js";
import { getQuizAttempt, listQuizzes } from "./quiz.js";
import {
  addForumDiscussion,
  createCalendarEvent,
  deleteCalendarEvent,
  markNotificationsRead,
  replyToForumPost,
  saveAssignmentSubmission,
  setActivityCompletion,
} from "./writes.js";
import {
  getCourseContents,
  getDiscussion,
  getGrades,
  getUpcomingDeadlines,
  listAssignments,
  listCourses,
  listForumDiscussions,
  searchCoursesContent,
} from "./tools.js";

export const VERSION = "0.2.0";

const id = (what: string) => z.coerce.number().int().positive().describe(what);

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

async function run(fn: () => Promise<string>): Promise<ToolResult> {
  try {
    return { content: [{ type: "text", text: await fn() }] };
  } catch (err) {
    return { content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }], isError: true };
  }
}

/** How long a person gets to read a confirmation prompt and answer it. */
const CONFIRM_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Asks the person at the keyboard through MCP elicitation. The prompt is
 * shown by the client, outside the model's control, so the model cannot
 * approve its own request. Clients without elicitation get a refusal.
 */
function elicitationConfirm(server: McpServer): Confirm {
  return async (message) => {
    const capabilities = server.server.getClientCapabilities();
    if (!capabilities?.elicitation) throw new ConfirmationError(UNSUPPORTED_MESSAGE, "noconfirmation");
    let result;
    try {
      result = await server.server.elicitInput(
        {
          mode: "form",
          message,
          requestedSchema: {
            type: "object",
            properties: {
              confirmar: {
                type: "boolean",
                title: "Confirmo esta acción",
                description: "Márcalo solo si has leído el resumen y quieres que se haga exactamente eso en Moodle.",
                default: false,
              },
            },
            required: ["confirmar"],
          },
        },
        { timeout: CONFIRM_TIMEOUT_MS },
      );
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      if (/does not support/i.test(reason)) throw new ConfirmationError(UNSUPPORTED_MESSAGE, "noconfirmation");
      throw new ConfirmationError(`Nothing was changed in Moodle: the confirmation prompt could not be completed (${reason}).`, "noconfirmation");
    }
    if (result.action !== "accept" || result.content?.confirmar !== true) throw new ConfirmationError(DECLINED_MESSAGE, "declined");
  };
}

export interface ServerOptions {
  cacheDir: string;
  /** Groups of writing tools to expose. Empty or missing: the server is read-only. */
  writeGroups?: ReadonlySet<WriteGroup>;
  /** Replaces the elicitation prompt; for tests. */
  confirm?: Confirm;
}

export function createServer(client: MoodleClient, options: ServerOptions): McpServer {
  const writeGroups = options.writeGroups ?? new Set<WriteGroup>();
  const server = new McpServer(
    { name: "moodle-mcp", version: VERSION },
    {
      instructions:
        `Access to the user's own Moodle account at ${client.url} (student view): courses, course materials, assignments, deadlines, calendar, grades, quizzes, forums, notifications, messages and course participants. ` +
        "Typical flow: list_courses to get course ids, then get_course_contents, list_assignments, get_grades or list_forum_discussions for one course. For 'what is new' use get_recent_changes and get_notifications. " +
        "Ids are shown in square brackets, e.g. [course 12], [forum 7], [discussion 99]. " +
        (writeGroups.size
          ? "A few tools change things in Moodle (their descriptions say so). Each of them shows the user a confirmation prompt with exactly what will be sent and does nothing unless the user approves it there; " +
            "use them only when the user asked for that change, and if the user declines do not retry. Quizzes can never be started or answered, and an assignment can never be submitted for grading from here."
          : "Everything here is read-only: nothing can submit, post or modify anything in Moodle."),
    },
  );
  const annotations = { readOnlyHint: true, openWorldHint: true };
  const confirm = options.confirm ?? elicitationConfirm(server);

  server.registerTool(
    "list_courses",
    {
      title: "List courses",
      description: "Lists the courses the user is enrolled in, with their ids. Start here: most other tools need a course id.",
      inputSchema: {
        filter: z.enum(["current", "all"]).optional().describe('"current" (default) hides courses whose end date has passed; "all" includes past courses.'),
      },
      annotations,
    },
    (args) => run(() => listCourses(client, args)),
  );

  server.registerTool(
    "get_course_contents",
    {
      title: "Get course contents",
      description:
        "Shows the sections of a course and everything in them: files, links, pages, assignments, forums, quizzes. File entries include a URL that get_file can download. Large courses produce long output; pass section_number to read a single section.",
      inputSchema: {
        course_id: id("Course id from list_courses."),
        section_number: z.coerce.number().int().min(0).optional().describe("Only this section (the number shown in the section heading). Omit for the whole course."),
      },
      annotations,
    },
    (args) => run(() => getCourseContents(client, args)),
  );

  server.registerTool(
    "list_assignments",
    {
      title: "List assignments",
      description:
        "Lists assignments (Moodle 'assign' activities) with due date, the user's submission status and grade. Covers all current courses unless course_id is given. By default only assignments that are not yet due.",
      inputSchema: {
        course_id: id("Limit to one course.").optional(),
        include_past: z.boolean().optional().describe("Also include assignments whose due date has passed. Default false."),
      },
      annotations,
    },
    (args) => run(() => listAssignments(client, args)),
  );

  server.registerTool(
    "get_upcoming_deadlines",
    {
      title: "Get upcoming deadlines",
      description:
        "Lists what is due soon across all courses, from the Moodle timeline: assignment due dates, quiz closing times and other dated activities. Best tool for 'what do I have to hand in this week'. Moodle leaves out what the user has already completed or submitted; use list_assignments to see those too.",
      inputSchema: {
        days: z.coerce.number().int().min(1).max(365).optional().describe("How many days ahead to look. Default 14."),
      },
      annotations,
    },
    (args) => run(() => getUpcomingDeadlines(client, args)),
  );

  server.registerTool(
    "get_grades",
    {
      title: "Get grades",
      description: "Without course_id: the user's total grade in every course. With course_id: every grade item of that course with grade, range, weight and feedback.",
      inputSchema: {
        course_id: id("Course to break down item by item.").optional(),
      },
      annotations,
    },
    (args) => run(() => getGrades(client, args)),
  );

  server.registerTool(
    "list_forum_discussions",
    {
      title: "List forum discussions",
      description:
        "Lists forum discussions, including teacher announcements. With course_id: every forum of the course with its latest discussions. With forum_id: more discussions of that one forum. One of the two is required.",
      inputSchema: {
        course_id: id("Course whose forums to list.").optional(),
        forum_id: id("A single forum, as shown in [forum N].").optional(),
        limit: z.coerce.number().int().min(1).max(50).optional().describe("Discussions per forum. Default 5 with course_id, 15 with forum_id."),
      },
      annotations,
    },
    (args) => run(() => listForumDiscussions(client, args)),
  );

  server.registerTool(
    "get_discussion",
    {
      title: "Get discussion",
      description: "Returns every post of a forum discussion, oldest first, with author and date.",
      inputSchema: {
        discussion_id: id("Discussion id as shown in [discussion N] by list_forum_discussions."),
      },
      annotations,
    },
    (args) => run(() => getDiscussion(client, args)),
  );

  server.registerTool(
    "get_file",
    {
      title: "Get file",
      description:
        "Downloads a course file to a local cache folder and returns its path. For PDFs and plain-text files it also returns the text, about 20,000 characters per call; continue a long PDF with start_page. Other formats (pptx, docx, images) are only saved to disk.",
      inputSchema: {
        url: z.string().min(1).describe('A "file:" URL from get_course_contents or search_courses_content. Must be on the Moodle site.'),
        start_page: z.coerce.number().int().min(1).optional().describe("First PDF page to return text from. Default 1."),
      },
      annotations,
    },
    (args) => run(() => getFile(client, args, { cacheDir: options.cacheDir })),
  );

  server.registerTool(
    "search_courses_content",
    {
      title: "Search course contents",
      description:
        "Finds sections, activities and files whose title, description or file name contains every word of the query (case and accents ignored). Searches all current courses unless course_id is given. Does not search the text inside files.",
      inputSchema: {
        query: z.string().min(1).describe('Words to look for, e.g. "tema 3" or "examen parcial".'),
        course_id: id("Limit the search to one course.").optional(),
      },
      annotations,
    },
    (args) => run(() => searchCoursesContent(client, args)),
  );

  server.registerTool(
    "get_recent_changes",
    {
      title: "Get recent changes",
      description:
        "Lists what teachers have added or changed in the user's courses since a date: new or updated files and activities, new forum posts, changed grades. Best tool for 'what is new in my courses'. Covers all current courses unless course_id is given.",
      inputSchema: {
        since: z.string().optional().describe('Date to look back to, as "YYYY-MM-DD" or "YYYY-MM-DD HH:MM" (local time). Default: 7 days ago.'),
        course_id: id("Limit to one course.").optional(),
      },
      annotations,
    },
    (args) => run(() => getRecentChanges(client, args)),
  );

  server.registerTool(
    "get_notifications",
    {
      title: "Get notifications",
      description:
        "Lists the user's Moodle notifications (the bell icon): graded work, new forum posts, submission receipts, reminders. Newest first. Reading them here does not mark them as read.",
      inputSchema: {
        unread_only: z.boolean().optional().describe("Only notifications not yet read. Default false."),
        limit: z.coerce.number().int().min(1).max(100).optional().describe("How many to return. Default 20."),
      },
      annotations,
    },
    (args) => run(() => getNotifications(client, args)),
  );

  server.registerTool(
    "get_messages",
    {
      title: "Get private messages",
      description:
        "Reads the user's private Moodle messages. Without conversation_id: the list of conversations with the last message of each. With conversation_id: the latest messages of that conversation. Does not mark anything as read. Some sites have messaging switched off.",
      inputSchema: {
        conversation_id: id("Conversation to read, as shown in [conversation N].").optional(),
        limit: z.coerce.number().int().min(1).max(100).optional().describe("Conversations (default 20) or messages (default 30) to return."),
      },
      annotations,
    },
    (args) => run(() => getMessages(client, args)),
  );

  server.registerTool(
    "list_quizzes",
    {
      title: "List quizzes",
      description:
        "Lists quizzes with opening and closing times, time limit, attempts allowed, and the user's own attempts with their grades. Covers all current courses unless course_id is given. Quizzes cannot be started or answered from here.",
      inputSchema: {
        course_id: id("Limit to one course.").optional(),
      },
      annotations,
    },
    (args) => run(() => listQuizzes(client, args)),
  );

  server.registerTool(
    "get_quiz_attempt",
    {
      title: "Get quiz attempt review",
      description:
        "Shows the review of one of the user's FINISHED quiz attempts: each question, what the user answered, whether it was right, the mark and the feedback, as far as the teacher allows. Useful for studying past mistakes. Attempts still in progress are refused.",
      inputSchema: {
        attempt_id: id("Attempt id as shown in [attempt N] by list_quizzes."),
      },
      annotations,
    },
    (args) => run(() => getQuizAttempt(client, args)),
  );

  server.registerTool(
    "get_calendar_events",
    {
      title: "Get calendar events",
      description:
        "Lists everything in the user's Moodle calendar for a period: exams, classes and course events, personal events, and activity dates (openings, due dates). Unlike get_upcoming_deadlines it also shows events that need no action and can look at any date range.",
      inputSchema: {
        from: z.string().optional().describe('First day, as "YYYY-MM-DD" or "YYYY-MM-DD HH:MM" (local time). Default: now.'),
        days: z.coerce.number().int().min(1).max(365).optional().describe("Length of the period in days. Default 30."),
        course_id: id("Only events of this course (leaves out personal and site events).").optional(),
      },
      annotations,
    },
    (args) => run(() => getCalendarEvents(client, args)),
  );

  server.registerTool(
    "get_course_participants",
    {
      title: "Get course participants",
      description:
        "Lists the people in a course: teachers with their email address, other participants by name, each one's groups, and the groups the user belongs to. Classmates' email addresses are not shown.",
      inputSchema: {
        course_id: id("Course id from list_courses."),
        only_teachers: z.boolean().optional().describe("Only the teaching staff. Default false."),
        search: z.string().optional().describe("Only people whose name contains these words."),
      },
      annotations,
    },
    (args) => run(() => getCourseParticipants(client, args)),
  );

  // ------------------------------------------------------------- writing
  // Registered only for the groups named in MOODLE_MCP_WRITE. Every one of
  // them stops at a confirmation prompt before touching Moodle.

  const APPROVAL = " Changes Moodle: the user is shown exactly what will be sent and must approve it in a confirmation prompt; without that approval nothing happens.";
  const writing = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };

  if (writeGroups.has("calendario")) {
    server.registerTool(
      "create_calendar_event",
      {
        title: "Create personal calendar event",
        description: "Adds a personal event (visible only to the user) to their Moodle calendar." + APPROVAL,
        inputSchema: {
          name: z.string().min(1).max(200).describe("Event title."),
          start: z.string().describe('When it starts, as "YYYY-MM-DD HH:MM" (local time).'),
          duration_minutes: z.coerce.number().int().min(0).max(60 * 24 * 30).optional().describe("How long it lasts. Default 0 (no duration)."),
          description: z.string().max(5000).optional().describe("Optional notes, in Markdown."),
        },
        annotations: writing,
      },
      (args) => run(() => createCalendarEvent(client, args, confirm)),
    );

    server.registerTool(
      "delete_calendar_event",
      {
        title: "Delete personal calendar event",
        description: "Deletes one of the user's own personal calendar events. Course, group and site events cannot be deleted." + APPROVAL,
        inputSchema: {
          event_id: id("Event id as shown in [event N] by get_calendar_events."),
        },
        annotations: { ...writing, destructiveHint: true },
      },
      (args) => run(() => deleteCalendarEvent(client, args, confirm)),
    );
  }

  if (writeGroups.has("seguimiento")) {
    server.registerTool(
      "set_activity_completion",
      {
        title: "Mark activity as completed",
        description:
          "Ticks or unticks an activity as completed, only for activities whose completion the student marks by hand. Activities that Moodle completes automatically are refused." + APPROVAL,
        inputSchema: {
          cmid: id("Course module id as shown in [cmid N] by get_course_contents."),
          completed: z.boolean().describe("true to mark it as completed, false to unmark it."),
        },
        annotations: { ...writing, idempotentHint: true },
      },
      (args) => run(() => setActivityCompletion(client, args, confirm)),
    );
  }

  if (writeGroups.has("notificaciones")) {
    server.registerTool(
      "mark_notifications_read",
      {
        title: "Mark notifications as read",
        description: "Marks notifications as read in Moodle, either the ones listed or all unread ones. This cannot be undone." + APPROVAL,
        inputSchema: {
          notification_ids: z.array(id("Notification id.")).max(100).optional().describe("Ids as shown in [notification N] by get_notifications."),
          all: z.boolean().optional().describe("true to mark every unread notification. Use instead of notification_ids."),
        },
        annotations: { ...writing, idempotentHint: true },
      },
      (args) => run(() => markNotificationsRead(client, args, confirm)),
    );
  }

  if (writeGroups.has("foros")) {
    server.registerTool(
      "add_forum_discussion",
      {
        title: "Start forum discussion",
        description:
          "Starts a new discussion in a forum, published under the user's name and visible to the forum's participants. Text only, no attachments. Write the message exactly as the user wants it posted." + APPROVAL,
        inputSchema: {
          forum_id: id("Forum id as shown in [forum N] by list_forum_discussions."),
          subject: z.string().min(1).max(255).describe("Title of the discussion."),
          message: z.string().min(1).max(20000).describe("Body of the post, in Markdown."),
        },
        annotations: writing,
      },
      (args) => run(() => addForumDiscussion(client, args, confirm)),
    );

    server.registerTool(
      "reply_to_forum_post",
      {
        title: "Reply to forum post",
        description:
          "Replies to a post of a forum discussion, published under the user's name. To reply to the discussion as a whole, reply to its first post. Text only, no attachments. Write the message exactly as the user wants it posted." +
          APPROVAL,
        inputSchema: {
          post_id: id("Post to reply to, as shown in [post N] by get_discussion."),
          message: z.string().min(1).max(20000).describe("Body of the reply, in Markdown."),
          subject: z.string().max(255).optional().describe('Subject line. Default: "Re: " plus the subject of the post being answered.'),
        },
        annotations: writing,
      },
      (args) => run(() => replyToForumPost(client, args, confirm)),
    );
  }

  if (writeGroups.has("entregas")) {
    server.registerTool(
      "save_assignment_submission",
      {
        title: "Save assignment submission",
        description:
          "Uploads files and/or online text to the user's submission of an assignment. Where the assignment has a draft stage this only saves a DRAFT, and the user must still press 'Submit assignment' on the Moodle website: it can never be submitted for grading from here. " +
          "Where the assignment has no draft stage, saving IS the submission (the confirmation prompt says so). Files already in the submission are kept unless replace_existing is set; a new file replaces one with the same name. " +
          "Refused if the assignment is already submitted for grading, graded or closed." +
          APPROVAL,
        inputSchema: {
          assign_id: id("Assignment id as shown in [assign N] by list_assignments."),
          files: z.array(z.string().min(1)).max(20).optional().describe("Absolute paths of local files to upload."),
          text: z.string().max(100000).optional().describe("Online text for assignments that ask for it, in Markdown. Replaces the text already saved."),
          replace_existing: z.boolean().optional().describe("true to remove the files already in the submission before adding the new ones. Default false (keep them)."),
        },
        annotations: { ...writing, destructiveHint: true },
      },
      (args) => run(() => saveAssignmentSubmission(client, args, confirm)),
    );
  }

  return server;
}
