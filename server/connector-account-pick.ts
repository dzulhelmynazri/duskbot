// Composio sessions run with multi_account.require_explicit_selection, so a call must name its account
// (docs.composio.dev, "managing multiple connected accounts"); the connector proxy names the bot's pick on every call
// that leaves it out. No imports beyond zod: the proxy is its own small process.
import { z } from "zod";

export const CONNECTOR_ACCOUNTS_ENV = "MADANI_CONNECTOR_ACCOUNTS";
export const ACCOUNT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
// Composio puts an underscore before a slug that would start with a digit: 1Password is `_1password` and its tools are
// `_1PASSWORD_GET_ITEM` and so on (docs.composio.dev/toolkits/_1password).
export const picks = z.record(z.string().regex(/^[a-z0-9_][a-z0-9_-]{0,80}$/), z.string().regex(ACCOUNT_ID));

/** The toolkit a Composio tool slug belongs to, among the apps with a pick: GMAIL_SEND_EMAIL is gmail's. */
function toolkitOf(toolSlug: string, slugs: readonly string[]): string | undefined {
  const upper = toolSlug.toUpperCase();
  return slugs
    .filter((slug) => upper.startsWith(`${slug.toUpperCase().replace(/-/g, "_")}_`))
    .sort((a, b) => b.length - a.length)[0];
}

/** A call's arguments with the bot's account on every app call that names none. Only Composio's multi-execute tool
 * carries an account per call (`tools[].account`); anything else comes back unchanged. */
export function withChosenAccounts(toolName: string, args: unknown, chosen: Record<string, string>): unknown {
  const slugs = Object.keys(chosen);
  if (!slugs.length || !/MULTI_EXECUTE_TOOL$/i.test(toolName)) return args;
  if (!args || typeof args !== "object" || Array.isArray(args)) return args;
  const tools = (args as { tools?: unknown }).tools;
  if (!Array.isArray(tools)) return args;
  let changed = false;
  const next = tools.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return item;
    const row = item as Record<string, unknown>;
    if (typeof row.account === "string" && row.account.trim()) return item;
    const slug = typeof row.tool_slug === "string" ? toolkitOf(row.tool_slug, slugs) : undefined;
    if (!slug) return item;
    changed = true;
    return { ...row, account: chosen[slug] };
  });
  return changed ? { ...(args as Record<string, unknown>), tools: next } : args;
}

export function parseConnectorAccountsEnv(value: string | undefined): Record<string, string> {
  if (!value) return {};
  try {
    const parsed = picks.safeParse(JSON.parse(value));
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}

