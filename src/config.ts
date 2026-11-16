import { mkdir, readFile, rm, writeFile, chmod } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_URL = "https://alud.deusto.es";
const APP = "moodle-mcp";

export interface Config {
  url: string;
  token?: string;
}

export function configDir(env = process.env): string {
  if (env.MOODLE_MCP_CONFIG_DIR) return env.MOODLE_MCP_CONFIG_DIR;
  if (process.platform === "win32" && env.APPDATA) return join(env.APPDATA, APP);
  return join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), APP);
}

export function cacheDir(env = process.env): string {
  if (env.MOODLE_MCP_CACHE_DIR) return env.MOODLE_MCP_CACHE_DIR;
  if (process.platform === "win32" && env.LOCALAPPDATA) return join(env.LOCALAPPDATA, APP, "cache");
  return join(env.XDG_CACHE_HOME || join(homedir(), ".cache"), APP);
}

export function configPath(env = process.env): string {
  return join(configDir(env), "config.json");
}

export function normalizeUrl(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, "");
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  // Throws on garbage input, which is what we want.
  const parsed = new URL(withScheme);
  return `${parsed.protocol}//${parsed.host}${parsed.pathname.replace(/\/+$/, "")}`;
}

async function readStored(env = process.env): Promise<Partial<Config>> {
  try {
    return JSON.parse(await readFile(configPath(env), "utf8")) as Partial<Config>;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error(`Could not read ${configPath(env)}: ${(err as Error).message}`);
  }
}

/** Environment variables win over the config file. */
export async function loadConfig(env = process.env): Promise<Config> {
  const stored = await readStored(env);
  return {
    url: normalizeUrl(env.MOODLE_URL || stored.url || DEFAULT_URL),
    token: env.MOODLE_TOKEN || stored.token || undefined,
  };
}

export async function saveConfig(config: Config, env = process.env): Promise<string> {
  const dir = configDir(env);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const path = configPath(env);
  await writeFile(path, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
  // writeFile's mode only applies on creation; enforce it on existing files too.
  await chmod(path, 0o600);
  return path;
}

export async function clearConfig(env = process.env): Promise<void> {
  await rm(configPath(env), { force: true });
}
