// The Mac tools the device server lists beside the phone's: small flat inputs validated against their advertised schema.
import type { ValidateFunction } from "ajv";

import { CLOUD_MAC_TOOL_NAMES } from "../../shared/cloud-mac.ts";
import { MAC_TOOL_NAMES, type MacToolName } from "../../shared/mac-control.ts";
import { compileToolSchema, schemaProblems } from "../mcp-schema-validator.ts";

export const MAC_EXEC_DEFAULT_SECONDS = 120;
export const MAC_EXEC_MAX_SECONDS = 600;
export const MAC_WRITE_MAX_CHARS = 1_000_000;

const PATH = (description: string) => ({ type: "string", minLength: 1, maxLength: 2048, description });

interface MacTool {
  name: MacToolName;
  description: string;
  inputSchema: { type: "object"; properties: Record<string, unknown>; required: string[]; additionalProperties: false };
}

const tool = (name: MacToolName, description: string, properties: Record<string, unknown>, required: string[] = []): MacTool =>
  ({ name, description, inputSchema: { type: "object", properties, required, additionalProperties: false } });

const tools: MacTool[] = [
  tool("mac_exec", "Run a shell command (zsh, login shell) on the person's Mac, in their home folder unless cwd is given. Returns the exit code and the output (stdout and stderr together, the last 200 KB). Use it for terminal work, CLIs such as git, brew or claude, and anything else the Mac can run.", {
    command: { type: "string", minLength: 1, maxLength: 20_000, description: "The command line." },
    cwd: PATH("Folder to run in; ~ and relative paths start at the home folder."),
    timeoutSeconds: { type: "integer", minimum: 1, maximum: MAC_EXEC_MAX_SECONDS, description: `Stop it after this long; default ${MAC_EXEC_DEFAULT_SECONDS}.` },
  }, ["command"]),
  tool("mac_read_file", "Read a text file on the Mac. Returns up to maxBytes (default and most 256 KB) from offset.", {
    path: PATH("File path; ~ and relative paths start at the home folder."),
    offset: { type: "integer", minimum: 0, description: "Byte to start at; default 0." },
    maxBytes: { type: "integer", minimum: 1, maximum: 262_144, description: "Bytes to read; default 262144." },
  }, ["path"]),
  tool("mac_write_file", "Write a file on the Mac, making its folders. Replaces the file unless append is true.", {
    path: PATH("File path; ~ and relative paths start at the home folder."),
    content: { type: "string", maxLength: MAC_WRITE_MAX_CHARS, description: "The text, or base64 bytes when encoding is base64." },
    encoding: { type: "string", enum: ["utf8", "base64"], description: "Default utf8." },
    append: { type: "boolean", description: "Add to the end instead of replacing." },
  }, ["path", "content"]),
  tool("mac_list", "List a folder on the Mac: names, kinds, sizes and change times, up to 500 entries.", {
    path: PATH("Folder path; default the home folder."),
    hidden: { type: "boolean", description: "Include names starting with a dot." },
  }),
  tool("mac_open", "Open something on the Mac as a double click would: a file or folder, a link (https, mailto, ...), or an app by name. Give app to open the target with that app.", {
    target: { type: "string", minLength: 1, maxLength: 4096, description: "A path, a URL, or an app name when app is not given and nothing else matches." },
    app: { type: "string", minLength: 1, maxLength: 200, description: "App to open it with, e.g. Safari or Visual Studio Code." },
  }, ["target"]),
  tool("mac_save_from_cloud", "Copy a file from your side onto the Mac: from your own files and this chat's attachments (from: files, the default) or from your cloud computer's home folder (from: computer). Saves into ~/Downloads/<your name>/ unless to is given.", {
    source: PATH("The file: a path in your files or an attachment's path, or a path on your cloud computer (relative to its home)."),
    from: { type: "string", enum: ["files", "computer"], description: "Where the file is; default files." },
    to: PATH("Where on the Mac: a folder (ending in /) or a file path. Default ~/Downloads/<your name>/."),
  }, ["source"]),
  tool("mac_screenshot", "Take a screenshot of the Mac's main screen.", {}),
  tool("mac_download", "Download a file from a link straight onto the Mac. Saves into ~/Downloads unless to is given; never replaces a file.", {
    url: { type: "string", minLength: 8, maxLength: 4096, pattern: "^https?://", description: "The https (or http) link." },
    to: PATH("Where on the Mac: a folder (ending in /) or a file path; ~ starts at the home folder. Default ~/Downloads/."),
  }, ["url"]),
];


/** Catalog in MAC_TOOL_NAMES order. */
export const MAC_TOOLS: ReadonlyArray<MacTool> = MAC_TOOL_NAMES.map((name) => tools.find((entry) => entry.name === name)!);
/** A madani cloud's catalog, in CLOUD_MAC_TOOL_NAMES order. */
export const CLOUD_MAC_TOOLS: ReadonlyArray<MacTool> = CLOUD_MAC_TOOL_NAMES.map((name) => tools.find((entry) => entry.name === name)!);

let validators: Map<string, ValidateFunction> | undefined;

export function macToolCallProblem(name: unknown, args: unknown, offered: ReadonlyArray<MacTool> = MAC_TOOLS): string | null {
  validators ??= new Map(tools.map((entry) => [entry.name, compileToolSchema(entry.inputSchema as Record<string, unknown>, { allErrors: true })]));
  const validate = typeof name === "string" && offered.some((entry) => entry.name === name) ? validators.get(name) : undefined;
  if (!validate) return `Unknown Mac tool. Use one of ${offered.map((entry) => entry.name).join(", ")}.`;
  if (!args || typeof args !== "object" || Array.isArray(args) || !validate(args)) {
    return `Tool arguments do not match the advertised input schema: ${schemaProblems(validate.errors).join("; ") || "use its required fields and types"}.`;
  }
  return null;
}

/** How long the server waits for the Mac's answer: the command's own limit plus a margin for the round trip. */
export function macJobTimeoutMs(name: MacToolName, args: Record<string, unknown>): number {
  if (name === "mac_exec") {
    const seconds = typeof args.timeoutSeconds === "number" ? args.timeoutSeconds : MAC_EXEC_DEFAULT_SECONDS;
    return (seconds + 30) * 1000;
  }
  return name === "mac_save_from_cloud" || name === "mac_download" ? 10 * 60_000 : 60_000;
}

export interface MacToolResult {
  content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>;
  isError?: boolean;
}

export const macErrorResult = (text: string): MacToolResult => ({ content: [{ type: "text", text }], isError: true });
