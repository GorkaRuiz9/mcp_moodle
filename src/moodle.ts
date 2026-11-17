export class MoodleError extends Error {
  constructor(
    message: string,
    readonly errorcode?: string,
  ) {
    super(message);
    this.name = "MoodleError";
  }
}

export class NotLoggedInError extends MoodleError {
  constructor(detail?: string) {
    super(
      `${detail ? detail + " " : ""}No valid Moodle token. Ask the user to run \`moodle-mcp login\` in a terminal (or set MOODLE_TOKEN) and then restart the MCP server.`,
      "notloggedin",
    );
    this.name = "NotLoggedInError";
  }
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface MoodleClientOptions {
  url: string;
  token?: string;
  fetchImpl?: FetchLike;
  /** Milliseconds; defaults to 30 s. */
  timeoutMs?: number;
}

type ParamValue = string | number | boolean | null | undefined | ParamValue[] | { [key: string]: ParamValue };

/** Flattens nested params the way Moodle's REST server expects: a[0][b]=c. */
export function flattenParams(params: Record<string, ParamValue>, prefix = ""): [string, string][] {
  const out: [string, string][] = [];
  for (const [key, value] of Object.entries(params)) {
    const name = prefix ? `${prefix}[${key}]` : key;
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      value.forEach((item, index) => {
        if (item !== null && typeof item === "object") {
          out.push(...flattenParams(item as Record<string, ParamValue>, `${name}[${index}]`));
        } else if (item !== undefined && item !== null) {
          out.push([`${name}[${index}]`, scalar(item)]);
        }
      });
    } else if (typeof value === "object") {
      out.push(...flattenParams(value, name));
    } else {
      out.push([name, scalar(value)]);
    }
  }
  return out;
}

function scalar(value: string | number | boolean): string {
  return typeof value === "boolean" ? (value ? "1" : "0") : String(value);
}

const TOKEN_ERRORS = new Set(["invalidtoken", "invalidlogin", "servicerequireslogin"]);

interface CacheEntry {
  expires: number;
  value: Promise<unknown>;
}

export interface SiteInfo {
  userid: number;
  fullname: string;
  username: string;
  sitename: string;
  siteurl: string;
  release?: string;
  functions?: { name: string }[];
}

export interface Download {
  data: Uint8Array;
  mimetype: string;
}

export class MoodleClient {
  readonly url: string;
  private readonly token?: string;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly cache = new Map<string, CacheEntry>();
  private siteInfoPromise?: Promise<SiteInfo>;

  constructor(options: MoodleClientOptions) {
    this.url = options.url.replace(/\/+$/, "");
    this.token = options.token;
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  /**
   * Calls a web service function. `cacheTtlMs` > 0 memoizes the result in
   * memory, for data that does not hurt when it is a few minutes old.
   */
  async call<T>(wsfunction: string, params: Record<string, ParamValue> = {}, cacheTtlMs = 0): Promise<T> {
    if (!this.token) throw new NotLoggedInError();
    const flat = flattenParams(params);
    if (cacheTtlMs <= 0) return this.request<T>(wsfunction, flat);

    const key = `${wsfunction}?${new URLSearchParams(flat).toString()}`;
    const hit = this.cache.get(key);
    if (hit && hit.expires > Date.now()) return hit.value as Promise<T>;
    const value = this.request<T>(wsfunction, flat);
    this.cache.set(key, { expires: Date.now() + cacheTtlMs, value });
    // Never cache failures.
    value.catch(() => this.cache.delete(key));
    return value;
  }

  private async request<T>(wsfunction: string, flat: [string, string][]): Promise<T> {
    const body = new URLSearchParams([
      ["wstoken", this.token!],
      ["wsfunction", wsfunction],
      ["moodlewsrestformat", "json"],
      ...flat,
    ]);
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.url}/webservice/rest/server.php`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString(),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new MoodleError(`Could not reach ${this.url}: ${(err as Error).message}`, "network");
    }
    if (!response.ok) {
      throw new MoodleError(`${this.url} answered HTTP ${response.status} to ${wsfunction}.`, "http");
    }
    const text = await response.text();
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      throw new MoodleError(`${this.url} returned a non-JSON answer to ${wsfunction} (is the site in maintenance?).`, "badjson");
    }
    if (data && typeof data === "object" && "exception" in data) {
      const error = data as { errorcode?: string; message?: string };
      if (error.errorcode && TOKEN_ERRORS.has(error.errorcode)) {
        throw new NotLoggedInError(`Moodle rejected the token (${error.errorcode}).`);
      }
      throw new MoodleError(`Moodle error in ${wsfunction}: ${error.message ?? "unknown"} (${error.errorcode ?? "no code"})`, error.errorcode);
    }
    return data as T;
  }

  /** Forgets every memoized answer. Call it after changing something in Moodle. */
  clearCache(): void {
    this.cache.clear();
  }

  /**
   * Uploads one file to the user's draft area and returns the draft item id
   * that holds it. Pass the id of an earlier upload to add to the same draft;
   * 0 starts a new one. Nothing is visible to anyone until a web service
   * function saves the draft somewhere.
   */
  async upload(file: { name: string; data: Uint8Array; path?: string }, itemId = 0): Promise<number> {
    if (!this.token) throw new NotLoggedInError();
    const form = new FormData();
    form.set("token", this.token);
    form.set("filearea", "draft");
    form.set("itemid", String(itemId));
    form.set("filepath", file.path ?? "/");
    form.set("file_1", new Blob([file.data as Uint8Array<ArrayBuffer>]), file.name);
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.url}/webservice/upload.php`, {
        method: "POST",
        body: form,
        redirect: "error",
        signal: AbortSignal.timeout(Math.max(this.timeoutMs, 300_000)),
      });
    } catch (err) {
      throw new MoodleError(`Could not upload ${file.name}: ${(err as Error).message}`, "network");
    }
    if (!response.ok) throw new MoodleError(`Upload of ${file.name} failed with HTTP ${response.status}.`, "http");
    let data: unknown;
    try {
      data = JSON.parse(await response.text());
    } catch {
      throw new MoodleError(`${this.url} returned a non-JSON answer to the upload of ${file.name}.`, "badjson");
    }
    if (Array.isArray(data)) {
      const first = data[0] as { itemid?: number; error?: string; errorcode?: string } | undefined;
      if (first && typeof first.itemid === "number") return first.itemid;
      // Per-file problems (too big, quota) come back inside the array.
      throw new MoodleError(`Moodle refused ${file.name}: ${first?.error ?? first?.errorcode ?? "unknown reason"}`, first?.errorcode);
    }
    const error = (data ?? {}) as { error?: string; errorcode?: string };
    if (error.errorcode && TOKEN_ERRORS.has(error.errorcode)) throw new NotLoggedInError(`Moodle rejected the token (${error.errorcode}).`);
    throw new MoodleError(`Moodle refused ${file.name}: ${error.error ?? error.errorcode ?? "unknown reason"}`, error.errorcode);
  }

  /** Who the token belongs to. Fetched once per process. */
  siteInfo(): Promise<SiteInfo> {
    if (!this.siteInfoPromise) {
      this.siteInfoPromise = this.call<SiteInfo>("core_webservice_get_site_info");
      this.siteInfoPromise.catch(() => {
        this.siteInfoPromise = undefined;
      });
    }
    return this.siteInfoPromise;
  }

  /**
   * Turns a file URL from the API into one this client may download, or
   * throws. The token is only ever sent to the configured site.
   */
  resolveFileUrl(rawUrl: string): URL {
    let target: URL;
    try {
      target = new URL(rawUrl, this.url + "/");
    } catch {
      throw new MoodleError(`Not a valid URL: ${rawUrl}`, "badurl");
    }
    const site = new URL(this.url);
    if (target.protocol !== site.protocol || target.host !== site.host) {
      throw new MoodleError(
        `Refusing to download ${target.origin}: only files hosted on ${site.origin} can be fetched (the Moodle token is never sent elsewhere).`,
        "foreignhost",
      );
    }
    const base = site.pathname.replace(/\/+$/, "");
    const rest = target.pathname.slice(base.length);
    if (!target.pathname.startsWith(base + "/")) {
      throw new MoodleError(`Not a file URL of ${this.url}: ${rawUrl}`, "badurl");
    }
    if (rest.startsWith("/pluginfile.php/")) {
      target.pathname = `${base}/webservice${rest}`;
    } else if (!rest.startsWith("/webservice/pluginfile.php/")) {
      throw new MoodleError(
        `Not a Moodle file URL: ${rawUrl}. Pass a "fileurl" value from get_course_contents (it contains /pluginfile.php/).`,
        "badurl",
      );
    }
    target.searchParams.delete("token");
    return target;
  }

  async download(rawUrl: string, maxBytes: number): Promise<Download> {
    if (!this.token) throw new NotLoggedInError();
    const target = this.resolveFileUrl(rawUrl);
    target.searchParams.set("token", this.token);
    let response: Response;
    try {
      response = await this.fetchImpl(target.toString(), {
        // A redirect could carry the token in the URL to another host.
        redirect: "error",
        signal: AbortSignal.timeout(Math.max(this.timeoutMs, 120_000)),
      });
    } catch (err) {
      throw new MoodleError(`Could not download the file: ${(err as Error).message}`, "network");
    }
    if (!response.ok) {
      throw new MoodleError(`Download failed with HTTP ${response.status}.`, "http");
    }
    const declared = Number(response.headers.get("content-length") ?? 0);
    if (declared > maxBytes) {
      throw new MoodleError(`File is too large (${declared} bytes; limit ${maxBytes}).`, "toolarge");
    }
    const data = new Uint8Array(await response.arrayBuffer());
    if (data.byteLength > maxBytes) {
      throw new MoodleError(`File is too large (${data.byteLength} bytes; limit ${maxBytes}).`, "toolarge");
    }
    const mimetype = (response.headers.get("content-type") ?? "application/octet-stream").split(";")[0]!.trim();
    // Moodle reports file errors as a small JSON body, sometimes with HTTP 200.
    if (mimetype === "application/json" && data.byteLength < 4096) {
      try {
        const parsed = JSON.parse(new TextDecoder().decode(data)) as { error?: string; errorcode?: string };
        if (parsed && typeof parsed === "object" && (parsed.error || parsed.errorcode)) {
          if (parsed.errorcode && TOKEN_ERRORS.has(parsed.errorcode)) {
            throw new NotLoggedInError(`Moodle rejected the token (${parsed.errorcode}).`);
          }
          throw new MoodleError(`Moodle refused the download: ${parsed.error ?? parsed.errorcode}`, parsed.errorcode);
        }
      } catch (err) {
        if (err instanceof MoodleError) throw err;
        // A real JSON file that just happens to be small: fall through.
      }
    }
    return { data, mimetype };
  }
}
