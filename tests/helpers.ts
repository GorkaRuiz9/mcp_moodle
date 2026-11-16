import { FetchLike, MoodleClient } from "../src/moodle.js";

export const SITE = "https://moodle.example";

type Handler = (params: URLSearchParams) => unknown;

export interface FakeMoodle {
  client: MoodleClient;
  /** Web service functions called, in order. */
  calls: string[];
  /** Every URL requested, in order. */
  urls: string[];
}

/**
 * A MoodleClient wired to canned answers, keyed by web service function.
 * `files` maps a URL path to the bytes served for it.
 */
export function fakeMoodle(handlers: Record<string, Handler>, files: Record<string, { body: Uint8Array | string; type: string }> = {}): FakeMoodle {
  const calls: string[] = [];
  const urls: string[] = [];
  const all: Record<string, Handler> = {
    core_webservice_get_site_info: () => ({ userid: 7, fullname: "Test Student", username: "student", sitename: "Example", siteurl: SITE }),
    ...handlers,
  };
  const fetchImpl: FetchLike = async (input, init) => {
    urls.push(input);
    const url = new URL(input);
    if (url.pathname === "/webservice/rest/server.php") {
      const params = new URLSearchParams(String(init?.body ?? ""));
      const name = params.get("wsfunction") ?? "";
      calls.push(name);
      const handler = all[name];
      const payload = handler ? handler(params) : { exception: "dml_missing_record_exception", errorcode: "invalidrecord", message: `No such function ${name}` };
      return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
    }
    const file = files[url.pathname];
    if (file) return new Response(file.body, { status: 200, headers: { "content-type": file.type } });
    return new Response("not found", { status: 404 });
  };
  return { client: new MoodleClient({ url: SITE, token: "secret-token", fetchImpl }), calls, urls };
}

export const DAY = 86400;
export const now = () => Math.floor(Date.now() / 1000);
