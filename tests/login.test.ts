import { createHash } from "node:crypto";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { clearConfig, loadConfig, normalizeUrl, saveConfig } from "../src/config.js";
import { buildLaunchUrl, parseLaunchToken, providerId } from "../src/login.js";

const WWWROOT = "https://alud.deusto.es";
const PASSPORT = "123456";
const signature = createHash("md5").update(WWWROOT + PASSPORT).digest("hex");
const encode = (payload: string) => Buffer.from(payload).toString("base64");
const check = { wwwroots: [WWWROOT], passport: PASSPORT };

describe("parseLaunchToken", () => {
  it("reads the token from the full moodlemobile address", () => {
    const address = `moodlemobile://token=${encode(`${signature}:::abc123:::private456`)}`;
    expect(parseLaunchToken(address, check)).toBe("abc123");
    expect(parseLaunchToken(`  "${address}"\n`, check)).toBe("abc123");
  });

  it("accepts the bare and the URL-encoded payload", () => {
    const payload = encode(`${signature}:::abc123`);
    expect(parseLaunchToken(payload, check)).toBe("abc123");
    expect(parseLaunchToken(`moodlemobile://token=${encodeURIComponent(payload)}`, check)).toBe("abc123");
  });

  it("rejects an address from another login attempt", () => {
    const other = createHash("md5").update(WWWROOT + "999").digest("hex");
    expect(() => parseLaunchToken(`moodlemobile://token=${encode(`${other}:::abc123`)}`, check)).toThrow(/different login attempt/);
  });

  it("rejects things that are not the address", () => {
    expect(() => parseLaunchToken("https://alud.deusto.es/my/", check)).toThrow(/does not look like/);
    expect(() => parseLaunchToken(`moodlemobile://token=${encode("justonepart")}`, check)).toThrow(/does not contain a token/);
  });
});

describe("launch URL", () => {
  it("includes the OAuth provider when there is one", () => {
    expect(buildLaunchUrl(WWWROOT, PASSPORT, 1)).toBe(
      "https://alud.deusto.es/admin/tool/mobile/launch.php?service=moodle_mobile_app&passport=123456&urlscheme=moodlemobile&oauthsso=1",
    );
    expect(buildLaunchUrl(WWWROOT, PASSPORT)).not.toContain("oauthsso");
  });

  it("finds the provider id in its login URL", () => {
    expect(providerId("https://alud.deusto.es/auth/oauth2/login.php?id=1&wantsurl=%2F&sesskey=x")).toBe(1);
    expect(providerId("https://alud.deusto.es/auth/saml2/login.php")).toBeUndefined();
  });
});

describe("config", () => {
  it("normalizes site URLs", () => {
    expect(normalizeUrl("alud.deusto.es/")).toBe("https://alud.deusto.es");
    expect(normalizeUrl(" https://uni.example/moodle/ ")).toBe("https://uni.example/moodle");
  });

  it("stores the token privately and lets the environment override it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "moodle-mcp-test-"));
    const env = { MOODLE_MCP_CONFIG_DIR: dir };
    expect(await loadConfig(env)).toEqual({ url: "https://alud.deusto.es", token: undefined });

    const path = await saveConfig({ url: "https://uni.example", token: "stored" }, env);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ url: "https://uni.example", token: "stored" });
    if (process.platform !== "win32") expect((await stat(path)).mode & 0o777).toBe(0o600);

    expect(await loadConfig(env)).toEqual({ url: "https://uni.example", token: "stored" });
    expect(await loadConfig({ ...env, MOODLE_TOKEN: "from-env", MOODLE_URL: "https://other.example/" })).toEqual({ url: "https://other.example", token: "from-env" });

    await clearConfig(env);
    expect((await loadConfig(env)).token).toBeUndefined();
  });
});
