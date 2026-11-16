import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getFile } from "./files.js";
import { MoodleClient } from "./moodle.js";
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

export const VERSION = "0.1.0";

const id = (what: string) => z.coerce.number().int().positive().describe(what);

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

async function run(fn: () => Promise<string>): Promise<ToolResult> {
  try {
    return { content: [{ type: "text", text: await fn() }] };
  } catch (err) {
    return { content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }], isError: true };
  }
}

export function createServer(client: MoodleClient, options: { cacheDir: string }): McpServer {
  const server = new McpServer(
    { name: "moodle-mcp", version: VERSION },
    {
      instructions:
        `Read-only access to the user's own Moodle account at ${client.url} (student view): courses, course materials, assignments, deadlines, grades and forums. ` +
        "Typical flow: list_courses to get course ids, then get_course_contents, list_assignments, get_grades or list_forum_discussions for one course. " +
        "Ids are shown in square brackets, e.g. [course 12], [forum 7], [discussion 99]. Nothing here can submit, post or modify anything in Moodle.",
    },
  );
  const annotations = { readOnlyHint: true, openWorldHint: true };

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

  return server;
}
