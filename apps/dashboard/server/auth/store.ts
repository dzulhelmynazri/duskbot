import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createJsonStore } from "../billing/json-store.ts";
import { randomBytes } from "node:crypto";
import type { AccountIntent, NotificationPrefs, OAuthProvider, SessionView, WebsiteHome } from "../../../../shared/account-api.ts";

/** `notifications`: only what the owner changed (NOTIFICATION_DEFAULTS fill the rest); `onboardedAt`: first-run steps done;
 *  `avatarUrl`: the photo of the newest google sign-in that had one; `avatar`: the person's choice of avatar
 *  (shared/user-avatar.ts), absent for the default */
export interface Account { id: string; email: string; name: string | null; avatarUrl?: string; avatar?: string; createdAt: number; notifications?: Partial<NotificationPrefs>; onboardedAt?: number;
  /** where the website's first steps put the bots: "free" (this computer) or "cloud" (a plan picked, checkout opened) */
  onboardedHome?: WebsiteHome;
  /** the app install whose sign-in made this account (its hand-back: the desktop sign-in code it opened the website with) */
  signedUpFrom?: { name: string; platform: string; appVersion: string | null; at: number };
  /** a limited admin role the owner grants from the panel; full admins come only from MADANI_ADMIN_EMAILS. never set by the account itself */
  adminRole?: AdminRole }
export const ADMIN_ROLES = ["growth"] as const;
export type AdminRole = typeof ADMIN_ROLES[number];
/** `revoke`: Apple's newest refresh token per client id (json), sealed with the auth secret, for the revoke on deletion;
 *  never sent to a client */
export interface Identity { accountId: string; provider: OAuthProvider; subject: string; email: string | null; label: string | null; addedAt: number; revoke?: string }
/** `parentId`: the app session a handoff web session came from; it ends with that session. never sent to a client. */
export interface Session extends Omit<SessionView, "current"> { accountId: string; tokenHash: string; parentId?: string }
/** a sign-in code in flight: only its hmac, kept so a restart between sending a code and typing it does not kill it */
export interface StoredCode { id: string; email: string; codeHash: string; pending?: string; device: { name: string; platform: string; appVersion: string | null } | null; expiresAt: number; tries: number }
/** a desktop sign-in waiting for its approval, keyed by the device code's hash, kept so a restart between the app opening the
 *  approve page and the person approving it does not end it */
export interface StoredDevice { id: string; userCode: string; device: { name: string; platform: string; appVersion: string | null }; expiresAt: number; interval: number; lastPollAt: number | null; accountId: string | null; denied: boolean; intent?: AccountIntent; createdAt?: number }
/** a phone sign-in code a desktop session made: only its hmac. kept past its end (and once used) for a while, so the phone
 *  can say expired or used rather than wrong */
export interface StoredPhoneCode { codeHash: string; accountId: string; sessionId: string; expiresAt: number; purgeAt: number; usedAt?: number }
interface AuthState { accounts: Account[]; identities: Identity[]; sessions: Session[]; codes?: StoredCode[]; devices?: StoredDevice[]; phoneCodes?: StoredPhoneCode[] }

export function createAuthStore(dataDir: string) {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const store = createJsonStore<AuthState>(join(dataDir, "auth.json"), () => ({ accounts: [], identities: [], sessions: [] }),
    (value): value is AuthState => !!value && typeof value === "object" && Array.isArray((value as AuthState).accounts)
      && Array.isArray((value as AuthState).identities) && Array.isArray((value as AuthState).sessions));
  let secret = process.env.MADANI_AUTH_SECRET;
  if (secret !== undefined && secret.length < 32) throw new Error("MADANI_AUTH_SECRET must contain at least 32 characters.");
  if (secret === undefined) {
    const secretPath = `${dataDir}/auth-secret`;
    try { secret = readFileSync(secretPath, "utf8"); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      secret = randomBytes(32).toString("base64url");
      writeFileSync(secretPath, secret, { mode: 0o600, flag: "wx" });
    }
    if (secret.length < 32) throw new Error("Invalid auth secret file.");
    chmodSync(secretPath, 0o600);
  }
  return { state: store.state, secret, changed: store.changed, close: store.commit };
}
