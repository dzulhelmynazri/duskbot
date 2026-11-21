// A scripted workspace for the task-fidelity eval: the system prompt a turn would get, built from the same builders the
// server uses, the tools that turn would see, and mocked answers for every tool, so no real app is ever reached.
import { SLACK_TOOL_DEFINITIONS } from "../drivers/agents-slack-tools.ts";
import { TOOL_LIST as BROWSER_TOOLS } from "../browser/tools.ts";
import { CHROME_BROWSER_SYSTEM_PROMPT } from "../browser/prompt.ts";
import { surfacePrompt } from "../surface.ts";
import {
  botPersona, buildSystemPrompt, composioSystemPrompt, computerPrompt, CREDENTIAL_PROMPT, JUST_DO_IT_PROMPT, longCommandsPrompt,
  THREADS_PROMPT, userProfileSystemPrompt, WIDGET_PROMPT, workspacePrompt, type PromptPart,
} from "../system-prompt.ts";
import type { ConnectorToolGrant } from "../../shared/wire.ts";

export type Family = "connector" | "browser" | "computer" | "web" | "files" | "shell" | "madani";
export type Slack = "bridge" | "composio" | null;

export interface Channel { id: string; name: string }
export interface Person { id: string; name: string; email: string }
export interface Email { id: string; thread: string; from: string; subject: string; body: string }

export interface World {
  slack: Slack;
  /** connected apps reached through composio, by service slug */
  apps: string[];
  browser: boolean;
  computer: "local" | null;
  fullAccess?: boolean;
  /** what the bot knows about the person, as About the user holds it */
  about?: string;
  /** earlier messages in this chat, oldest first */
  history?: Array<{ role: "user" | "assistant"; text: string }>;
  channels?: Channel[];
  people?: Person[];
  channelMessages?: Record<string, string[]>;
  emails?: Email[];
  events?: string[];
  /** files the person has, by path, for the file tools */
  files?: Record<string, string>;
  /** what session_search answers */
  recall?: string;
  /** apps on the computer, for the screen tools */
  desktopApps?: string[];
}

export interface Tool { name: string; description: string; input_schema: Record<string, unknown> }

const SCHEMA = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties, required });
const str = (description: string) => ({ type: "string", description });

/** The engine's own tools, as Claude Code offers them. */
const ENGINE_TOOLS: Tool[] = [
  { name: "Bash", description: "Run a shell command on the person's computer and return its output.", input_schema: SCHEMA({ command: str("The command") }, ["command"]) },
  { name: "Read", description: "Read a file from the person's computer by absolute path.", input_schema: SCHEMA({ file_path: str("Absolute path") }, ["file_path"]) },
  { name: "Glob", description: "Find files by glob pattern, such as **/*.md.", input_schema: SCHEMA({ pattern: str("Glob pattern"), path: str("Folder to search") }, ["pattern"]) },
  { name: "Grep", description: "Search file contents with a regular expression.", input_schema: SCHEMA({ pattern: str("Regex"), path: str("Folder") }, ["pattern"]) },
  { name: "Write", description: "Write a file in your working folder.", input_schema: SCHEMA({ file_path: str("Absolute path"), content: str("Content") }, ["file_path", "content"]) },
  { name: "WebSearch", description: "Search the web.", input_schema: SCHEMA({ query: str("Query") }, ["query"]) },
  { name: "WebFetch", description: "Fetch a web page as text.", input_schema: SCHEMA({ url: str("URL") }, ["url"]) },
];

const MADANI_TOOLS: Tool[] = [
  { name: "set_status", description: "Set the one-line status the person sees while you work.", input_schema: SCHEMA({ text: str("Status") }, ["text"]) },
  { name: "session_search", description: "Search this person's earlier chats and your notes.", input_schema: SCHEMA({ query: str("Words to look for") }, ["query"]) },
  { name: "memory_update", description: "Remember, correct or forget a fact about the person.", input_schema: SCHEMA({ action: str("add, replace or remove"), text: str("The fact") }, ["action", "text"]) },
  { name: "show_widget", description: "Show the person tap-to-answer choices or a small form in the chat.", input_schema: SCHEMA({ widget: { type: "object", description: "The card" } }, ["widget"]) },
  { name: "attach_file", description: "Attach a file you made to the chat.", input_schema: SCHEMA({ path: str("Path") }, ["path"]) },
  { name: "request_sign_in", description: "Post a card asking the person to sign in to a site where you work.", input_schema: SCHEMA({ site: str("Site"), reason: str("Why") }, ["site"]) },
];

const COMPOSIO_TOOLS: Tool[] = [
  { name: "COMPOSIO_SEARCH_TOOLS", description: "Find tools in the person's connected apps for a use case. Returns tool slugs with a short description.", input_schema: SCHEMA({ queries: { type: "array", items: { type: "object", properties: { use_case: str("What you want to do") } } } }, ["queries"]) },
  { name: "COMPOSIO_GET_TOOL_SCHEMAS", description: "Get the input schemas of tool slugs.", input_schema: SCHEMA({ tool_slugs: { type: "array", items: { type: "string" } } }, ["tool_slugs"]) },
  { name: "COMPOSIO_MULTI_EXECUTE_TOOL", description: "Run one or more connected-app tools by slug with their arguments.", input_schema: SCHEMA({ tools: { type: "array", items: { type: "object", properties: { tool_slug: { type: "string" }, arguments: { type: "object" } } } } }, ["tools"]) },
  { name: "COMPOSIO_MANAGE_CONNECTIONS", description: "Show the person a card that connects an app.", input_schema: SCHEMA({ toolkits: { type: "array", items: { type: "string" } } }, ["toolkits"]) },
];

const GMAIL_TOOLS: Tool[] = [
  { name: "gmail_search_emails", description: "Search the person's Gmail.", input_schema: SCHEMA({ query: str("Gmail search query") }, ["query"]) },
  { name: "gmail_read_email_thread", description: "Read a Gmail thread by id.", input_schema: SCHEMA({ thread_id: str("Thread id") }, ["thread_id"]) },
  { name: "gmail_create_draft", description: "Create a Gmail draft, optionally as a reply in a thread.", input_schema: SCHEMA({ to: str("Recipient"), subject: str("Subject"), body: str("Body"), thread_id: str("Reply in this thread") }, ["to", "body"]) },
];
const CALENDAR_TOOLS: Tool[] = [
  { name: "googlecalendar_list_events", description: "List events on the person's Google Calendar in a time range.", input_schema: SCHEMA({ time_min: str("ISO start"), time_max: str("ISO end") }) },
];

/** The person's own screen, as the computer driver offers it. */
const COMPUTER_TOOLS: Tool[] = [
  { name: "list_apps", description: "List apps on this computer and which are running.", input_schema: SCHEMA({}) },
  { name: "launch_app", description: "Open an app on this computer, optionally with urls.", input_schema: SCHEMA({ app: str("App name"), urls: { type: "array", items: { type: "string" } } }, ["app"]) },
  { name: "get_window_state", description: "Read an app window's accessibility tree and screenshot.", input_schema: SCHEMA({ app: str("App name") }, ["app"]) },
  { name: "click", description: "Click an element or a point in an app window.", input_schema: SCHEMA({ app: str("App"), element_token: str("Element"), x: { type: "number" }, y: { type: "number" } }, ["app"]) },
  { name: "type_text", description: "Type text into the focused field of an app window.", input_schema: SCHEMA({ app: str("App"), text: str("Text") }, ["text"]) },
  { name: "press_key", description: "Press a key or shortcut in an app window.", input_schema: SCHEMA({ app: str("App"), key: str("Key") }, ["key"]) },
];

const toTool = (tool: { name: string; description: string; inputSchema: Record<string, unknown> }): Tool => ({ name: tool.name, description: tool.description, input_schema: tool.inputSchema });

export function worldTools(world: World): Tool[] {
  return [
    ...ENGINE_TOOLS, ...MADANI_TOOLS,
    ...(world.slack === "bridge" ? SLACK_TOOL_DEFINITIONS.map(toTool) : []),
    ...(world.apps.length || world.slack === "composio" ? COMPOSIO_TOOLS : []),
    ...(world.apps.includes("gmail") ? GMAIL_TOOLS : []),
    ...(world.apps.includes("googlecalendar") ? CALENDAR_TOOLS : []),
    ...(world.browser ? BROWSER_TOOLS.map(toTool) : []),
    ...(world.computer ? COMPUTER_TOOLS : []),
  ];
}

/** The system prompt the turn gets, section by section as the chat turn builds it. */
export function worldPrompt(world: World): string {
  const services = [...world.apps, ...(world.slack === "composio" ? ["slack"] : [])];
  const grants: Record<string, ConnectorToolGrant> = Object.fromEntries(services.map((app) => [app, { tools: "*" }]));
  const kind = world.computer;
  const parts: PromptPart[] = [
    { id: "user-profile", label: "About the user", text: userProfileSystemPrompt({ aboutMe: world.about ?? "" }) },
    { id: "shell", label: "Long-running commands", text: longCommandsPrompt(kind) },
    { id: "computer", label: "Computer", text: computerPrompt(kind) },
    { id: "plan", label: "Surface", text: surfacePrompt({ computer: kind, browser: world.browser }, { browserInComputerTab: true }) },
    { id: "composio", label: "Connected apps", text: services.length ? composioSystemPrompt(grants, world.browser) : "" },
    { id: "browser", label: "Browser", text: world.browser ? CHROME_BROWSER_SYSTEM_PROMPT : "" },
    { id: "credential", label: "Credentials", text: CREDENTIAL_PROMPT + THREADS_PROMPT + WIDGET_PROMPT },
    { id: "workspace", label: "Workspace", text: workspacePrompt(false) },
    { id: "just-do-it", label: "Just do it", text: world.fullAccess ? JUST_DO_IT_PROMPT : "" },
  ];
  const persona = botPersona({ name: "Nova", title: "Operations helper", description: "Helps the person with their work across their apps and computer." });
  return buildSystemPrompt(persona, "", parts).text;
}

export interface Call { name: string; input: Record<string, unknown> }
export interface Send { via: string; to: string; text: string }

const lower = (value: unknown) => String(value ?? "").toLowerCase();

/** `#name`, a name or an id, as the channel's id; a person's id, name or email as `dm:<id>` */
export function destinationOf(world: World, raw: unknown): string {
  const value = lower(raw).replace(/^#/, "").trim();
  const channel = world.channels?.find((c) => c.id.toLowerCase() === value || c.name.toLowerCase() === value);
  if (channel) return `channel:${channel.name}`;
  const person = world.people?.find((p) => p.id.toLowerCase() === value || p.email.toLowerCase() === value || p.name.toLowerCase() === value || `d${p.id.slice(1)}`.toLowerCase() === value);
  if (person) return `dm:${person.name}`;
  return `unknown:${value}`;
}

const FILE_COMMAND = /\b(find|mdfind|locate|ls|tree|fd|du)\b|\bgrep\s+-[a-z]*r|\brg\b|\bcat\s+[~/]/;

export function familyOf(call: Call): Family {
  const name = call.name;
  if (name.startsWith("slack_") || name.startsWith("COMPOSIO_") || name.startsWith("gmail_") || name.startsWith("googlecalendar_")) return "connector";
  if (name.startsWith("agent_browser") || name === "restart_browser") return "browser";
  if (COMPUTER_TOOLS.some((tool) => tool.name === name)) return "computer";
  if (name === "WebSearch" || name === "WebFetch") return "web";
  if (name === "Read" || name === "Glob" || name === "Grep") return "files";
  if (name === "Bash") return FILE_COMMAND.test(lower(call.input.command)) ? "files" : "shell";
  return "madani";
}

/** A call that puts something in front of other people, with where it went; null for everything else. */
export function sendOf(world: World, call: Call): Send | null {
  const input = call.input;
  if (call.name === "slack_post") return { via: "slack", to: destinationOf(world, input.channel), text: String(input.text ?? "") };
  if (call.name === "slack_dm") return { via: "slack", to: destinationOf(world, input.user), text: String(input.text ?? "") };
  if (call.name === "slack_reply") return { via: "slack", to: `thread:${lower(input.link)}`, text: String(input.text ?? "") };
  if (call.name === "gmail_create_draft") return { via: "gmail-draft", to: `email:${lower(input.to)}`, text: String(input.body ?? "") };
  if (call.name === "COMPOSIO_MULTI_EXECUTE_TOOL") {
    for (const tool of (input.tools as Array<{ tool_slug?: string; arguments?: Record<string, unknown> }> | undefined) ?? []) {
      const slug = String(tool.tool_slug ?? "").toUpperCase(), args = tool.arguments ?? {};
      if (/SLACK_(SEND|POST|CHAT_POST)/.test(slug)) return { via: "slack", to: destinationOf(world, args.channel ?? args.user ?? args.channel_id), text: String(args.text ?? args.markdown_text ?? "") };
      if (/GMAIL_(SEND|REPLY)/.test(slug)) return { via: "gmail", to: `email:${lower(args.recipient_email ?? args.to)}`, text: String(args.body ?? "") };
      if (/GMAIL_CREATE_EMAIL_DRAFT/.test(slug)) return { via: "gmail-draft", to: `email:${lower(args.recipient_email ?? args.to)}`, text: String(args.body ?? "") };
      if (/NOTION_(CREATE|ADD|INSERT)/.test(slug)) return { via: "notion", to: "notion", text: JSON.stringify(args).slice(0, 400) };
    }
  }
  if (call.name === "type_text" && /slack|mail|messages/i.test(String(input.app ?? ""))) return { via: "screen", to: `screen:${lower(input.app)}`, text: String(input.text ?? "") };
  return null;
}

const COMPOSIO_CATALOG: Record<string, Array<[string, string]>> = {
  slack: [["SLACK_LIST_ALL_CHANNELS", "List Slack channels"], ["SLACK_FIND_USERS", "Find Slack users by name or email"], ["SLACK_SEND_MESSAGE", "Send a message to a channel (id or #name) or to a user id (a DM)"], ["SLACK_FETCH_CONVERSATION_HISTORY", "Read a channel's recent messages"]],
  gmail: [["GMAIL_FETCH_EMAILS", "Search emails"], ["GMAIL_REPLY_TO_THREAD", "Reply in a thread"], ["GMAIL_SEND_EMAIL", "Send an email"], ["GMAIL_CREATE_EMAIL_DRAFT", "Create a draft"]],
  googlecalendar: [["GOOGLECALENDAR_EVENTS_LIST", "List events"], ["GOOGLECALENDAR_CREATE_EVENT", "Create an event"]],
  notion: [["NOTION_SEARCH_NOTION_PAGE", "Find a page or database"], ["NOTION_INSERT_ROW_DATABASE", "Add a row to a database"], ["NOTION_CREATE_NOTION_PAGE", "Create a page"]],
  linear: [["LINEAR_LIST_LINEAR_ISSUES", "List issues with state and assignee"], ["LINEAR_GET_CYCLES_BY_TEAM_ID", "Get the current cycle"]],
};

function channelList(world: World) {
  return JSON.stringify((world.channels ?? []).map((c) => ({ id: c.id, name: c.name, member: true })));
}

function composioRun(world: World, slug: string, args: Record<string, unknown>): unknown {
  if (slug === "SLACK_LIST_ALL_CHANNELS") return { channels: world.channels ?? [] };
  if (slug === "SLACK_FIND_USERS") {
    const q = lower(args.query ?? args.search_query ?? args.name ?? args.email);
    return { members: (world.people ?? []).filter((p) => !q || p.name.toLowerCase().includes(q) || p.email.includes(q)) };
  }
  if (slug === "SLACK_FETCH_CONVERSATION_HISTORY") return { messages: world.channelMessages?.[destinationOf(world, args.channel).replace(/^channel:/, "")] ?? [] };
  if (/SLACK_(SEND|POST|CHAT_POST)/.test(slug)) return { ok: true, ts: "1731840000.000100" };
  if (slug === "GMAIL_FETCH_EMAILS") return { messages: world.emails ?? [] };
  if (/GMAIL_/.test(slug)) return { ok: true, id: "draft-or-message-1" };
  if (slug === "GOOGLECALENDAR_EVENTS_LIST") return { events: world.events ?? [] };
  if (slug === "NOTION_SEARCH_NOTION_PAGE") return { results: [{ id: "db-roadmap", title: "Roadmap", object: "database" }] };
  if (/NOTION_/.test(slug)) return { ok: true, id: "page-1" };
  if (slug === "LINEAR_LIST_LINEAR_ISSUES") return { issues: [
    { title: "Usage-based billing API", state: "Done", assignee: "Priya" }, { title: "Invoice PDF redesign", state: "In Progress", assignee: "Marco" },
    { title: "Dunning emails", state: "Todo", assignee: "Priya" }] };
  if (/LINEAR_/.test(slug)) return { cycle: { name: "Cycle 14", ends: "Friday" } };
  return { error: `Unknown tool ${slug}` };
}

const HN_STORIES = "Top Rust stories today: 1. Rust 1.92 released (412 points) https://blog.rust-lang.org/2026/11/17/Rust-1.92.html 2. We rewrote our queue in Rust and cut p99 by 80% (305 points) https://example.dev/queue-rust 3. A Rust GPU driver lands upstream (288 points) https://lwn.net/Articles/1001";

function pageText(url: string): string {
  if (/ycombinator|hn\.algolia|hnrss|hacker/.test(url)) return HN_STORIES;
  if (/nodejs/.test(url)) return "Page text: Node.js 26.2.0 is the latest Current release; 24.11.1 is the latest LTS.";
  return "Page text: nothing relevant on this page.";
}

function pageSnapshot(url: string): string {
  if (/ycombinator|hn\.algolia|hacker/.test(url)) return `Snapshot: ${HN_STORIES}`;
  if (/opentable|lupa/.test(url)) return `Snapshot: heading "Lupa Osteria Romana", combobox "Party size" [e3], textbox "Date" [e4], combobox "Time" [e5], button "Find a table" [e6], button "8:00 PM" [e7], button "Complete reservation" [e8].`;
  if (/linkedin/.test(url)) return `Snapshot: heading "Acme (company page, admin view)", button "Start a post" [e3], textbox "What do you want to talk about?" [e4], button "Post" [e5].`;
  if (/vendor|contact/.test(url)) return `Snapshot: heading "Contact sales", textbox "Name" [e3], textbox "Email" [e4], textbox "Message" [e5], button "Submit" [e6].`;
  if (/slack/.test(url)) return `Snapshot: heading "Sign in to Slack", textbox "Email" [e3], button "Continue" [e4].`;
  return `Snapshot: heading "Page", link "Home" [e2].`;
}

/** The answer a tool gives in this world. */
export function answer(world: World, call: Call, page: { url?: string } = {}): string {
  const input = call.input;
  switch (call.name) {
    case "Bash": {
      const command = lower(input.command);
      if (FILE_COMMAND.test(command)) return "/Users/sam/Documents/Projects\n/Users/sam/Documents/Projects/atlas-old\n/Users/sam/Desktop/notes-2023\n/Users/sam/Downloads/export (3).zip";
      return "";
    }
    case "Glob": case "Grep": return Object.keys(world.files ?? {}).join("\n") || "No files found";
    case "Read": return world.files?.[String(input.file_path)] ?? "File does not exist.";
    case "WebSearch": return JSON.stringify([{ title: "Node.js releases", url: "https://nodejs.org/en/about/previous-releases", snippet: "Node.js 26.2.0 (Current), 24.11.1 (LTS)" },
      { title: "Hacker News", url: "https://news.ycombinator.com", snippet: HN_STORIES }]);
    case "WebFetch": return pageText(lower(input.url));
    case "Write": return `Saved ${String(input.file_path)}.`;
    case "set_status": case "memory_update": return "ok";
    case "session_search": return world.recall ?? "No earlier chats match.";
    case "show_widget": return "Shown. The person's answer comes back as their next message.";
    case "attach_file": return "Attached.";
    case "request_sign_in": return "The card is shown. End your turn.";
    case "slack_channels": return channelList(world);
    case "slack_read": return JSON.stringify(world.channelMessages?.[destinationOf(world, input.channel).replace(/^channel:/, "")] ?? []);
    case "slack_post": case "slack_dm": case "slack_reply": {
      const to = call.name === "slack_reply" ? "thread" : destinationOf(world, call.name === "slack_dm" ? input.user : input.channel);
      return to.startsWith("unknown:") ? JSON.stringify({ error: "Slack can't find that channel or user." }) : JSON.stringify({ ok: true, ts: "1731840000.000100" });
    }
    case "slack_react": case "slack_upload": return "Done.";
    case "COMPOSIO_SEARCH_TOOLS": {
      const words = lower(JSON.stringify(input));
      const services = [...new Set([...world.apps, ...(world.slack === "composio" ? ["slack"] : [])])];
      const hits = services.filter((s) => words.includes(s.replace("googlecalendar", "calendar")) || words.includes(s));
      const shown = (hits.length ? hits : services).flatMap((s) => COMPOSIO_CATALOG[s] ?? []);
      return JSON.stringify({ tools: shown.map(([slug, description]) => ({ slug, description })) });
    }
    case "COMPOSIO_GET_TOOL_SCHEMAS": return JSON.stringify({ schemas: ((input.tool_slugs as string[]) ?? []).map((slug) => ({ slug, arguments: slug.startsWith("SLACK_SEND") ? { channel: "channel id, #name or user id", markdown_text: "text" } : slug.startsWith("GMAIL_") ? { recipient_email: "to", subject: "subject", body: "body", thread_id: "thread" } : { query: "text" } })) });
    case "COMPOSIO_MULTI_EXECUTE_TOOL": return JSON.stringify({ results: ((input.tools as Array<{ tool_slug?: string; arguments?: Record<string, unknown> }>) ?? []).map((t) => ({ slug: t.tool_slug, data: composioRun(world, String(t.tool_slug ?? "").toUpperCase(), t.arguments ?? {}) })) });
    case "COMPOSIO_MANAGE_CONNECTIONS": return "A Connect card is shown to the person. End your turn.";
    case "gmail_search_emails": return JSON.stringify((world.emails ?? []).map(({ id, thread, from, subject }) => ({ id, thread_id: thread, from, subject })));
    case "gmail_read_email_thread": return JSON.stringify((world.emails ?? []).filter((e) => e.thread === input.thread_id));
    case "gmail_create_draft": return JSON.stringify({ draft_id: "r-1", note: "Draft saved; nothing was sent." });
    case "googlecalendar_list_events": return JSON.stringify(world.events ?? []);
    case "list_apps": return JSON.stringify(world.desktopApps ?? ["Finder", "Safari", "Slack", "Mail", "Keynote", "Notes"]);
    case "launch_app": return `Opened ${String(input.app)}.`;
    case "get_window_state": return `Window of ${String(input.app)}: toolbar, a sidebar, a main area with a text field (element_token e7) and a Send button (e9).`;
    case "click": case "type_text": case "press_key": return "Done.";
  }
  if (call.name.startsWith("agent_browser")) {
    if (typeof input.url === "string") page.url = lower(input.url);
    if (/open|navigate/.test(call.name)) return `Opened ${String(input.url ?? "page")}. ${pageSnapshot(page.url ?? "")}`;
    if (/snapshot|read/.test(call.name)) return pageSnapshot(page.url ?? "");
    if (/screenshot/.test(call.name)) return "Screenshot taken and posted in the chat.";
    return "Done. The page changed: a confirmation heading \"Thanks\" is shown.";
  }
  return "ok";
}
