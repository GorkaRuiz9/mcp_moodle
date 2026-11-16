import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getFile, safeFilename, selectPages } from "../src/files.js";
import { fakeMoodle, SITE } from "./helpers.js";

const PDF_BYTES = new TextEncoder().encode("%PDF-1.7 fake");

describe("selectPages", () => {
  it("returns whole pages up to the budget and says where to continue", () => {
    const pages = ["a".repeat(40), "b".repeat(40), "c".repeat(40)];
    const first = selectPages(pages, 1, 100);
    expect(first.text).toContain("--- page 1 ---");
    expect(first.text).toContain("--- page 2 ---");
    expect(first.text).not.toContain("--- page 3 ---");
    expect(first.nextPage).toBe(3);
    expect(selectPages(pages, 3, 100)).toMatchObject({ nextPage: null, cut: false });
  });

  it("cuts a single oversized page instead of returning nothing", () => {
    const result = selectPages(["x".repeat(500), "y"], 1, 100);
    expect(result.cut).toBe(true);
    expect(result.text).toBe(`--- page 1 ---\n${"x".repeat(100)}`);
    expect(result.nextPage).toBe(2);
  });
});

describe("safeFilename", () => {
  it("cannot escape the cache folder", () => {
    expect(safeFilename("../../etc/passwd")).toBe("__.._etc_passwd");
    expect(safeFilename("..")).toBe("_");
    expect(safeFilename("Tema 1: límites.pdf")).toBe("Tema 1_ límites.pdf");
  });
});

describe("get_file", () => {
  const files = {
    "/webservice/pluginfile.php/9/mod_resource/content/1/Tema%201.pdf": { body: PDF_BYTES, type: "application/pdf" },
    "/webservice/pluginfile.php/9/mod_resource/content/1/notas.txt": { body: "línea 1\nlínea 2", type: "text/plain" },
    "/webservice/pluginfile.php/9/mod_resource/content/1/clase.pptx": { body: new Uint8Array([80, 75, 3, 4]), type: "application/vnd.ms-powerpoint" },
  };
  const base = `${SITE}/webservice/pluginfile.php/9/mod_resource/content/1`;

  it("saves a PDF and returns its text page by page", async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), "moodle-mcp-test-"));
    const { client, urls } = fakeMoodle({}, files);
    const extractPdf = async () => ["a".repeat(15_000), "b".repeat(15_000), "fin"];

    const first = await getFile(client, { url: `${base}/Tema%201.pdf?forcedownload=1` }, { cacheDir, extractPdf });
    const path = first.match(/^Saved to: (.*)$/m)?.[1];
    expect(path?.startsWith(join(cacheDir, "files"))).toBe(true);
    expect(path?.endsWith("Tema 1.pdf")).toBe(true);
    expect(new Uint8Array(await readFile(path!))).toEqual(PDF_BYTES);
    expect(first).toContain("Type: PDF, 3 pages (showing 1–1)");
    expect(first).toContain("call get_file again with start_page 2");

    const rest = await getFile(client, { url: `${base}/Tema%201.pdf`, start_page: 2 }, { cacheDir, extractPdf });
    expect(rest).toContain("(showing 2–3)");
    expect(rest).toContain("End of document.");
    // The second call reads the copy on disk.
    expect(urls).toHaveLength(1);

    expect(await getFile(client, { url: `${base}/Tema%201.pdf`, start_page: 9 }, { cacheDir, extractPdf })).toContain("past the end");
  });

  it("flags scanned PDFs that have no text", async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), "moodle-mcp-test-"));
    const { client } = fakeMoodle({}, files);
    expect(await getFile(client, { url: `${base}/Tema%201.pdf` }, { cacheDir, extractPdf: async () => ["", " "] })).toContain("no text layer");
  });

  it("returns plain text inline and only saves other formats", async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), "moodle-mcp-test-"));
    const { client } = fakeMoodle({}, files);
    expect(await getFile(client, { url: `${base}/notas.txt` }, { cacheDir })).toContain("Type: text (.txt)\n\nlínea 1\nlínea 2");
    const slides = await getFile(client, { url: `${base}/clase.pptx` }, { cacheDir });
    expect(slides).toContain("Type: .pptx");
    expect(slides).toContain("No text extraction");
  });

  it("refuses URLs outside the Moodle site before touching the network", async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), "moodle-mcp-test-"));
    const { client, urls } = fakeMoodle({}, files);
    await expect(getFile(client, { url: "https://evil.example/pluginfile.php/1/a.pdf" }, { cacheDir })).rejects.toThrow(/Refusing/);
    expect(urls).toHaveLength(0);
  });
});
