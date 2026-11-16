import { describe, expect, it } from "vitest";
import { formatBytes, htmlToText, normalizeForSearch, relativeTime, summarize, truncate } from "../src/format.js";

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
