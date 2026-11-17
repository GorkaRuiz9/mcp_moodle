import { describe, expect, it } from "vitest";
import { formatBytes, formatDuration, htmlToText, normalizeForSearch, parseDateInput, questionHtmlToText, relativeTime, summarize, truncate } from "../src/format.js";

describe("htmlToText", () => {
  it("strips tags and decodes entities", () => {
    expect(htmlToText("<p>Pr&aacute;ctica &amp; teor&#237;a&nbsp;1</p>")).toBe("Práctica & teoría 1");
    expect(htmlToText("&Aacute;lgebra &NBSP; &unknown;")).toBe("Álgebra &unknown;");
    expect(htmlToText("<p>a &lt; b &#x41;</p>")).toBe("a < b A");
  });

  it("keeps paragraph and list structure", () => {
    expect(htmlToText("<p>Uno</p><p>Dos</p><ul><li>a</li><li>b</li></ul>")).toBe("Uno\nDos\n\n- a\n- b");
  });

  it("keeps link targets", () => {
    expect(htmlToText('Ver <a href="https://x.test/a">la guía</a>.')).toBe("Ver la guía (https://x.test/a).");
    expect(htmlToText('<a href="https://x.test/a">https://x.test/a</a>')).toBe("https://x.test/a");
  });

  it("drops scripts, styles and comments", () => {
    expect(htmlToText("<style>p{}</style><script>alert(1)</script><!-- x -->hola")).toBe("hola");
  });

  it("handles empty input", () => {
    expect(htmlToText(undefined)).toBe("");
    expect(htmlToText(null)).toBe("");
  });
});

describe("text helpers", () => {
  it("summarize collapses to one capped line", () => {
    expect(summarize("<p>uno</p><p>dos</p>")).toBe("uno dos");
    expect(summarize("<p>" + "a".repeat(50) + "</p>", 10)).toBe("a".repeat(10) + "…");
  });

  it("truncate leaves short text alone", () => {
    expect(truncate("abc", 3)).toBe("abc");
  });

  it("normalizeForSearch ignores case and accents", () => {
    expect(normalizeForSearch("Cálculo Ñandú")).toBe("calculo nandu");
  });

  it("relativeTime describes both directions", () => {
    expect(relativeTime(1000 + 3 * 86400, 1000)).toBe("in 3 d");
    expect(relativeTime(1000 - 2 * 3600, 1000)).toBe("2 h ago");
    expect(relativeTime(1000 + 120, 1000)).toBe("in 2 min");
  });

  it("formatBytes picks a unit", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(0)).toBe("0 B");
  });
});

describe("parseDateInput", () => {
  const local = (year: number, month: number, day: number, hour = 0, minute = 0) => Math.floor(new Date(year, month, day, hour, minute).getTime() / 1000);

  it("reads dates with and without a time, as local time", () => {
    expect(parseDateInput("2026-11-20")).toBe(local(2026, 10, 20));
    expect(parseDateInput("2026-11-20 09:30")).toBe(local(2026, 10, 20, 9, 30));
    expect(parseDateInput(" 2026-11-20T09:30:00 ")).toBe(local(2026, 10, 20, 9, 30));
  });

  it("honours an explicit time zone", () => {
    expect(parseDateInput("2026-11-20T09:30:00Z")).toBe(Date.UTC(2026, 10, 20, 9, 30) / 1000);
    expect(parseDateInput("2026-11-20T09:30+02:00")).toBe(Date.UTC(2026, 10, 20, 7, 30) / 1000);
  });

  it("rejects what is not a date", () => {
    for (const text of ["", "mañana", "20/11/2026", "2026-13-01", "2026-02-31", "2026-11-20 25:00", "1794956340"]) {
      expect(parseDateInput(text)).toBeUndefined();
    }
  });
});

describe("formatDuration", () => {
  it("uses the largest sensible unit", () => {
    expect(formatDuration(1800)).toBe("30 min");
    expect(formatDuration(7200)).toBe("2 h");
    expect(formatDuration(5400)).toBe("1 h 30 min");
    expect(formatDuration(2 * 86400)).toBe("2 d");
  });
});

describe("questionHtmlToText", () => {
  it("keeps the answers a student gave", () => {
    const html =
      '<div class="info">Pregunta 1 Puntúa 1,00</div><div class="content"><span class="accesshide">Texto de la pregunta</span><p>Elige:</p>' +
      '<input type="checkbox" checked="checked" /> uno <i class="icon" title="Correcta"></i><br><input type="checkbox" /> dos<br>' +
      '<select><option value="0">Elegir…</option><option selected="selected" value="2">rojo</option></select>' +
      '<input type="hidden" name="q1:1_:sequencecheck" value="2" /><textarea>mi respuesta larga</textarea></div>';
    const text = questionHtmlToText(html);
    expect(text).toBe("Elige:\n[x] uno [Correcta]\n[ ] dos\n[chosen: rojo]\n[typed: mi respuesta larga]");
  });

  it("copes with numbers where Moodle should send text", () => {
    expect(htmlToText(6.5)).toBe("6.5");
    expect(htmlToText(0)).toBe("0");
  });
});
