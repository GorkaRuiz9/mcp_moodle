import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { MoodleClient } from "./moodle.js";
import { formatBytes, htmlToText } from "./format.js";

export const MAX_FILE_BYTES = 100 * 1024 * 1024;
/** Characters of extracted text returned per call. */
export const TEXT_BUDGET = 20_000;
const DISK_CACHE_MS = 60 * 60 * 1000;

const TEXT_EXTENSIONS = new Set([
  ".txt", ".md", ".csv", ".tsv", ".json", ".xml", ".yaml", ".yml", ".html", ".htm", ".tex", ".bib", ".log",
  ".py", ".java", ".c", ".h", ".cpp", ".hpp", ".cs", ".js", ".ts", ".sql", ".sh", ".r", ".m", ".kt", ".go", ".rs", ".php", ".css",
]);

export function safeFilename(name: string): string {
  const cleaned = name
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
    .replace(/^\.+/, "_")
    .trim();
  return (cleaned || "file").slice(0, 150);
}

function filenameFromUrl(url: URL): string {
  const last = url.pathname.split("/").filter(Boolean).pop() ?? "file";
  try {
    return safeFilename(decodeURIComponent(last));
  } catch {
    return safeFilename(last);
  }
}

/**
 * Picks whole pages starting at `startPage` (1-based) until the character
 * budget is used. Always returns at least one page, cut short if needed.
 */
export function selectPages(pages: string[], startPage: number, budget = TEXT_BUDGET): { text: string; nextPage: number | null; cut: boolean } {
  const chunks: string[] = [];
  let used = 0;
  let index = startPage - 1;
  let cut = false;
  while (index < pages.length) {
    const body = (pages[index] ?? "").trim();
    if (chunks.length && used + body.length > budget) break;
    if (body.length > budget) {
      chunks.push(`--- page ${index + 1} ---\n${body.slice(0, budget)}`);
      cut = true;
    } else {
      chunks.push(`--- page ${index + 1} ---\n${body}`);
    }
    used += body.length;
    index++;
    if (used >= budget) break;
  }
  return { text: chunks.join("\n\n"), nextPage: index < pages.length ? index + 1 : null, cut };
}

async function extractPdfPages(data: Uint8Array): Promise<string[]> {
  const { extractText, getDocumentProxy } = await import("unpdf");
  // pdf.js takes ownership of the buffer it is given, so hand it a copy.
  const pdf = await getDocumentProxy(new Uint8Array(data));
  const { text } = await extractText(pdf, { mergePages: false });
  return text;
}

const isPdf = (data: Uint8Array) => data[0] === 0x25 && data[1] === 0x50 && data[2] === 0x44 && data[3] === 0x46;

export async function getFile(
  client: MoodleClient,
  args: { url: string; start_page?: number },
  options: { cacheDir: string; extractPdf?: (data: Uint8Array) => Promise<string[]> },
): Promise<string> {
  const target = client.resolveFileUrl(args.url);
  const filename = filenameFromUrl(target);
  const dir = join(options.cacheDir, "files", createHash("sha1").update(target.pathname).digest("hex").slice(0, 12));
  const path = join(dir, filename);

  let data: Uint8Array | undefined;
  try {
    const info = await stat(path);
    if (Date.now() - info.mtimeMs < DISK_CACHE_MS) data = new Uint8Array(await readFile(path));
  } catch {
    // Not downloaded yet.
  }
  if (!data) {
    data = (await client.download(args.url, MAX_FILE_BYTES)).data;
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await writeFile(path, data, { mode: 0o600 });
  }

  const header = `Saved to: ${path}\nSize: ${formatBytes(data.byteLength)}`;
  const extension = extname(filename).toLowerCase();

  if (isPdf(data)) {
    let pages: string[];
    try {
      pages = await (options.extractPdf ?? extractPdfPages)(data);
    } catch (err) {
      return `${header}\nType: PDF\n\nCould not extract text (${(err as Error).message}). Open the saved file instead.`;
    }
    const total = pages.length;
    if (!pages.some((page) => page.trim())) {
      return `${header}\nType: PDF, ${total} pages\n\nThe PDF has no text layer (probably scanned images). Open the saved file instead.`;
    }
    const start = args.start_page ?? 1;
    if (start > total) return `${header}\nType: PDF, ${total} pages\n\nstart_page ${start} is past the end of the document.`;
    const { text, nextPage, cut } = selectPages(pages, start);
    const lastShown = nextPage ? nextPage - 1 : total;
    const notes = [
      cut ? `Page ${start} was cut at ${TEXT_BUDGET} characters; read the saved file for the rest.` : "",
      nextPage ? `More text follows: call get_file again with start_page ${nextPage}.` : "End of document.",
    ].filter(Boolean);
    return `${header}\nType: PDF, ${total} pages (showing ${start}–${lastShown})\n\n${text}\n\n${notes.join(" ")}`;
  }

  if (TEXT_EXTENSIONS.has(extension)) {
    const raw = new TextDecoder("utf-8").decode(data);
    const text = extension === ".html" || extension === ".htm" ? htmlToText(raw) : raw;
    const cut = text.length > TEXT_BUDGET;
    return `${header}\nType: text (${extension})\n\n${text.slice(0, TEXT_BUDGET)}${cut ? `\n\n(Cut at ${TEXT_BUDGET} characters; read the saved file for the rest.)` : ""}`;
  }

  return `${header}\nType: ${extension || "unknown"}\n\nNo text extraction for this file type. Open the saved file with a tool that can read it.`;
}
