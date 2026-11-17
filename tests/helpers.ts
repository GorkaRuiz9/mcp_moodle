import { ConfirmationError, DECLINED_MESSAGE } from "../src/confirm.js";
import { FetchLike, MoodleClient } from "../src/moodle.js";

export const SITE = "https://moodle.example";

type Handler = (params: URLSearchParams) => unknown;

export interface FakeMoodle {
  client: MoodleClient;
  /** Web service functions called, in order. */
  calls: string[];
  /** Every URL requested, in order. */
  urls: string[];
  /** Files sent to the draft area, in order. */
  uploads: { name: string; path: string; itemid: number; text: string }[];
  /** Parameters of every call to one web service function, in order. */
  paramsOf(name: string): URLSearchParams[];
}

/**
 * A MoodleClient wired to canned answers, keyed by web service function.
 * `files` maps a URL path to the bytes served for it.
 */
export function fakeMoodle(handlers: Record<string, Handler>, files: Record<string, { body: Uint8Array | string; type: string }> = {}): FakeMoodle {
  const calls: string[] = [];
  const urls: string[] = [];
  const uploads: FakeMoodle["uploads"] = [];
  const seen: { name: string; params: URLSearchParams }[] = [];
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
      seen.push({ name, params });
      const handler = all[name];
      const payload = handler ? handler(params) : { exception: "dml_missing_record_exception", errorcode: "invalidrecord", message: `No such function ${name}` };
      return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.pathname === "/webservice/upload.php") {
      const form = init?.body as FormData;
      const blob = form.get("file_1") as File;
      // Like Moodle: item id 0 opens a new draft area, anything else adds to it.
      const itemid = Number(form.get("itemid")) || 5000 + uploads.length;
      uploads.push({ name: blob.name, path: String(form.get("filepath")), itemid, text: await blob.text() });
      return new Response(JSON.stringify([{ itemid, filename: blob.name }]), { status: 200, headers: { "content-type": "application/json" } });
    }
    const file = files[url.pathname];
    if (file) return new Response(file.body, { status: 200, headers: { "content-type": file.type } });
    return new Response("not found", { status: 404 });
  };
  const paramsOf = (name: string) => seen.filter((call) => call.name === name).map((call) => call.params);
  return { client: new MoodleClient({ url: SITE, token: "secret-token", fetchImpl }), calls, urls, uploads, paramsOf };
}

/** A confirmation prompt that records what it was shown and answers as told. */
export function fakeConfirm(answer: "yes" | "no" = "yes") {
  const shown: string[] = [];
  const confirm = async (message: string) => {
    shown.push(message);
    if (answer === "no") throw new ConfirmationError(DECLINED_MESSAGE, "declined");
  };
  return { confirm, shown };
}

export const DAY = 86400;
export const now = () => Math.floor(Date.now() / 1000);
