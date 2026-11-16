import { createHash, randomInt } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { saveConfig } from "./config.js";
import { FetchLike, MoodleClient } from "./moodle.js";

interface PublicConfig {
  wwwroot: string;
  httpswwwroot?: string;
  sitename?: string;
  enablewebservices?: number;
  enablemobilewebservice?: number;
  identityproviders?: { name: string; url: string }[];
}

export async function fetchPublicConfig(url: string, fetchImpl: FetchLike = fetch): Promise<PublicConfig> {
  const response = await fetchImpl(`${url}/lib/ajax/service.php?info=tool_mobile_get_public_config`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify([{ index: 0, methodname: "tool_mobile_get_public_config", args: {} }]),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`${url} answered HTTP ${response.status}. Is it a Moodle site?`);
  const body = (await response.json()) as [{ error: boolean; data?: PublicConfig; exception?: { message?: string } }];
  const first = body[0];
  if (!first || first.error || !first.data) {
    throw new Error(`${url} did not return its public configuration: ${first?.exception?.message ?? "unknown error"}`);
  }
  return first.data;
}

export function buildLaunchUrl(url: string, passport: string, oauthProviderId?: number): string {
  const params = new URLSearchParams({ service: "moodle_mobile_app", passport, urlscheme: "moodlemobile" });
  if (oauthProviderId !== undefined) params.set("oauthsso", String(oauthProviderId));
  return `${url}/admin/tool/mobile/launch.php?${params.toString()}`;
}

/** The numeric id of an OAuth2 identity provider, taken from its login URL. */
export function providerId(providerUrl: string): number | undefined {
  try {
    const value = new URL(providerUrl).searchParams.get("id");
    return value && /^\d+$/.test(value) ? Number(value) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Extracts the web service token from what the user pasted: the
 * `moodlemobile://token=<base64>` address the site redirects to after login.
 * The base64 payload is `<md5(wwwroot + passport)>:::<token>[:::<privatetoken>]`.
 */
export function parseLaunchToken(pasted: string, check: { wwwroots: string[]; passport: string }): string {
  let value = pasted.trim().replace(/^['"<]+|['">]+$/g, "");
  const marker = value.indexOf("token=");
  if (marker >= 0) value = value.slice(marker + "token=".length);
  value = value.split(/[&#\s]/)[0] ?? "";
  try {
    value = decodeURIComponent(value);
  } catch {
    // Not URL-encoded; use as is.
  }
  if (!value || !/^[A-Za-z0-9+/_-]+=*$/.test(value)) {
    throw new Error("That does not look like the moodlemobile://token=... address. Copy the whole address and try again.");
  }
  const parts = Buffer.from(value, "base64").toString("utf8").split(":::");
  const [signature, token] = parts;
  if (parts.length < 2 || !signature || !token) {
    throw new Error("The pasted address does not contain a token. Copy the whole moodlemobile://token=... address and try again.");
  }
  const expected = check.wwwroots.map((root) => createHash("md5").update(root + check.passport).digest("hex"));
  if (!expected.includes(signature)) {
    throw new Error("The pasted address belongs to a different login attempt or site. Open the link printed above again and paste the new address.");
  }
  return token;
}

async function verifyAndSave(url: string, token: string): Promise<void> {
  const info = await new MoodleClient({ url, token }).siteInfo();
  const path = await saveConfig({ url, token });
  console.log(`\nLogged in as ${info.fullname} on ${info.sitename}.`);
  console.log(`Token saved to ${path} (readable only by you).`);
}

export async function login(options: { url: string; token?: string }): Promise<void> {
  const { url } = options;
  if (options.token) {
    await verifyAndSave(url, options.token);
    return;
  }

  const config = await fetchPublicConfig(url);
  if (!config.enablewebservices || !config.enablemobilewebservice) {
    throw new Error(`${config.sitename ?? url} has the mobile web service disabled, so this server cannot connect to it.`);
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const providers = (config.identityproviders ?? [])
      .map((provider) => ({ name: provider.name, id: providerId(provider.url) }))
      .filter((provider): provider is { name: string; id: number } => provider.id !== undefined);
    let oauthId: number | undefined;
    if (providers.length === 1) {
      oauthId = providers[0]!.id;
    } else if (providers.length > 1) {
      console.log("How do you log in to this site?");
      providers.forEach((provider, index) => console.log(`  ${index + 1}. ${provider.name}`));
      console.log(`  ${providers.length + 1}. Username and password of the site`);
      const choice = Number((await rl.question("Number: ")).trim());
      oauthId = providers[choice - 1]?.id;
    }

    const passport = String(randomInt(1, 2 ** 31));
    console.log(`
Log in to ${config.sitename ?? url}:

  1. Open a PRIVATE (incognito) browser window. It must not already be logged in to the site.
  2. Open the developer tools (F12), go to the "Network" tab and tick "Preserve log" / "Persist logs".
  3. Paste this address in that window and log in as usual:

     ${buildLaunchUrl(url, passport, oauthId)}

  4. When login finishes the page stays blank or shows an error. That is expected:
     the site tried to open an address starting with moodlemobile://token=
     Find it and copy it whole:
       - Firefox: it is in the address bar or in the error page.
       - Chrome/Edge: in the Network tab, click the last "launch.php" request and
         copy the "Location" response header (or see the "Failed to launch" line in the Console tab).
`);
    const wwwroots = [...new Set([config.wwwroot, config.httpswwwroot, url].filter((root): root is string => Boolean(root)))];
    for (;;) {
      const pasted = await rl.question("Paste the moodlemobile://token=... address here: ");
      if (!pasted.trim()) continue;
      let token: string;
      try {
        token = parseLaunchToken(pasted, { wwwroots, passport });
      } catch (err) {
        console.log(`\n${(err as Error).message}\n`);
        continue;
      }
      await verifyAndSave(url, token);
      return;
    }
  } finally {
    rl.close();
  }
}
