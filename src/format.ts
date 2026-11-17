const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  laquo: "«",
  raquo: "»",
  iexcl: "¡",
  iquest: "¿",
  euro: "€",
  deg: "°",
  middot: "·",
  bull: "•",
  aacute: "á",
  eacute: "é",
  iacute: "í",
  oacute: "ó",
  uacute: "ú",
  ntilde: "ñ",
  uuml: "ü",
  ccedil: "ç",
  ordf: "ª",
  ordm: "º",
};

function namedEntity(name: string): string | undefined {
  const exact = ENTITIES[name];
  if (exact) return exact;
  // &Aacute; and friends: same letter, upper case.
  const lower = ENTITIES[name.toLowerCase()];
  return lower && /^[A-Z]/.test(name) && lower.length === 1 ? lower.toUpperCase() : lower;
}

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (match, body: string) => {
    if (body[0] === "#") {
      const code = body[1]?.toLowerCase() === "x" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      try {
        return String.fromCodePoint(code);
      } catch {
        return match;
      }
    }
    return namedEntity(body) ?? match;
  });
}

/** Converts Moodle's HTML fragments into compact plain text. */
export function htmlToText(html: string | number | null | undefined): string {
  if (html === null || html === undefined || html === "") return "";
  // Moodle sends some "text" fields (grades, marks) as bare numbers.
  let text = String(html)
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, "")
    // Keep link targets: <a href="u">t</a> -> t (u)
    .replace(/<a\b[^>]*?href\s*=\s*["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, inner: string) => {
      const label = inner.replace(/<[^>]+>/g, "").trim();
      if (!href || href.startsWith("#")) return label;
      return label && label !== href ? `${label} (${href})` : href;
    })
    .replace(/<img\b[^>]*?alt\s*=\s*["']([^"']+)["'][^>]*>/gi, "[image: $1]")
    // Swallow the line breaks HTML puts between items, or the list comes out double-spaced.
    .replace(/\s*<li\b[^>]*>\s*/gi, "\n- ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|h[1-6]|tr|ul|ol|table|blockquote|section)>/gi, "\n")
    .replace(/<\/(td|th)>/gi, " | ")
    .replace(/<[^>]+>/g, "");
  text = decodeEntities(text);
  return text
    .replace(/\r/g, "")
    .replace(/[ \t ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max).trimEnd() + "…";
}

/** One-line version of an HTML fragment, capped at `max` characters. */
export function summarize(html: string | null | undefined, max = 300): string {
  return truncate(htmlToText(html).replace(/\s*\n\s*/g, " "), max);
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const pad = (n: number) => String(n).padStart(2, "0");

/** Formats a Unix timestamp (seconds) in the machine's local time zone. */
export function formatDate(ts: number | null | undefined): string {
  if (!ts) return "none";
  const d = new Date(ts * 1000);
  return `${DAYS[d.getDay()]} ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function relativeTime(ts: number, now: number = Date.now() / 1000): string {
  const diff = ts - now;
  const abs = Math.abs(diff);
  let amount: string;
  if (abs < 3600) amount = `${Math.max(1, Math.round(abs / 60))} min`;
  else if (abs < 86400) amount = `${Math.round(abs / 3600)} h`;
  else amount = `${Math.round(abs / 86400)} d`;
  return diff >= 0 ? `in ${amount}` : `${amount} ago`;
}

export function formatDateRelative(ts: number | null | undefined, now?: number): string {
  if (!ts) return "none";
  return `${formatDate(ts)} (${relativeTime(ts, now)})`;
}

export function formatBytes(bytes: number | null | undefined): string {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${unit === 0 ? value : value.toFixed(1)} ${units[unit]}`;
}

/** Lowercases and strips accents so that "Cálculo" matches "calculo". */
export function normalizeForSearch(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
}

/**
 * Parses a date typed by a person or a model: "2026-11-20", "2026-11-20 09:30"
 * or a full ISO 8601 string. Without a time zone it is local time. Returns
 * Unix seconds, or undefined when the text is not a date.
 */
export function parseDateInput(text: string): number | undefined {
  const match = /^\s*(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?\s*(Z|[+-]\d{2}:?\d{2})?\s*$/i.exec(text);
  if (!match) return undefined;
  const [, year, month, day, hour = "0", minute = "0", second = "0", zone] = match;
  const parts = [Number(year), Number(month), Number(day), Number(hour), Number(minute), Number(second)] as const;
  if (parts[1] < 1 || parts[1] > 12 || parts[2] < 1 || parts[2] > 31 || parts[3] > 23 || parts[4] > 59 || parts[5] > 59) return undefined;
  let ms: number;
  if (zone) {
    ms = Date.parse(`${year}-${pad(parts[1])}-${pad(parts[2])}T${pad(parts[3])}:${pad(parts[4])}:${pad(parts[5])}${zone.toUpperCase()}`);
  } else {
    const local = new Date(parts[0], parts[1] - 1, parts[2], parts[3], parts[4], parts[5]);
    // new Date() rolls 31 February over into March; that is a typo, not a date.
    if (local.getMonth() !== parts[1] - 1 || local.getDate() !== parts[2]) return undefined;
    ms = local.getTime();
  }
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : undefined;
}

export function formatDuration(seconds: number): string {
  if (seconds < 3600) return `${Math.round(seconds / 60)} min`;
  if (seconds < 86400) {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.round((seconds % 3600) / 60);
    return minutes ? `${hours} h ${minutes} min` : `${hours} h`;
  }
  const days = seconds / 86400;
  return `${Number.isInteger(days) ? days : days.toFixed(1)} d`;
}

const attribute = (tag: string, name: string): string | undefined => {
  const match = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i").exec(tag);
  return match ? decodeEntities(match[1] ?? match[2] ?? "") : undefined;
};

/**
 * Plain text of a quiz question as Moodle renders it in a review page. On
 * top of htmlToText it keeps what the student answered: ticked radio buttons
 * and checkboxes, typed text, chosen menu options, and the right/wrong icons.
 */
export function questionHtmlToText(html: string | null | undefined): string {
  if (!html) return "";
  let text = html
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, "")
    // Screen-reader-only labels ("Question text", "Flag question") are noise here.
    .replace(/<(span|div|h[1-6]|label|legend)\b[^>]*class\s*=\s*["'][^"']*\b(?:accesshide|sr-only|visually-hidden)\b[^"']*["'][^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<select\b[^>]*>([\s\S]*?)<\/select>/gi, (_m, options: string) => {
      const chosen = /<option\b[^>]*\bselected\b[^>]*>([\s\S]*?)<\/option>/i.exec(options);
      const label = chosen ? chosen[1]!.replace(/<[^>]+>/g, "").trim() : "";
      return ` [chosen: ${label || "nothing"}] `;
    })
    .replace(/<input\b[^>]*>/gi, (tag) => {
      const type = (attribute(tag, "type") ?? "text").toLowerCase();
      const checked = /\bchecked\b/i.test(tag);
      if (type === "radio") return checked ? "(x) " : "( ) ";
      if (type === "checkbox") return checked ? "[x] " : "[ ] ";
      if (type === "text" || type === "number") return ` [typed: ${attribute(tag, "value") ?? ""}] `;
      return "";
    })
    .replace(/<textarea\b[^>]*>([\s\S]*?)<\/textarea>/gi, (_m, body: string) => `\n[typed: ${body.trim()}]\n`)
    // Moodle marks answers with icons whose only text is the title.
    .replace(/<i\b[^>]*>\s*<\/i>/gi, (tag) => {
      const label = attribute(tag, "title") ?? attribute(tag, "aria-label");
      return label ? ` [${label}] ` : "";
    });
  // Everything before the question body is the number/state/mark box, which callers print themselves.
  const body = /<div\b[^>]*class\s*=\s*["'][^"']*\bcontent\b[^"']*["'][^>]*>/i.exec(text);
  if (body) text = text.slice(body.index);
  return htmlToText(text);
}
