import { isTestAccount } from "../auth/mail.ts";

/** reserved example and test domains (RFC 2606, RFC 6761): nobody real signs up there */
const RESERVED = /@(?:[^@]+\.)?example\.(?:com|net|org)$|\.(?:test|example|invalid|localhost)$/;

/** an account the admin leaves out of its people, signups and money by default: a harness's (isTestAccount: @qa.madani.test,
 *  qa*@madani.bot, the e2e inboxes), a reserved domain's, or App Review's demo account. nothing about the account changes */
export function isAdminTestAccount(email: unknown, reviewEmail: string | null = null): boolean {
  if (typeof email !== "string") return false;
  const address = email.trim().toLowerCase();
  return isTestAccount(address) || RESERVED.test(address) || (!!reviewEmail && address === reviewEmail.trim().toLowerCase());
}

/** the ids of the test accounts among these */
export function testAccountIds(accounts: ReadonlyArray<{ id: string; email: string }>, reviewEmail: string | null = null): Set<string> {
  return new Set(accounts.filter(account => isAdminTestAccount(account.email, reviewEmail)).map(account => account.id));
}

type DirectoryLike = { readonly accounts: ReadonlyArray<{ id: string }>; readonly identities: ReadonlyArray<{ accountId: string }>; readonly sessions: ReadonlyArray<{ accountId: string }> };
/** the directory without these accounts, their sign-ins and their sessions */
export function withoutAccounts<D extends DirectoryLike>(directory: D, hidden: ReadonlySet<string>): D {
  if (!hidden.size) return directory;
  return { ...directory, accounts: directory.accounts.filter(row => !hidden.has(row.id)), identities: directory.identities.filter(row => !hidden.has(row.accountId)),
    sessions: directory.sessions.filter(row => !hidden.has(row.accountId)) };
}

/** billing records without these accounts' rows: every list keyed by accountId (or ownerAccountId), and the refunds of
 *  their payments. a read-only copy; the store is never touched */
export function withoutBilling<T extends object>(state: T, hidden: ReadonlySet<string>): T {
  if (!hidden.size) return state;
  const owner = (row: unknown) => {
    const record = row as { accountId?: unknown; ownerAccountId?: unknown };
    return typeof record.accountId === "string" ? record.accountId : typeof record.ownerAccountId === "string" ? record.ownerAccountId : null;
  };
  const out = { ...state } as Record<string, unknown>;
  for (const [key, value] of Object.entries(state)) if (Array.isArray(value)) out[key] = value.filter(row => { const id = owner(row); return id === null || !hidden.has(id); });
  const invoices = (state as { invoices?: Array<{ accountId: string; providerPaymentId: string }> }).invoices ?? [];
  const gone = new Set(invoices.filter(row => hidden.has(row.accountId)).map(row => row.providerPaymentId));
  if (gone.size && Array.isArray(out.refunds)) out.refunds = (out.refunds as Array<{ paymentId: string }>).filter(row => !gone.has(row.paymentId));
  return out as T;
}

/** a harness's app install or workspace (the QA runs report as app:qatest_*), never a person's */
export const TEST_INSTALL = /^(?:app:)?(?:qatest|qa|smoke|e2e)[_-]/i;
export const isTestInstall = (id: unknown) => typeof id === "string" && TEST_INSTALL.test(id);
/** a build nobody downloads: 0.0.0 is the unreleased version, with or without a -test or -e2e tag */
export const DEV_BUILD = /^0\.0\.0(?:$|[-+])/;
export const isDevBuild = (version: unknown) => typeof version === "string" && DEV_BUILD.test(version);

/** an analytics event a test made: a hidden account's, a harness install's, or a dev build's */
export function isTestEvent(event: { accountId: string | null; ctx?: { install?: string; app?: { version?: string | null } | null } }, hidden: ReadonlySet<string>): boolean {
  return (!!event.accountId && hidden.has(event.accountId)) || isTestInstall(event.ctx?.install) || isDevBuild(event.ctx?.app?.version);
}

/** test accounts that are gone from the directory but still own billing records: their checkout carries the email they used */
export function testBuyerIds(checkouts: ReadonlyArray<{ accountId: string; email?: string | null }>, reviewEmail: string | null = null): Set<string> {
  return new Set(checkouts.filter(row => isAdminTestAccount(row.email, reviewEmail)).map(row => row.accountId));
}
