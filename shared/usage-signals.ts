// what a workspace tells the account service about how it is used: one record per bot turn and per routine run, plus a
// count snapshot. every value is a word from a fixed list, a count or a time. message text, prompts, file contents,
// urls, tool arguments, error messages and names never reach these records: the workspace maps them to words here first.
import { CURATED_CONNECTOR_SLUGS } from "./connector-curated.ts";
import { traceToolLook } from "./usage-trace.ts";

export const USAGE_ENGINES = ["claude", "codex", "gemini", "grok", "opencode", "cursor", "kimi", "deepseek", "qwen", "copilot", "api", "other"] as const;
export type UsageEngine = (typeof USAGE_ENGINES)[number];
const ENGINE_BY_DRIVER: Readonly<Record<string, UsageEngine>> = {
  claudeAgent: "claude", codex: "codex", geminiAgent: "gemini", grokAgent: "grok", grok: "grok", opencodeGo: "opencode", cursorAgent: "cursor", kimiAgent: "kimi",
  deepseekAgent: "deepseek", qwenAgent: "qwen", copilotAgent: "copilot", "openai-compat": "api", mistral: "api", cerebras: "api", groq: "api", greenference: "api",
  meta: "api", minimax: "api",
};
/** an engine's family from its driver kind; never the instance id or a model name someone typed */
export const engineFamily = (driverKind: unknown): UsageEngine => (typeof driverKind === "string" && ENGINE_BY_DRIVER[driverKind]) || "other";

/** what a turn touched, by kind: the trace's tool icons, folded */
export const USAGE_TOOLS = ["browser", "computer", "terminal", "files", "web", "memory", "routine", "page", "widget", "bots", "phone", "image", "data", "app", "mcp", "other"] as const;
export type UsageTool = (typeof USAGE_TOOLS)[number];
const TOOL_OF_ICON: Readonly<Record<string, UsageTool>> = {
  browser: "browser", computer: "computer", terminal: "terminal", files: "files", search: "web", web: "web", memory: "memory", routine: "routine", page: "page",
  widget: "widget", bots: "bots", phone: "phone", image: "image", data: "data", app: "app", mcp: "mcp", plan: "other", tool: "other",
};
export const USAGE_APPS: readonly string[] = CURATED_CONNECTOR_SLUGS;
const APP_SET = new Set<string>(USAGE_APPS);

export const USAGE_CATEGORIES = ["email", "calendar", "messaging", "social", "docs", "coding", "data", "research", "computer", "files", "image", "chat", "other"] as const;
export type UsageCategory = (typeof USAGE_CATEGORIES)[number];
const CATEGORY_OF_APP: Readonly<Record<string, UsageCategory>> = {
  gmail: "email", googlecalendar: "calendar", slack: "messaging", discord: "messaging", twitter: "social", reddit: "social",
  googledocs: "docs", googledrive: "docs", notion: "docs", dropbox: "docs", figma: "docs", github: "coding", linear: "coding", sentry: "coding", jira: "coding",
  googlesheets: "data", airtable: "data", hubspot: "data", salesforce: "data", stripe: "data", posthog: "data", asana: "docs", trello: "docs", zapier: "other",
};
// an app says the most about what the turn was for, so apps go first, in this order of strength
const APP_ORDER: readonly UsageCategory[] = ["email", "calendar", "social", "messaging", "coding", "data", "docs", "other"];

/** a turn's coarse purpose from what it touched, worked out on the workspace; no text is read */
export function categorize(input: { tools: readonly string[]; apps: readonly string[] }): UsageCategory {
  const fromApps = new Set(input.apps.map(app => CATEGORY_OF_APP[app]).filter((value): value is UsageCategory => !!value));
  for (const category of APP_ORDER) if (fromApps.has(category)) return category;
  const tools = new Set(input.tools);
  if (tools.has("terminal")) return "coding";
  if (tools.has("data")) return "data";
  if (tools.has("image")) return "image";
  if (tools.has("computer") || tools.has("phone")) return "computer";
  if (tools.has("browser") || tools.has("web")) return "research";
  if (tools.has("files")) return "files";
  if (tools.has("app") || tools.has("mcp")) return "other";
  const meaningful = [...tools].filter(tool => tool !== "memory" && tool !== "other" && tool !== "widget");
  return meaningful.length ? "other" : "chat";
}

/** each tool name a turn called as a tool kind and, for a connected app, its curated slug or "other_app" */
export function toolSignals(names: readonly string[]): { tools: UsageTool[]; apps: string[] } {
  const tools = new Set<UsageTool>(), apps = new Set<string>();
  for (const name of names) {
    if (typeof name !== "string") continue;
    const look = traceToolLook(name);
    tools.add(TOOL_OF_ICON[look.icon] ?? "other");
    if (look.icon === "app") apps.add(look.app && APP_SET.has(look.app) ? look.app : "other_app");
  }
  return { tools: [...tools].sort(), apps: [...apps].sort() };
}

export const USAGE_REASONS = ["rate_limit", "quota", "auth", "timeout", "network", "context", "refused", "crashed", "tool", "model_not_found", "bad_request", "provider_down",
  "cli_missing", "cli_exit_early", "no_reply", "unknown"] as const;
export type UsageReason = (typeof USAGE_REASONS)[number];
/** a failure's code and its short sanitized detail: an HTTP status, a provider's or engine's error code or class, an
 * errno, a cli exit code or signal, joined by ":" (like "http_429:insufficient_quota" or "exit_1"); never message text */
export interface UsageFailure { reason: UsageReason; detail?: string }
export const FAILURE_DETAIL = /^[A-Za-z0-9_]{1,40}(?::[A-Za-z0-9_]{1,40}){0,3}$/;
const DETAIL_MAX = 72;

// what a code token may look like: a snake_case or camelCase identifier, a class name ending in Error, never prose
const CODE_TOKEN = /^(?:[a-z][a-z0-9]*(?:_[a-z0-9]+){1,6}|[a-z]+(?:[A-Z][a-z0-9]+){1,6}|[A-Z][A-Za-z0-9]{1,40}Error)$/;
// a code a driver hands over from the engine's structured error ("unauthorized", "usageLimitExceeded", "APIError")
const DRIVER_CODE = /^(?:[a-z][a-zA-Z0-9_]{1,39}|[A-Z][A-Za-z0-9]{1,40}Error)$/;
/** a driver's own error code, kept only when it is an identifier; anything else is dropped */
export const failureCode = (value: unknown): string | undefined => typeof value === "string" && value.length <= 40 && DRIVER_CODE.test(value) ? value : undefined;
/** a JSON-RPC error's numeric code as a driver code ("rpc_32603"), for an engine whose error named no code of its own */
export const rpcCode = (value: unknown): string | undefined => Number.isInteger(value) && Math.abs(value as number) < 100_000 ? `rpc_${Math.abs(value as number)}` : undefined;
/** a driver's code hint ("httpConnectionFailed:http_502") as its checked parts */
const hintParts = (value: unknown): string[] => typeof value === "string" && value.length <= DETAIL_MAX
  ? value.split(":").filter((part, index) => index === 0 ? !!failureCode(part) : /^http_\d{3}$/.test(part) || !!failureCode(part)) : [];

/** a cli's exit before its turn's result as a driver code: "crashed" for a signal, "cli_missing" for 127, else
 * "cli_exit_early"; then the exit code or signal, whether any reply or step came first, and the cli version when known
 * ("cli_exit_early:exit_1:no_output:v0_160_1") */
export function cliExitCode(exit: { code: number | null; signal?: string | null; output: boolean; version?: unknown }): string {
  const signal = typeof exit.signal === "string" && /^SIG[A-Z0-9]{2,8}$/.test(exit.signal) ? exit.signal : null;
  const reason = signal && signal !== "SIGTERM" && signal !== "SIGINT" ? "crashed" : exit.code === 127 ? "cli_missing" : "cli_exit_early";
  const how = signal ? signal.toLowerCase() : Number.isInteger(exit.code) ? `exit_${String(exit.code).replace("-", "neg")}` : "exit_null";
  const version = typeof exit.version === "string" ? /\d+(?:\.\d+){0,3}/.exec(exit.version)?.[0] : Array.isArray(exit.version) ? exit.version.slice(0, 4).join(".") : undefined;
  return [reason, how, exit.output ? "after_output" : "no_output", ...(version && /^[\d.]{1,20}$/.test(version) ? [`v${version.replaceAll(".", "_")}`] : [])].join(":");
}

// the engines' structured codes: codex app-server's codexErrorInfo, OpenCode's error class names, providers' error codes
const CODE_REASONS: ReadonlyArray<[RegExp, UsageReason]> = [
  [/^(?:contextWindowExceeded|context_length_exceeded|ContextOverflowError|string_above_max_length|MessageOutputLengthError)$/, "context"],
  [/^(?:usageLimitExceeded|insufficient_quota|quota_exceeded|billing_hard_limit_reached|insufficient_balance|subscription_sharing_usage_limit_exceeded|free_pool_limit)$/, "quota"],
  [/^(?:rate_limit_exceeded|rate_limit_error|free_rate_limited)$/, "rate_limit"],
  [/^(?:unauthorized|invalid_api_key|authentication_error|permission_error|ProviderAuthError|invalid_credentials|inactive_subscription)$/, "auth"],
  [/^(?:model_not_found|ProviderModelNotFoundError|unknown_model|provider_not_configured)$/, "model_not_found"],
  [/^(?:badRequest|invalid_request_error|invalid_request|rpc_32700|rpc_32600|rpc_32601|rpc_32602)$/, "bad_request"],
  [/^(?:announced_no_action|max_steps)$/, "no_reply"],
  [/^(?:tool_args_malformed|reused_call_id)$/, "tool"],
  [/^(?:internalServerError|serverOverloaded|responseTooManyFailedAttempts|overloaded_error|api_error|server_error|upstream_outage|free_busy)$/, "provider_down"],
  [/^(?:httpConnectionFailed|responseStreamConnectionFailed|responseStreamDisconnected)$/, "network"],
  [/^(?:free_timeout)$/, "timeout"],
  [/^(?:free_no_reply|free_empty|free_error)$/, "no_reply"],
  [/^crashed$/, "crashed"],
  [/^cli_missing$/, "cli_missing"],
];
// a turn's stop reason, when it is a bare token and the words said nothing
const STOP_REASONS: Readonly<Record<string, UsageReason>> = {
  exit_before_result: "cli_exit_early", spawn_error: "cli_missing", auth_required: "auth", quota: "quota", no_reply: "no_reply", provider_safety: "refused",
  max_tokens: "context", refusal: "refused", tool_error: "tool",
};

const STATUS = /\bHTTP (\d{3})\b|\(status (\d{3})\b|\bstatus(?: code)?[:= ]+(\d{3})\b|^API Error:? (\d{3})\b|"status(?:Code)?"\s*:\s*(\d{3})\b|\b(\d{3}) (?:Bad Request|Unauthorized|Payment Required|Forbidden|Not Found|Request Timeout|Payload Too Large|Unprocessable Entity|Too Many Requests|Internal Server Error|Bad Gateway|Service Unavailable|Gateway Timeout)\b/i;
const EXIT = /\bexited (?:with code )?(-?\d{1,3}|null)\b/;
const SIGNAL = /\b(SIG(?:KILL|SEGV|BUS|ILL|ABRT|SYS|TERM|INT|HUP|PIPE))\b/;
const ERRNO = /\b(E(?:CONNRESET|CONNREFUSED|CONNABORTED|NOTFOUND|AI_AGAIN|TIMEDOUT|PIPE|HOSTUNREACH|NETUNREACH|NOENT|ACCES|PERM)|UND_ERR_[A-Z_]{3,30}|ERR_[A-Z_]{3,30})\b/;
// a provider's code in parentheses ("… (insufficient_quota)"), a JSON code or type field, an error class name
const PAREN_CODE = /\(([a-z][a-z0-9]*(?:_[a-z0-9]+){1,6})\)\s*$/;
const JSON_CODE = /"(?:code|type)"\s*:\s*"([A-Za-z][A-Za-z0-9_]{2,39})"/g;
const ERROR_CLASS = /\b([A-Z][A-Za-z0-9]{1,40}Error)\b/;

const CONTEXT_WORDS = /context[_ ](?:length|window)|maximum context|context (?:is )?too long|prompt is too long|too many (?:input )?tokens|(?:token|context) limit|reduce the length|ran out of room/i;
const MODEL_WORDS = /\bmodel(?:[_ ]not[_ ]found| (?:is )?not (?:found|available|supported)| does not exist)|\b(?:unknown|unsupported|invalid) model\b|model ['"`]?[\w./:-]{1,80}['"`]? (?:does not exist|is not (?:found|available|supported)|not found)|no endpoints found|\bmodel not exist|not a valid model|模型不存在/i;
const QUOTA_STRONG = /insufficient[_ ]quota|余额不足|欠费|used up its free replies|exceeded your current quota|quota (?:exceeded|exhausted)|usage limit|out of credits?|insufficient (?:account )?(?:funds|balance|credits?)|payment required|plan limit|reached (?:its|your|the) [\w -]{0,24}limit|credit balance|no credits? (?:left|remaining)/i;
const RATE_WORDS = /rate.?limit|too many requests/i;
const QUOTA_WORDS = /quota|credit|billing|exceeded your|\bsubscription\b/i;
const AUTH_WORDS = /\bauth(?:enticat|oriz)|sign(?:ed)? ?in\b|log(?:ged)? ?in\b|unauthori[sz]ed|forbidden|api key|token (?:expired|invalid)|\bexpired\b|not signed in|invalid credentials/i;
const REFUSED_WORDS = /refus|content policy|safety|flagged/i;
const DOWN_WORDS = /overloaded|internal server error|bad gateway|service unavailable|gateway timeout|server (?:error|problem)|temporar(?:y|ily) unavailable|upstream (?:error|outage)/i;
const TIMEOUT_WORDS = /time ?out|timed out|took too long|stalled|deadline|did not answer in time/i;
const NETWORK_WORDS = /network|econn|enotfound|socket|fetch failed|unreachable|\bdns\b|offline|could not be reached|connection (?:error|reset|refused|closed)|stream (?:disconnected|closed|error)|disconnected|terminated|error sending request/i;
const MISSING_WORDS = /isn't installed|not installed|isn't on this app's PATH|command not found|CLI not found/i;
const BAD_REQUEST_WORDS = /invalid request|bad request|malformed|invalid (?:parameter|argument|value)|unsupported (?:parameter|value)|is not supported|unprocessable/i;
const NO_REPLY_WORDS = /no (?:completion|reply|response)\b|returned no|empty (?:reply|response|completion)|stopped without saying why|didn'?t reply|no free backup model answered/i;
// engine-errors.ts's refused tool schema or tool count: the provider turned the request down as invalid
const TOOL_SCHEMA_WORDS = /input schema of|takes at most .{1,30} tools|invalid schema for function/i;
const CRASH_WORDS = /crash|segfault|panic|killed|core dumped/i;

function byStatus(status: number, text: string): UsageReason | null {
  if (status === 401 || status === 403) return "auth";
  if (status === 402) return "quota";
  if (status === 404) return /model|endpoint/i.test(text) ? "model_not_found" : "bad_request";
  if (status === 408) return "timeout";
  if (status === 413) return "context";
  if (status === 429) return QUOTA_STRONG.test(text) ? "quota" : "rate_limit";
  if (status >= 500) return "provider_down";
  if (status >= 400) return "bad_request";
  return null;
}

/** the detail tokens in a failure's text: status, the provider's code, the error class, errno, exit code, signal */
function detailOf(line: string, hints: readonly string[]): string | undefined {
  const parts: string[] = [];
  const push = (part: string | undefined) => { if (part && !parts.includes(part) && parts.length < 4) parts.push(part); };
  for (const hint of hints) push(hint);
  const status = STATUS.exec(line);
  const code = status?.slice(1).find(Boolean);
  if (code) {
    // a provider's own code rides only with its status: the chat-completions drivers' "(insufficient_quota)" suffix or its JSON body
    push(`http_${code}`);
    push(PAREN_CODE.exec(line)?.[1]);
    for (const match of line.matchAll(JSON_CODE)) { if (CODE_TOKEN.test(match[1]!)) { push(match[1]); break; } }
  }
  const errorClass = ERROR_CLASS.exec(line)?.[1];
  if (errorClass) push(errorClass);
  push(ERRNO.exec(line)?.[1]?.toLowerCase());
  if (!hints.some(hint => /^(?:exit_|sig)/.test(hint))) {
    const exit = EXIT.exec(line)?.[1];
    if (exit) push(exit === "null" ? "exit_null" : `exit_${exit.replace("-", "neg")}`);
    push(SIGNAL.exec(line)?.[1]?.toLowerCase());
  }
  let detail = parts.join(":");
  while (detail.length > DETAIL_MAX && parts.length > 1) { parts.pop(); detail = parts.join(":"); }
  return detail && FAILURE_DETAIL.test(detail) && detail.length <= DETAIL_MAX ? detail : undefined;
}

function reasonOf(line: string, hint: string | undefined): UsageReason {
  if (hint) for (const [pattern, reason] of CODE_REASONS) if (pattern.test(hint)) return reason;
  const signal = SIGNAL.exec(line)?.[1];
  if (signal && signal !== "SIGTERM" && signal !== "SIGINT" && /exited|killed|signal/i.test(line)) return "crashed";
  if (MISSING_WORDS.test(line) || /\bexited 127\b/.test(line) || (/\bENOENT\b/.test(line) && /spawn/i.test(line))) return "cli_missing";
  if (CONTEXT_WORDS.test(line)) return "context";
  if (MODEL_WORDS.test(line)) return "model_not_found";
  if (QUOTA_STRONG.test(line)) return "quota";
  const status = STATUS.exec(line)?.slice(1).find(Boolean);
  if (status) { const reason = byStatus(Number(status), line); if (reason) return reason; }
  if (RATE_WORDS.test(line)) return "rate_limit";
  if (QUOTA_WORDS.test(line)) return "quota";
  if (AUTH_WORDS.test(line)) return "auth";
  if (DOWN_WORDS.test(line)) return "provider_down";
  if (TIMEOUT_WORDS.test(line)) return "timeout";
  if (NETWORK_WORDS.test(line)) return "network";
  if (TOOL_SCHEMA_WORDS.test(line)) return "bad_request";
  if (REFUSED_WORDS.test(line) || /\bpolicy\b|\bblocked\b|not allowed|denied/i.test(line)) return "refused";
  if (BAD_REQUEST_WORDS.test(line)) return "bad_request";
  if (NO_REPLY_WORDS.test(line)) return "no_reply";
  if (EXIT.test(line) || /exited (?:unexpectedly|SIG)/.test(line)) return "cli_exit_early";
  if (CRASH_WORDS.test(line) || /\bspawn\b/i.test(line)) return "crashed";
  if (/\btool\b/i.test(line)) return "tool";
  return "unknown";
}

/** a failure's text as a reason and a short detail, read on the workspace: the text itself is never sent. `code` is a
 * driver's structured error code and `stopReason` the turn's stop reason; each counts only when it is a bare token */
export function failureOf(text: unknown, hints: { code?: unknown; stopReason?: unknown } = {}): UsageFailure {
  const line = typeof text === "string" ? text.slice(0, 2000) : "";
  const codes = hintParts(hints.code), code = codes[0];
  // a cli exit code's first part names its reason; the detail keeps the rest
  const detailCodes = code && (USAGE_REASONS as readonly string[]).includes(code) ? codes.slice(1) : codes;
  const stop = typeof hints.stopReason === "string" && /^[a-z][a-z0-9_]{1,30}$/.test(hints.stopReason) ? hints.stopReason : undefined;
  let reason = line || code ? reasonOf(line, code) : "unknown";
  if (reason === "unknown" && code && (USAGE_REASONS as readonly string[]).includes(code)) reason = code as UsageReason;
  if (reason === "unknown" && stop && Object.hasOwn(STOP_REASONS, stop)) reason = STOP_REASONS[stop]!;
  const detail = detailOf(line, detailCodes) ?? (reason !== "unknown" || !stop ? undefined : `stop_${stop}`.slice(0, 40));
  return { reason, ...(detail ? { detail } : {}) };
}

/** an error line as a reason code, on the workspace: the line itself is never sent */
export function failureReason(text: unknown): UsageReason {
  return failureOf(text).reason;
}

/** who started the turn: the person at this workspace's own app, the person from another device (a phone, a browser,
 * another computer), or no person */
export const USAGE_FROM = ["app", "remote", "routine", "bot", "helper"] as const;
export type UsageFrom = (typeof USAGE_FROM)[number];
/** where the bot ran */
export const USAGE_PLACES = ["desktop", "cloud", "server"] as const;
export type UsagePlace = (typeof USAGE_PLACES)[number];
export const USAGE_OUTCOMES = ["ok", "failed", "cancelled"] as const;
export type UsageOutcome = (typeof USAGE_OUTCOMES)[number];
export const USAGE_RUN_TRIGGERS = ["schedule", "event", "webhook", "manual", "api"] as const;
export type UsageRunTrigger = (typeof USAGE_RUN_TRIGGERS)[number];

export interface UsageTurn {
  /** a random id, so a report sent twice counts once */
  id: string;
  at: number;
  engine: UsageEngine;
  outcome: UsageOutcome;
  reason?: UsageReason;
  /** a failed turn's sanitized detail (`FAILURE_DETAIL`): a status, an error code or class, an exit code, never text */
  detail?: string;
  /** the whole turn, start to end */
  ms: number;
  tools: UsageTool[];
  apps: string[];
  category: UsageCategory;
  from: UsageFrom;
  place: UsagePlace;
  /** the turn was in a room (a group chat) */
  room: boolean;
  /** time to the first model step's end, a stand-in for the first reply token */
  firstMs?: number;
  /** the model's family when it is a known public one (like claude-sonnet or gpt-5), else "other" */
  model?: string;
  /** tool kinds and apps whose call failed in this turn */
  failedTools?: UsageTool[];
  failedApps?: string[];
  /** a connected app's action names (like gmail_send_email), from its catalog, for curated apps only */
  actions?: string[];
  /** a salted hash of the bot and of the chat, kept on the workspace: counts turns per bot and per chat, names neither */
  bot?: string;
  chat?: string;
}
export interface UsageRun {
  id: string; at: number; trigger: UsageRunTrigger; outcome: UsageOutcome; reason?: UsageReason;
  /** how long the run took */
  ms?: number;
  /** how often the routine is set to run */
  every?: RunEvery;
  /** a salted hash of the routine, so a routine's runs can be counted over weeks without naming it */
  routine?: string;
}
export const RUN_EVERY = ["once", "minutes", "hourly", "daily", "weekdays", "weekly", "monthly", "event", "other"] as const;
export type RunEvery = (typeof RUN_EVERY)[number];
/** counts only: how much of each thing the workspace has */
export interface UsageSnapshot {
  bots: number; rooms: number; routines: number; webhooks: number; appEvents: number; skills: number;
  chats?: number; archived?: number;
  /** the memory folder's size as a bucket: 0 empty, 1 under 10 KB, 2 under 100 KB, 3 under 1 MB, 4 under 10 MB, 5 more */
  memory?: number;
  /** bots per engine family */
  botEngines?: Partial<Record<UsageEngine, number>>;
}
/** a named signal from the workspace (shared/product-signals.ts) */
export interface UsageSignal { id: string; at: number; name: string; props: Record<string, string | number | boolean> }
export const FRUSTRATION_SIGNALS = ["thumbs_down", "stopped", "retried", "failed", "corrective", "shouting", "swearing"] as const;
export type FrustrationSignal = (typeof FRUSTRATION_SIGNALS)[number];
/** a chat that went badly: what the person did, what the turn touched, and an abstract line the person's own engine
 * wrote on the workspace and `scrubSummary` cleaned there. never their messages. */
export interface UsageFrustration {
  id: string;
  at: number;
  engine: UsageEngine;
  category: UsageCategory;
  tools: UsageTool[];
  apps: string[];
  reason?: UsageReason;
  signals: FrustrationSignal[];
  /** follow-ups that repeated or rephrased the same request */
  retries: number;
  summary?: string;
}
/** a weekly line about what one person uses Madani for, written by their own engine on the workspace and scrubbed there */
export interface UsageDigest { id: string; at: number; turns: number; days: number; summary: string }
/** a big or long session in one chat: what it touched, counted, and a note on what worked and what was friction,
 * written by the person's own engine on the workspace and scrubbed there */
export interface UsageSession {
  id: string;
  at: number;
  engine: UsageEngine;
  category: UsageCategory;
  tools: UsageTool[];
  apps: string[];
  turns: number;
  /** from the session's first turn to its last */
  minutes: number;
  /** turns that failed */
  failed: number;
  summary?: string;
}
export interface UsageReport { turns: UsageTurn[]; runs: UsageRun[]; frustrations?: UsageFrustration[]; sessions?: UsageSession[]; digests?: UsageDigest[]; signals?: UsageSignal[]; snapshot?: UsageSnapshot }

export const USAGE_TURN_KEYS = ["id", "at", "engine", "outcome", "reason", "detail", "ms", "tools", "apps", "category", "from", "place", "room", "firstMs", "model", "failedTools", "failedApps", "actions", "bot", "chat"] as const;
export const USAGE_RUN_KEYS = ["id", "at", "trigger", "outcome", "reason", "ms", "every", "routine"] as const;
export const USAGE_SNAPSHOT_KEYS = ["bots", "rooms", "routines", "webhooks", "appEvents", "skills"] as const;
export const USAGE_SNAPSHOT_EXTRA_KEYS = ["chats", "archived", "memory", "botEngines"] as const;
export const USAGE_SIGNAL_KEYS = ["id", "at", "name", "props"] as const;
export const MAX_REPORT_SIGNALS = 300;
const HASH = /^[A-Za-z0-9_-]{10}$/;
// OpenCode's public provider ids (models.dev): a provider someone named in their own config never matches
const OPENCODE_PROVIDERS = new Set(["anthropic", "openai", "google", "google-vertex", "openrouter", "github-copilot", "github-models", "groq", "deepseek", "xai", "mistral",
  "zai", "zai-coding-plan", "zhipuai", "moonshotai", "moonshotai-cn", "fireworks-ai", "togetherai", "amazon-bedrock", "azure", "ollama", "lmstudio", "cerebras", "vercel",
  "minimax", "alibaba", "nvidia", "huggingface", "deepinfra", "baseten", "chutes", "venice", "perplexity", "cohere", "inception", "requesty", "upstage", "zen", "opencode-go"]);
/** the OpenCode provider an OpenCode model id ("anthropic/claude-x", "opencode/big-pickle") goes through, as
 * "opencode/<provider>" ("opencode/zen" for OpenCode's own), or null for a provider that is not a public one */
export function opencodeProvider(model: unknown): string | null {
  if (typeof model !== "string") return null;
  const id = model.toLowerCase().split("/")[0]!;
  const provider = id === "opencode" ? "zen" : id;
  return model.includes("/") && OPENCODE_PROVIDERS.has(provider) ? `opencode/${provider}` : null;
}
/** a model name's public family, or "other": a name someone typed for a custom endpoint never matches */
export function modelFamily(model: unknown): string {
  if (typeof model !== "string") return "other";
  const label = /^opencode\/([a-z-]{2,24})$/.exec(model);
  if (label && OPENCODE_PROVIDERS.has(label[1]!)) return model;
  const bare = model.toLowerCase().split(/[/:]/).at(-1)!.replace(/\[.*$/, "");
  const known = /^(claude-(?:opus|sonnet|haiku)(?:-\d+(?:[.-]\d+)?)?|gpt-\d+(?:\.\d+)?(?:-(?:mini|nano|codex|pro))?|o\d(?:-mini|-pro)?|gemini-\d+(?:\.\d+)?-(?:pro|flash|flash-lite)|grok-\d+(?:\.\d+)?(?:-(?:fast|mini|code))?|kimi-k\d+(?:\.\d+)?|deepseek-(?:v\d+(?:\.\d+)?|r\d|chat|reasoner)|qwen\d*(?:\.\d+)?-(?:coder|max|plus)|glm-\d+(?:\.\d+)?|mistral-(?:large|medium|small)|llama-?\d+(?:\.\d+)?)/.exec(bare);
  return known ? known[1]! : "other";
}
const ACTION = /^[a-z0-9]+(?:_[a-z0-9]+){1,7}$/;
/** a connected app's action name from a Composio-style tool name, when the app is a curated one */
export function appAction(name: string): string | null {
  const bare = name.replace(/^mcp__[^_]+(?:_[^_]+)*?__/, "");
  const match = /^([A-Z][A-Z0-9]+)_[A-Z0-9_]+$/.exec(bare);
  if (!match || !APP_SET.has(match[1]!.toLowerCase())) return null;
  const action = bare.toLowerCase().slice(0, 60);
  return ACTION.test(action) ? action : null;
}
/** the frequency of a routine's schedule as a bucket */
export function runEvery(schedule: { type?: string; everyMinutes?: number; weekdays?: number[]; cron?: string; expression?: string } | undefined, eventDriven = false): RunEvery {
  if (eventDriven) return "event";
  if (!schedule?.type) return "other";
  if (schedule.type === "once") return "once";
  if (schedule.type === "interval") { const m = schedule.everyMinutes ?? 0; return m < 60 ? "minutes" : m < 24 * 60 ? "hourly" : m < 7 * 24 * 60 ? "daily" : "weekly"; }
  if (schedule.type === "daily") { const days = schedule.weekdays?.length ?? 7; return days >= 7 || days === 0 ? "daily" : days === 5 ? "weekdays" : days === 1 ? "weekly" : "other"; }
  const cron = (schedule.cron ?? schedule.expression ?? "").trim().split(/\s+/);
  if (cron.length >= 5) { if (cron[0]!.includes("/") || cron[1] === "*") return cron[1] === "*" ? (cron[0] === "0" ? "hourly" : "minutes") : "daily";
    if (cron[2] !== "*") return "monthly"; if (cron[4] !== "*") return cron[4]!.includes("-") || cron[4]!.includes(",") ? "weekdays" : "weekly"; return "daily"; }
  return "other";
}
export const USAGE_FRUSTRATION_KEYS = ["id", "at", "engine", "category", "tools", "apps", "reason", "signals", "retries", "summary"] as const;
export const MAX_REPORT_TURNS = 500;
export const MAX_REPORT_FRUSTRATIONS = 50;
export const SUMMARY_MAX = 240, DIGEST_MAX = 700;
export const USAGE_DIGEST_KEYS = ["id", "at", "turns", "days", "summary"] as const;
export const MAX_REPORT_RUNS = 200;
export const USAGE_SESSION_KEYS = ["id", "at", "engine", "category", "tools", "apps", "turns", "minutes", "failed", "summary"] as const;
export const MAX_REPORT_SESSIONS = 20, SESSION_NOTE_MAX = 400;

const ID = /^[A-Za-z0-9_-]{8,40}$/;
const oneOf = <T extends string>(list: readonly T[], value: unknown): value is T => typeof value === "string" && (list as readonly string[]).includes(value);
const count = (value: unknown, max = 1e12): value is number => Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) < max;
const DAY = 86_400_000;
const time = (value: unknown, now: number) => count(value, 1e14) && value > now - 30 * DAY && value < now + 10 * 60_000;

/** a turn exactly as it may be sent and stored, or null: unknown keys are dropped and any bad value drops the record */
export function cleanUsageTurn(input: unknown, now = Date.now()): UsageTurn | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const v = input as Record<string, unknown>;
  if (typeof v.id !== "string" || !ID.test(v.id) || !time(v.at, now) || !oneOf(USAGE_ENGINES, v.engine) || !oneOf(USAGE_OUTCOMES, v.outcome) || !count(v.ms, 7 * DAY)
    || !Array.isArray(v.tools) || !Array.isArray(v.apps) || !oneOf(USAGE_CATEGORIES, v.category) || !oneOf(USAGE_FROM, v.from) || !oneOf(USAGE_PLACES, v.place) || typeof v.room !== "boolean") return null;
  const tools = [...new Set(v.tools.slice(0, USAGE_TOOLS.length).filter((tool): tool is UsageTool => oneOf(USAGE_TOOLS, tool)))].sort();
  const apps = [...new Set(v.apps.slice(0, 20).filter((app): app is string => typeof app === "string" && (APP_SET.has(app) || app === "other_app")))].sort();
  const reason = v.outcome === "ok" ? undefined : oneOf(USAGE_REASONS, v.reason) ? v.reason : "unknown";
  const detail = v.outcome === "failed" && typeof v.detail === "string" && v.detail.length <= DETAIL_MAX && FAILURE_DETAIL.test(v.detail) ? v.detail : undefined;
  const failedTools = Array.isArray(v.failedTools) ? [...new Set(v.failedTools.filter((tool): tool is UsageTool => oneOf(USAGE_TOOLS, tool)))].sort() : [];
  const failedApps = Array.isArray(v.failedApps) ? [...new Set(v.failedApps.filter((app): app is string => typeof app === "string" && (APP_SET.has(app) || app === "other_app")))].sort() : [];
  const actions = Array.isArray(v.actions) ? [...new Set(v.actions.slice(0, 20).filter((action): action is string => typeof action === "string" && ACTION.test(action) && APP_SET.has(action.split("_")[0]!)))].slice(0, 10) : [];
  const model = typeof v.model === "string" ? modelFamily(v.model) : undefined;
  return { id: v.id, at: v.at as number, engine: v.engine, outcome: v.outcome, ...(reason ? { reason } : {}), ...(detail ? { detail } : {}), ms: v.ms, tools, apps, category: v.category, from: v.from, place: v.place, room: v.room,
    ...(count(v.firstMs, 7 * DAY) && v.firstMs <= v.ms ? { firstMs: v.firstMs } : {}), ...(model ? { model } : {}), ...(failedTools.length ? { failedTools } : {}), ...(failedApps.length ? { failedApps } : {}),
    ...(actions.length ? { actions } : {}), ...(typeof v.bot === "string" && HASH.test(v.bot) ? { bot: v.bot } : {}), ...(typeof v.chat === "string" && HASH.test(v.chat) ? { chat: v.chat } : {}) };
}

export function cleanUsageRun(input: unknown, now = Date.now()): UsageRun | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const v = input as Record<string, unknown>;
  if (typeof v.id !== "string" || !ID.test(v.id) || !time(v.at, now) || !oneOf(USAGE_RUN_TRIGGERS, v.trigger) || !oneOf(USAGE_OUTCOMES, v.outcome)) return null;
  const reason = v.outcome === "ok" ? undefined : oneOf(USAGE_REASONS, v.reason) ? v.reason : "unknown";
  return { id: v.id, at: v.at as number, trigger: v.trigger, outcome: v.outcome, ...(reason ? { reason } : {}), ...(count(v.ms, 7 * DAY) ? { ms: v.ms } : {}),
    ...(oneOf(RUN_EVERY, v.every) ? { every: v.every } : {}), ...(typeof v.routine === "string" && HASH.test(v.routine) ? { routine: v.routine } : {}) };
}

/** a frustration record as it may be sent and stored; a summary the scrubber would change is dropped, the record kept */
export function cleanUsageFrustration(input: unknown, now = Date.now()): UsageFrustration | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const v = input as Record<string, unknown>;
  if (typeof v.id !== "string" || !ID.test(v.id) || !time(v.at, now) || !oneOf(USAGE_ENGINES, v.engine) || !oneOf(USAGE_CATEGORIES, v.category)
    || !Array.isArray(v.tools) || !Array.isArray(v.apps) || !Array.isArray(v.signals) || !count(v.retries, 100)) return null;
  const signals = [...new Set(v.signals.filter((signal): signal is FrustrationSignal => oneOf(FRUSTRATION_SIGNALS, signal)))].sort();
  if (!signals.length) return null;
  const tools = [...new Set(v.tools.slice(0, USAGE_TOOLS.length).filter((tool): tool is UsageTool => oneOf(USAGE_TOOLS, tool)))].sort();
  const apps = [...new Set(v.apps.slice(0, 20).filter((app): app is string => typeof app === "string" && (APP_SET.has(app) || app === "other_app")))].sort();
  const summary = typeof v.summary === "string" && scrubSummary(v.summary) === v.summary ? v.summary : undefined;
  return { id: v.id, at: v.at as number, engine: v.engine, category: v.category, tools, apps, ...(oneOf(USAGE_REASONS, v.reason) ? { reason: v.reason } : {}), signals,
    retries: v.retries, ...(summary ? { summary } : {}) };
}

const EMAIL = /[^\s@]+@[^\s@]+/g, URL_LIKE = /\b(?:https?:\/\/|www\.)\S+|\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|net|org|io|ai|dev|app|co|bot|me|so|xyz|in|uk|de)\b\S*/gi;
const HANDLE = /(?:^|\s)[@#]\w+/g, QUOTED = /["“”«»`][^"“”«»`]*["“”«»`]|(?<=^|\s)'[^']{2,}'(?=$|[\s.,;:!?])/g, FILE = /\b[\w-]+\.[a-z0-9]{1,5}\b/gi;
const PATH = /(?:^|\s)\S*[/\\~]\S*/g, LONG = /\S{31,}/g;
// digits joined by spaces, dashes, dots or brackets: phone numbers, dates, card and account numbers
const NUMBER_RUN = /\+?\d[\d().\s-]*[\s().-][\d().\s-]*\d/g, DIGITS = /\S*\d\S*/g, COUNT = /^\d{1,3}[,.;:!?)]?$/;
/** product and app words a note may name even when written capitalised, like "connecting Gmail took 3 tries" */
export const NOTE_WORDS: ReadonlySet<string> = new Set([
  ...USAGE_APPS, ...USAGE_ENGINES, "google", "calendar", "drive", "docs", "sheets", "outlook", "teams", "whatsapp", "telegram", "imessage", "chrome", "safari", "mac", "macos",
  "windows", "linux", "iphone", "android", "excel", "word", "powerpoint", "pdf", "chatgpt", "openai", "anthropic", "mcp", "api", "vps", "ai", "ok", "i", "x",
  "linkedin", "instagram", "facebook", "youtube", "tiktok", "zoom", "meet", "canva", "spotify", "perplexity", "claude", "vscode", "messenger",
  "madani", "bot", "bots", "chat", "chats", "browser", "app", "apps", "assistant", "agent", "model", "computer", "screen", "terminal", "phone", "desktop",
  "cloud", "web", "website", "site", "page", "tab", "link", "search", "routine", "routines", "memory", "skill", "skills", "task", "tasks", "email", "emails",
  "message", "messages", "post", "posts", "reply", "draft", "file", "files", "folder", "note", "notes", "account", "settings", "room", "team",
]);
const words = (text: string) => text.toLowerCase().normalize("NFKC").split(/[^\p{L}\p{N}']+/u).filter(Boolean);
/** a word run this long shared with the chat means the note copied the person's words */
export const COPIED_RUN = 6;
/** what the chat itself says must not reach a note: its proper nouns (capitalised mid-sentence), and the local parts
 * of addresses and handles in it. read on this computer only. */
export function chatAvoidWords(sources: readonly string[]): Set<string> {
  const avoid = new Set<string>();
  for (const source of sources) {
    for (const match of source.matchAll(/([^\s@]+)@[^\s@]+|(?:^|\s)[@#](\w+)/g)) for (const word of words(match[1] ?? match[2] ?? "")) avoid.add(word);
    for (const match of source.matchAll(/(?<=[\p{L}\p{N},;:)'"]\s+)\p{Lu}[\p{L}'-]*/gu)) { const word = match[0].toLowerCase().replace(/'s$/, ""); if (!NOTE_WORDS.has(word)) avoid.add(word); }
  }
  return avoid;
}
function copies(note: string, sources: readonly string[]): boolean {
  const mine = words(note);
  if (mine.length < COPIED_RUN) return false;
  const runs = new Set<string>();
  for (const source of sources) { const theirs = words(source); for (let i = 0; i + COPIED_RUN <= theirs.length; i++) runs.add(theirs.slice(i, i + COPIED_RUN).join(" ")); }
  for (let i = 0; i + COPIED_RUN <= mine.length; i++) if (runs.has(mine.slice(i, i + COPIED_RUN).join(" "))) return true;
  return false;
}
/** the writer saying it could not write the note (it saw no chat, or asks for one), not a note */
const NOT_A_NOTE = /^i(?:'m| am)?\b.{0,40}\b(?:can't|cannot|can not|unable|don't have|do not have)\b|\b(?:paste|share|send) (?:the|that|your) (?:exchange|conversation|chat|transcript)\b|\b(?:conversation|chat|transcript) (?:itself )?(?:isn't|is not|wasn't|was not) (?:in|included|provided|given|shown)\b|\bno record of the work\b|\bthe summary can(?:'t|not)?\b/i;
/** an engine's note as short lowercase prose with no message text, addresses, links, handles, paths, file names,
 * long numbers, ids or names; only small counts ("3 tries") and app names stay. `sources`, when given, are the chat
 * lines the engine read: a note that copies a run of their words is dropped, and their names are taken out. null when
 * cleaning took out too much for what is left to be trusted. */
export function scrubSummary(raw: unknown, max = SUMMARY_MAX, options: { sources?: readonly string[]; avoid?: readonly string[] } = {}): string | null {
  if (typeof raw !== "string") return null;
  const original = raw.replace(/\s+/g, " ").trim().slice(0, max * 2.5);
  if (original.length < 12 || NOT_A_NOTE.test(original)) return null;
  const sources = options.sources ?? [];
  if (sources.length && copies(original, sources)) return null;
  const avoid = new Set([...chatAvoidWords(sources), ...(options.avoid ?? []).flatMap(words)].filter(word => !NOTE_WORDS.has(word)));
  let text = original.replace(EMAIL, " ").replace(URL_LIKE, " ").replace(HANDLE, " ").replace(QUOTED, " ").replace(PATH, " ").replace(FILE, " ").replace(LONG, " ")
    .replace(NUMBER_RUN, " ").replace(DIGITS, (token: string) => COUNT.test(token) ? token : " ");
  // a capitalised word that does not start a sentence is taken as a name, unless it is a known app or product
  text = text.replace(/\b\p{Lu}[\p{L}'-]*/gu, (word: string, offset: number, whole: string) => offset === 0 || /[.!?;:]\s+$/.test(whole.slice(Math.max(0, offset - 3), offset))
    || NOTE_WORDS.has(word.toLowerCase().replace(/'s$/, "")) ? word : " ");
  if (avoid.size) text = text.replace(/[\p{L}\p{N}'-]+/gu, (word: string) => avoid.has(word.toLowerCase().replace(/'s$/, "")) ? " " : word);
  text = text.replace(/[^\p{L}\p{N}\s,.;:!?'()-]/gu, " ").replace(/\s+([,.;:!?])/g, "$1").replace(/\s+/g, " ").trim().toLowerCase();
  if (text.length < 12 || text.length < original.length * 0.7) return null;
  return text.length > max ? `${text.slice(0, max).replace(/\s+\S*$/, "")}.` : text;
}

/** a big session's record as it may be sent and stored; a note the scrubber would change is dropped, the record kept */
export function cleanUsageSession(input: unknown, now = Date.now()): UsageSession | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const v = input as Record<string, unknown>;
  if (typeof v.id !== "string" || !ID.test(v.id) || !time(v.at, now) || !oneOf(USAGE_ENGINES, v.engine) || !oneOf(USAGE_CATEGORIES, v.category)
    || !Array.isArray(v.tools) || !Array.isArray(v.apps) || !count(v.turns, 10_000) || !count(v.minutes, 7 * 24 * 60) || !count(v.failed, 10_000) || (v.failed as number) > (v.turns as number)) return null;
  const tools = [...new Set(v.tools.slice(0, USAGE_TOOLS.length).filter((tool): tool is UsageTool => oneOf(USAGE_TOOLS, tool)))].sort();
  const apps = [...new Set(v.apps.slice(0, 20).filter((app): app is string => typeof app === "string" && (APP_SET.has(app) || app === "other_app")))].sort();
  const summary = typeof v.summary === "string" && scrubSummary(v.summary, SESSION_NOTE_MAX) === v.summary ? v.summary : undefined;
  return { id: v.id, at: v.at as number, engine: v.engine, category: v.category, tools, apps, turns: v.turns as number, minutes: v.minutes as number, failed: v.failed as number, ...(summary ? { summary } : {}) };
}

export function cleanUsageDigest(input: unknown, now = Date.now()): UsageDigest | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const v = input as Record<string, unknown>;
  if (typeof v.id !== "string" || !ID.test(v.id) || !time(v.at, now) || !count(v.turns, 100_000) || !count(v.days, 8) || typeof v.summary !== "string" || scrubSummary(v.summary, DIGEST_MAX) !== v.summary) return null;
  return { id: v.id, at: v.at as number, turns: v.turns, days: v.days, summary: v.summary };
}

export function cleanUsageSnapshot(input: unknown): UsageSnapshot | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const v = input as Record<string, unknown>;
  const out: Record<string, number> = {};
  for (const key of USAGE_SNAPSHOT_KEYS) { if (!count(v[key], 100_000)) return null; out[key] = v[key] as number; }
  for (const key of ["chats", "archived"] as const) if (count(v[key], 1_000_000)) out[key] = v[key] as number;
  if (count(v.memory, 6)) out.memory = v.memory as number;
  const engines = v.botEngines && typeof v.botEngines === "object" && !Array.isArray(v.botEngines)
    ? Object.fromEntries(Object.entries(v.botEngines as Record<string, unknown>).filter(([key, value]) => oneOf(USAGE_ENGINES, key) && count(value, 10_000))) : {};
  return { ...(out as unknown as UsageSnapshot), ...(Object.keys(engines).length ? { botEngines: engines as UsageSnapshot["botEngines"] } : {}) };
}

/** a report's usage section, bounded; null when nothing in it is usable */
export function cleanUsageReport(input: unknown, now = Date.now(), cleanSignal?: (name: unknown, props: unknown) => UsageSignal["props"] | null): UsageReport | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const v = input as Record<string, unknown>;
  const turns = Array.isArray(v.turns) ? v.turns.slice(0, MAX_REPORT_TURNS).map(item => cleanUsageTurn(item, now)).filter((item): item is UsageTurn => !!item) : [];
  const runs = Array.isArray(v.runs) ? v.runs.slice(0, MAX_REPORT_RUNS).map(item => cleanUsageRun(item, now)).filter((item): item is UsageRun => !!item) : [];
  const frustrations = Array.isArray(v.frustrations) ? v.frustrations.slice(0, MAX_REPORT_FRUSTRATIONS).map(item => cleanUsageFrustration(item, now)).filter((item): item is UsageFrustration => !!item) : [];
  const sessions = Array.isArray(v.sessions) ? v.sessions.slice(0, MAX_REPORT_SESSIONS).map(item => cleanUsageSession(item, now)).filter((item): item is UsageSession => !!item) : [];
  const digests = Array.isArray(v.digests) ? v.digests.slice(0, 2).map(item => cleanUsageDigest(item, now)).filter((item): item is UsageDigest => !!item) : [];
  const signals = cleanSignal && Array.isArray(v.signals) ? v.signals.slice(0, MAX_REPORT_SIGNALS).flatMap((item): UsageSignal[] => {
    if (!item || typeof item !== "object") return [];
    const raw = item as Record<string, unknown>, props = cleanSignal(raw.name, raw.props);
    return props && typeof raw.id === "string" && ID.test(raw.id) && time(raw.at, now) ? [{ id: raw.id, at: raw.at as number, name: raw.name as string, props }] : [];
  }) : [];
  const snapshot = v.snapshot === undefined ? null : cleanUsageSnapshot(v.snapshot);
  if (!turns.length && !runs.length && !frustrations.length && !sessions.length && !digests.length && !signals.length && !snapshot) return null;
  return { turns, runs, ...(frustrations.length ? { frustrations } : {}), ...(sessions.length ? { sessions } : {}), ...(digests.length ? { digests } : {}), ...(signals.length ? { signals } : {}), ...(snapshot ? { snapshot } : {}) };
}

/** a routine run's start as a usage trigger */
export function runTrigger(run: { triggerSource?: string; eventSource?: string; manual?: boolean }): UsageRunTrigger {
  if (run.triggerSource === "webhook") return run.eventSource ? "event" : "webhook";
  if (run.triggerSource === "manual" || run.manual) return "manual";
  if (run.triggerSource === "api") return "api";
  return "schedule";
}
