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
export function htmlToText(html: string | null | undefined): string {
  if (!html) return "";
  let text = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, "")
    // Keep link targets: <a href="u">t</a> -> t (u)
    .replace(/<a\b[^>]*?href\s*=\s*["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, inner: string) => {
      const label = inner.replace(/<[^>]+>/g, "").trim();
      if (!href || href.startsWith("#")) return label;
      return label && label !== href ? `${label} (${href})` : href;
    })
    .replace(/<img\b[^>]*?alt\s*=\s*["']([^"']+)["'][^>]*>/gi, "[image: $1]")
    .replace(/<li\b[^>]*>/gi, "\n- ")
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
