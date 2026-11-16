import { describe, expect, it } from "vitest";
import { flattenParams, MoodleClient, MoodleError, NotLoggedInError } from "../src/moodle.js";
import { fakeMoodle, SITE } from "./helpers.js";

describe("flattenParams", () => {
  it("encodes arrays and nested objects the Moodle way", () => {
    expect(flattenParams({ courseids: [3, 5], userid: 7, flag: true, skip: undefined })).toEqual([
      ["courseids[0]", "3"],
      ["courseids[1]", "5"],
      ["userid", "7"],
      ["flag", "1"],
    ]);
    expect(flattenParams({ options: [{ name: "a", value: 1 }] })).toEqual([
      ["options[0][name]", "a"],
      ["options[0][value]", "1"],
    ]);
  });
});

describe("MoodleClient.call", () => {
  it("refuses to call without a token", async () => {
    const client = new MoodleClient({ url: SITE, fetchImpl: async () => new Response("{}") });
    await expect(client.call("x")).rejects.toBeInstanceOf(NotLoggedInError);
  });

  it("turns an invalid token into NotLoggedInError", async () => {
    const { client } = fakeMoodle({ some_fn: () => ({ exception: "moodle_exception", errorcode: "invalidtoken", message: "Invalid token" }) });
    await expect(client.call("some_fn")).rejects.toBeInstanceOf(NotLoggedInError);
  });

  it("surfaces other Moodle exceptions with their code", async () => {
    const { client } = fakeMoodle({ some_fn: () => ({ exception: "x", errorcode: "nopermissions", message: "No puedes" }) });
    await expect(client.call("some_fn")).rejects.toMatchObject({ name: "MoodleError", errorcode: "nopermissions" });
  });

  it("caches only when asked, and never caches failures", async () => {
    let fail = true;
    const { client, calls } = fakeMoodle({
      cached_fn: () => (fail ? { exception: "x", errorcode: "boom", message: "boom" } : { ok: true }),
    });
    await expect(client.call("cached_fn", {}, 60_000)).rejects.toBeInstanceOf(MoodleError);
    fail = false;
    await client.call("cached_fn", {}, 60_000);
    await client.call("cached_fn", {}, 60_000);
    expect(calls.filter((c) => c === "cached_fn")).toHaveLength(2);
    await client.call("cached_fn", {});
    expect(calls.filter((c) => c === "cached_fn")).toHaveLength(3);
  });

  it("reports a maintenance page as a readable error", async () => {
    const client = new MoodleClient({ url: SITE, token: "t", fetchImpl: async () => new Response("<html>maintenance</html>") });
    await expect(client.call("x")).rejects.toMatchObject({ errorcode: "badjson" });
  });
});

describe("file URLs", () => {
  const { client } = fakeMoodle({});

  it("accepts web service file URLs and rewrites plain pluginfile URLs", () => {
    expect(client.resolveFileUrl(`${SITE}/webservice/pluginfile.php/1/mod_resource/content/1/a.pdf?forcedownload=1`).pathname).toBe(
      "/webservice/pluginfile.php/1/mod_resource/content/1/a.pdf",
    );
    expect(client.resolveFileUrl(`${SITE}/pluginfile.php/1/mod_resource/content/1/a.pdf`).pathname).toBe(
      "/webservice/pluginfile.php/1/mod_resource/content/1/a.pdf",
    );
  });

  it("never points the token at another host or a non-file page", () => {
    expect(() => client.resolveFileUrl("https://evil.example/webservice/pluginfile.php/1/a.pdf")).toThrow(/Refusing/);
    expect(() => client.resolveFileUrl(`http://moodle.example/webservice/pluginfile.php/1/a.pdf`)).toThrow(/Refusing/);
    expect(() => client.resolveFileUrl(`${SITE}/login/index.php`)).toThrow(/Not a Moodle file URL/);
    expect(() => client.resolveFileUrl(`${SITE}/pluginfile.php/../login/index.php`)).toThrow(/Not a Moodle file URL/);
  });

  it("drops a token smuggled in the URL", () => {
    expect(client.resolveFileUrl(`${SITE}/webservice/pluginfile.php/1/a.pdf?token=other`).searchParams.has("token")).toBe(false);
  });

  it("downloads with the token and reports Moodle's JSON errors", async () => {
    const fake = fakeMoodle(
      {},
      {
        "/webservice/pluginfile.php/1/a.txt": { body: "hola", type: "text/plain; charset=utf-8" },
        "/webservice/pluginfile.php/1/denied.pdf": { body: JSON.stringify({ error: "Access denied", errorcode: "nopermissions" }), type: "application/json" },
      },
    );
    const file = await fake.client.download(`${SITE}/pluginfile.php/1/a.txt`, 1000);
    expect(new TextDecoder().decode(file.data)).toBe("hola");
    expect(file.mimetype).toBe("text/plain");
    expect(fake.urls.at(-1)).toContain("token=secret-token");
    await expect(fake.client.download(`${SITE}/pluginfile.php/1/denied.pdf`, 1000)).rejects.toThrow(/Access denied/);
    await expect(fake.client.download(`${SITE}/pluginfile.php/1/a.txt`, 2)).rejects.toThrow(/too large/);
  });
});
