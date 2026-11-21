// The api_request tool behind an "api" token app: a JSON-RPC MCP endpoint (Streamable HTTP, JSON answers only) that the
// app's MCP server entry points at. The token stays in this process; the bot names a path, never a host.
import { tokenApp, type TokenAppId } from "../../shared/app-tokens.ts";
import type { ApiAccess } from "./vendors.ts";

export const API_TOOL = "api_request";
const MAX_RESULT_CHARS = 100_000;
const CALL_MS = 30_000;
const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

type Rpc = { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };
const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);

export function apiTool(app: TokenAppId, access: Pick<ApiAccess, "origin" | "docs">) {
  const label = tokenApp(app)?.label ?? app;
  return {
    name: API_TOOL,
    description: `Calls the ${label} REST API at ${access.origin} as the person's connected account. Give a path from the API docs (${access.docs}); the host and sign-in are added for you. Returns the HTTP status and body.`,
    inputSchema: {
      type: "object",
      properties: {
        method: { type: "string", enum: [...METHODS] },
        path: { type: "string", description: "Starts with /, like /v1/users/me" },
        query: { type: "object", additionalProperties: { type: "string" } },
        body: { description: "JSON body for POST, PUT and PATCH" },
        form: { type: "boolean", description: "Send body as form fields (application/x-www-form-urlencoded), as Stripe expects" },
      },
      required: ["method", "path"],
    },
  };
}

/** The URL a call goes to, or a reason it may not: the path stays on the app's own origin. */
export function apiUrl(access: ApiAccess, path: unknown, query: unknown): URL | string {
  if (typeof path !== "string" || !path.startsWith("/") || path.startsWith("//") || /[\s\\#]/u.test(path) || path.length > 2_000) {
    return "path must be a path on the API, starting with /";
  }
  const url = new URL(path, access.origin);
  if (url.origin !== access.origin) return "path must stay on the API";
  if (query !== undefined) {
    if (!isRecord(query)) return "query must be an object of strings";
    for (const [name, value] of Object.entries(query)) {
      if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") return "query must be an object of strings";
      url.searchParams.set(name, String(value));
    }
  }
  for (const [name, value] of Object.entries(access.query ?? {})) url.searchParams.set(name, value);
  return url;
}

function formBody(value: unknown, prefix = "", out = new URLSearchParams()): URLSearchParams {
  if (isRecord(value)) for (const [key, inner] of Object.entries(value)) formBody(inner, prefix ? `${prefix}[${key}]` : key, out);
  else if (Array.isArray(value)) value.forEach((inner, index) => formBody(inner, `${prefix}[${index}]`, out));
  else if (value !== undefined && value !== null) out.append(prefix, String(value));
  return out;
}

const result = (text: string, isError = false) => ({ content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) });

/** What api_request does when the app refuses the sign-in: a fresh credential to retry with once, or null when only
 * a reconnect helps (the account is then marked for one). */
export interface ApiCallHooks {
  label: string;
  refused?(): Promise<ApiAccess | null>;
}

function retryAfter(response: Response): string {
  const value = response.headers.get("retry-after");
  const seconds = value && /^\d+$/u.test(value.trim()) ? Number(value) : NaN;
  return Number.isFinite(seconds) && seconds > 0 && seconds < 86_400 ? `${seconds} seconds` : "a minute";
}

export async function callApi(access: ApiAccess, args: Record<string, unknown>, fetchImpl: typeof fetch = fetch, scrub: (text: string) => string = (text) => text, hooks?: ApiCallHooks) {
  const method = typeof args.method === "string" ? args.method.toUpperCase() : "";
  if (!(METHODS as readonly string[]).includes(method)) return result(`method must be one of ${METHODS.join(", ")}`, true);
  const url = apiUrl(access, args.path, args.query);
  if (typeof url === "string") return result(url, true);
  let body: string | undefined;
  let type: string | undefined;
  if (args.body !== undefined && method !== "GET") {
    if (args.form === true) { body = formBody(args.body).toString(); type = "application/x-www-form-urlencoded"; }
    else { body = JSON.stringify(args.body); type = "application/json"; }
  }
  const send = async (using: ApiAccess, target: URL) => fetchImpl(target, {
    method, headers: { accept: "application/json", "user-agent": "madani-bot", ...using.headers, ...(type ? { "content-type": type } : {}) },
    body, redirect: "error", signal: AbortSignal.timeout(CALL_MS),
  });
  let response: Response;
  try {
    response = await send(access, url);
    if (response.status === 401 && hooks?.refused) {
      const next = await hooks.refused().catch(() => null);
      const again = next ? apiUrl(next, args.path, args.query) : null;
      if (next && again instanceof URL) { void response.body?.cancel().catch(() => {}); response = await send(next, again); }
    }
  } catch {
    return result(`Couldn't reach ${url.origin}.`, true);
  }
  const text = scrub(await response.text().catch(() => ""));
  const trimmed = text.length > MAX_RESULT_CHARS ? `${text.slice(0, MAX_RESULT_CHARS)}\n…(cut at ${MAX_RESULT_CHARS} characters; ask for less, with fields or a page size)` : text;
  const label = hooks?.label ?? "The app";
  const note = response.status === 401
    ? `\n\n${label} refused the sign-in: it expired or was revoked. Ask the person to reconnect ${label} in Connect apps.`
    : response.status === 429 ? `\n\n${label} is limiting how fast it can be called. Wait ${retryAfter(response)} before the next call.` : "";
  return result(`HTTP ${response.status}\n${trimmed}${note}`, !response.ok);
}

/** One JSON-RPC message for an api app's endpoint. Undefined for a notification, which gets no answer. */
export async function handleApiRpc(message: unknown, app: TokenAppId, access: () => Promise<ApiAccess>, fetchImpl: typeof fetch = fetch, scrub?: (text: string) => string, refused?: () => Promise<ApiAccess | null>) {
  const rpc = (isRecord(message) ? message : {}) as Rpc;
  const id = rpc.id;
  if (id === undefined) return undefined;
  const reply = (body: Record<string, unknown>) => ({ jsonrpc: "2.0", id, ...body });
  switch (rpc.method) {
    case "initialize":
      return reply({ result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: `madani-bot-${app}`, version: "1" } } });
    case "ping":
      return reply({ result: {} });
    case "tools/list":
      return reply({ result: { tools: [apiTool(app, await access())] } });
    case "tools/call": {
      const params = isRecord(rpc.params) ? rpc.params : {};
      if (params.name !== API_TOOL) return reply({ error: { code: -32602, message: `Unknown tool. The only tool is ${API_TOOL}.` } });
      return reply({ result: await callApi(await access(), isRecord(params.arguments) ? params.arguments : {}, fetchImpl, scrub, { label: tokenApp(app)?.label ?? app, refused }) });
    }
    default:
      return reply({ error: { code: -32601, message: "Method not found" } });
  }
}
