import { MoodleError } from "./moodle.js";

/**
 * Groups of tools that change something in Moodle. None is registered unless
 * the person running the server names it in MOODLE_MCP_WRITE.
 */
export const WRITE_GROUPS = ["entregas", "foros", "calendario", "seguimiento", "notificaciones"] as const;
export type WriteGroup = (typeof WRITE_GROUPS)[number];

const ALIASES: Record<string, WriteGroup> = {
  assignments: "entregas",
  forums: "foros",
  calendar: "calendario",
  completion: "seguimiento",
  notifications: "notificaciones",
};

/** Parses MOODLE_MCP_WRITE: a comma-separated list of groups, or "todo" for all of them. */
export function parseWriteGroups(value: string | undefined): Set<WriteGroup> {
  const groups = new Set<WriteGroup>();
  for (const raw of (value ?? "").split(/[,\s]+/)) {
    const name = raw.trim().toLowerCase();
    if (!name) continue;
    if (name === "todo" || name === "all") {
      WRITE_GROUPS.forEach((group) => groups.add(group));
      continue;
    }
    const group = (WRITE_GROUPS as readonly string[]).includes(name) ? (name as WriteGroup) : ALIASES[name];
    if (!group) {
      throw new Error(`MOODLE_MCP_WRITE: unknown group "${raw}". Valid groups: ${WRITE_GROUPS.join(", ")} (or "todo" for all of them).`);
    }
    groups.add(group);
  }
  return groups;
}

/**
 * Shows the person at the keyboard exactly what is about to change and
 * resolves only if they approve. Rejects with ConfirmationError otherwise.
 * The text is for a human, so it is written in Spanish like the README.
 */
export type Confirm = (message: string) => Promise<void>;

export class ConfirmationError extends MoodleError {
  constructor(message: string, code: "declined" | "noconfirmation") {
    super(message, code);
    this.name = "ConfirmationError";
  }
}

export const DECLINED_MESSAGE =
  "The user did not approve this action, so nothing was changed in Moodle. Do not try again unless the user asks for it.";

export const UNSUPPORTED_MESSAGE =
  "Nothing was changed in Moodle. This action needs the user's explicit approval through an MCP elicitation prompt, and this MCP client cannot show one. " +
  "Tell the user to do it on the Moodle website, or to use a client that supports MCP elicitation.";

const WEEKDAYS = ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"];
const two = (n: number) => String(n).padStart(2, "0");

/** A date the way the confirmation prompts show it: "jue 20/11/2026 10:00". */
export function fecha(ts: number | null | undefined): string {
  if (!ts) return "sin fecha";
  const d = new Date(ts * 1000);
  return `${WEEKDAYS[d.getDay()]} ${two(d.getDate())}/${two(d.getMonth() + 1)}/${d.getFullYear()} ${two(d.getHours())}:${two(d.getMinutes())}`;
}
