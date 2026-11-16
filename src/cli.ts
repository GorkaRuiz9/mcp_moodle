#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { cacheDir, clearConfig, configPath, loadConfig, normalizeUrl } from "./config.js";
import { login } from "./login.js";
import { MoodleClient } from "./moodle.js";
import { createServer, VERSION } from "./server.js";

const HELP = `moodle-mcp ${VERSION} — read-only MCP server for Moodle

Usage:
  moodle-mcp                 Start the MCP server on stdio (what MCP clients run)
  moodle-mcp login           Log in through the browser and store the token
      --url <site>           Moodle site (default: MOODLE_URL or https://alud.deusto.es)
      --token <token>        Store a token you already have instead of logging in
  moodle-mcp status          Show which site and user the stored token belongs to
  moodle-mcp logout          Delete the stored token

Environment:
  MOODLE_URL                 Moodle site URL (overrides the stored one)
  MOODLE_TOKEN               Web service token (overrides the stored one)
`;

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} needs a value.`);
  return value;
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  switch (command) {
    case undefined:
    case "serve": {
      const config = await loadConfig();
      const client = new MoodleClient({ url: config.url, token: config.token });
      const server = createServer(client, { cacheDir: cacheDir() });
      await server.connect(new StdioServerTransport());
      // stdout belongs to the protocol; anything for humans goes to stderr.
      console.error(`moodle-mcp ${VERSION} serving ${config.url}${config.token ? "" : " (not logged in: run `moodle-mcp login`)"}`);
      return;
    }
    case "login": {
      const stored = await loadConfig();
      const url = normalizeUrl(option(rest, "--url") ?? stored.url);
      await login({ url, token: option(rest, "--token") });
      return;
    }
    case "status": {
      const config = await loadConfig();
      console.log(`Site: ${config.url}`);
      if (!config.token) {
        console.log("Not logged in. Run `moodle-mcp login`.");
        process.exitCode = 1;
        return;
      }
      const info = await new MoodleClient({ url: config.url, token: config.token }).siteInfo();
      console.log(`Logged in as ${info.fullname} (${info.username}) on ${info.sitename}${info.release ? `, Moodle ${info.release}` : ""}.`);
      return;
    }
    case "logout": {
      await clearConfig();
      console.log(`Removed ${configPath()}.`);
      return;
    }
    case "--version":
    case "-v":
      console.log(VERSION);
      return;
    case "help":
    case "--help":
    case "-h":
      console.log(HELP);
      return;
    default:
      console.error(`Unknown command: ${command}\n\n${HELP}`);
      process.exitCode = 2;
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
