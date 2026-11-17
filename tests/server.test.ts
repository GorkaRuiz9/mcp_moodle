import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { parseWriteGroups, WriteGroup } from "../src/confirm.js";
import { createServer } from "../src/server.js";
import { fakeMoodle } from "./helpers.js";

const READ_TOOLS = [
  "get_calendar_events",
  "get_course_contents",
  "get_course_participants",
  "get_discussion",
  "get_file",
  "get_grades",
  "get_messages",
  "get_notifications",
  "get_quiz_attempt",
  "get_recent_changes",
  "get_upcoming_deadlines",
  "list_assignments",
  "list_courses",
  "list_forum_discussions",
  "list_quizzes",
  "search_courses_content",
];

const WRITE_TOOLS: Record<WriteGroup, string[]> = {
  entregas: ["save_assignment_submission"],
  foros: ["add_forum_discussion", "reply_to_forum_post"],
  calendario: ["create_calendar_event", "delete_calendar_event"],
  seguimiento: ["set_activity_completion"],
  notificaciones: ["mark_notifications_read"],
};

type Answer = { action: "accept" | "decline" | "cancel"; content?: Record<string, unknown> };

/** Connects a real MCP client to the server; `answer` plays the person at the confirmation prompt. */
async function connect(write: string | undefined, answer?: (message: string) => Answer) {
  const handlers = {
    core_calendar_create_calendar_events: () => ({ events: [{ id: 321 }], warnings: [] }),
    core_enrol_get_users_courses: () => [],
  };
  const moodle = fakeMoodle(handlers);
  const server = createServer(moodle.client, { cacheDir: "/nonexistent", writeGroups: parseWriteGroups(write) });
  const client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: answer ? { elicitation: {} } : {} });
  const prompts: string[] = [];
  if (answer) {
    client.setRequestHandler(ElicitRequestSchema, async (request) => {
      prompts.push(request.params.message);
      return answer(request.params.message);
    });
  }
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return { client, moodle, prompts };
}

const text = (result: unknown) => (result as { content: { text: string }[] }).content[0]!.text;
const event = { name: "create_calendar_event", arguments: { name: "Estudiar", start: "2026-12-01 18:00" } };

describe("tool list", () => {
  it("is read-only by default: no writing tool is even listed", async () => {
    const { client } = await connect(undefined);
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual(READ_TOOLS);
    expect(tools.every((tool) => tool.annotations?.readOnlyHint === true)).toBe(true);
    expect(client.getInstructions()).toContain("Everything here is read-only");
  });

  it("adds exactly the tools of the groups that were switched on", async () => {
    for (const group of Object.keys(WRITE_TOOLS) as WriteGroup[]) {
      const { client } = await connect(group);
      const names = (await client.listTools()).tools.map((tool) => tool.name);
      expect(names.filter((name) => !READ_TOOLS.includes(name)).sort()).toEqual([...WRITE_TOOLS[group]].sort());
    }
    const { client } = await connect("todo");
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(READ_TOOLS.length + Object.values(WRITE_TOOLS).flat().length);
    const writers = tools.filter((tool) => !READ_TOOLS.includes(tool.name));
    expect(writers.every((tool) => tool.annotations?.readOnlyHint === false && /must approve it in a confirmation prompt/.test(tool.description ?? ""))).toBe(true);
    expect(client.getInstructions()).toContain("confirmation prompt");
  });

  it("cannot call a writing tool that was not switched on", async () => {
    const { client, moodle } = await connect("foros", () => ({ action: "accept", content: { confirmar: true } }));
    const result = await client.callTool(event);
    expect(result.isError).toBe(true);
    expect(moodle.calls).toEqual([]);
  });
});

describe("confirmation prompt", () => {
  it("writes once the person ticks the box and accepts", async () => {
    const { client, moodle, prompts } = await connect("calendario", () => ({ action: "accept", content: { confirmar: true } }));
    const result = await client.callTool(event);
    expect(result.isError).toBeFalsy();
    expect(text(result)).toContain("[event 321]");
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("Nombre: Estudiar");
    expect(moodle.calls).toEqual(["core_calendar_create_calendar_events"]);
  });

  it("asks again every time: one approval does not cover the next call", async () => {
    const { client, prompts } = await connect("calendario", () => ({ action: "accept", content: { confirmar: true } }));
    await client.callTool(event);
    await client.callTool(event);
    expect(prompts).toHaveLength(2);
  });

  it("writes nothing unless the answer is an explicit yes", async () => {
    const answers: Answer[] = [
      { action: "decline" },
      { action: "cancel" },
      { action: "accept", content: { confirmar: false } },
    ];
    for (const answer of answers) {
      const { client, moodle } = await connect("calendario", () => answer);
      const result = await client.callTool(event);
      expect(result.isError).toBe(true);
      expect(text(result)).toContain("did not approve");
      expect(moodle.calls).toEqual([]);
    }
  });

  it("refuses when the client cannot show a prompt", async () => {
    const { client, moodle } = await connect("calendario");
    const result = await client.callTool(event);
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("this MCP client cannot show one");
    expect(text(result)).toContain("Nothing was changed");
    expect(moodle.calls).toEqual([]);
  });

  it("does not interrupt reading tools", async () => {
    const { client, prompts } = await connect("todo", () => ({ action: "accept", content: { confirmar: true } }));
    const result = await client.callTool({ name: "list_courses", arguments: {} });
    expect(text(result)).toContain("not enrolled");
    expect(prompts).toEqual([]);
  });
});
