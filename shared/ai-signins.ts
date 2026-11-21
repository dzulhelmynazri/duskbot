// The wire shape of the AI sign-ins the first run on madani cloud carries from the person's computer to their own Cloud,
// through the Admin's sealed hold and the signed home channel. Only CLI logins kept in a plain file move; a login in the
// OS keychain (Claude Code, Cursor, Copilot on a Mac) stays on its computer.
//
// Security invariant: never log an item, its `auth` or a body that carries one.

/** Each kind is one CLI's login file: Codex `auth.json`, Grok `auth.json`, Gemini CLI `oauth_creds.json` and Kimi Code's
 * token file under `credentials/` (`file` names it). */
export const AI_SIGNIN_KINDS = ["codex-auth", "grok-auth", "gemini-oauth", "kimi-auth"] as const;
export type AiSignInKind = (typeof AI_SIGNIN_KINDS)[number];
export type AiSignIn = { kind: AiSignInKind; auth: string; file?: string };

/** The engines (driver kinds) each sign-in signs in. */
export const AI_SIGNIN_DRIVERS: Readonly<Record<AiSignInKind, readonly string[]>> = {
  "codex-auth": ["codex"],
  "grok-auth": ["grokAgent"],
  "gemini-oauth": ["geminiAgent"],
  "kimi-auth": ["kimiAgent"],
};

export const MAX_AI_SIGNIN_BYTES = 32 * 1024;
const MAX_TOTAL_BYTES = 64 * 1024;
export const KIMI_TOKEN_FILE = /^kimi-code(?:-env-[0-9a-f]{1,64})?\.json$/;

/** The sign-ins `value` lists, at most one of each kind, or null for anything else. */
export function parseAiSignInList(value: unknown): AiSignIn[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > AI_SIGNIN_KINDS.length) return null;
  const out: AiSignIn[] = [];
  let total = 0;
  for (const item of value) {
    const { kind, auth, file } = (item && typeof item === "object" ? item : {}) as { kind?: unknown; auth?: unknown; file?: unknown };
    if (!AI_SIGNIN_KINDS.includes(kind as AiSignInKind) || out.some((one) => one.kind === kind)) return null;
    if (typeof auth !== "string" || !auth) return null;
    const bytes = Buffer.byteLength(auth);
    total += bytes;
    if (bytes > MAX_AI_SIGNIN_BYTES || total > MAX_TOTAL_BYTES) return null;
    try {
      const parsed = JSON.parse(auth) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    } catch { return null; }
    if (kind === "kimi-auth") {
      if (typeof file !== "string" || !KIMI_TOKEN_FILE.test(file)) return null;
      out.push({ kind, auth, file });
    } else {
      if (file !== undefined) return null;
      out.push({ kind: kind as AiSignInKind, auth });
    }
  }
  return out;
}
