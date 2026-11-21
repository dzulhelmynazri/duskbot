export const PRODUCTION_ORIGIN = "https://madani.bot";
export const PREVIEW_ORIGIN = "https://preview.madani.bot";
const KEY = "madani.mobile.environment";

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;
const storage = (): Store | null => { try { return globalThis.localStorage ?? null; } catch { return null; } };

/** The account service a store build signs in to: madani.bot, or the preview stack when someone testing chose it. */
export function chosenAccountOrigin(store: Store | null = storage()): string {
  return store?.getItem(KEY) === "preview" ? PREVIEW_ORIGIN : PRODUCTION_ORIGIN;
}

export function chooseAccountOrigin(origin: string, store: Store | null = storage()): void {
  if (origin === PREVIEW_ORIGIN) store?.setItem(KEY, "preview");
  else store?.removeItem(KEY);
}

/** A short name for any account service but madani.bot itself, so a phone on another stack always says so. */
export function environmentName(origin: string): string | null {
  if (origin === PRODUCTION_ORIGIN) return null;
  if (origin === PREVIEW_ORIGIN) return "Preview";
  try { return new URL(origin).host; } catch { return origin; }
}

const PENDING_SIGN_IN = "madani.mobile.pending-sign-in";
const SERVICE_ORIGINS = { production: PRODUCTION_ORIGIN, preview: PREVIEW_ORIGIN } as const;

/** The account service a desktop's sign-in link was made on, when it is not the one this phone signs in to (its code means
 * nothing to the other one); null to go on here. */
export function signInServiceSwitch(service: keyof typeof SERVICE_ORIGINS | undefined, current: string): string | null {
  const wanted = service ? SERVICE_ORIGINS[service] : undefined;
  return wanted && wanted !== current ? wanted : null;
}

/** Moves the phone to that service and keeps the link, so the app opens on it again once it has reloaded there. */
export function holdSignInForService(origin: string, link: string, store: Store | null = storage()): void {
  chooseAccountOrigin(origin, store);
  store?.setItem(PENDING_SIGN_IN, link);
}

/** The sign-in link kept across that reload, once. */
export function takeHeldSignIn(store: Store | null = storage()): string | null {
  const link = store?.getItem(PENDING_SIGN_IN) ?? null;
  store?.removeItem(PENDING_SIGN_IN);
  return link;
}

/** A sign-in link made on the other service moves the phone there (as the person scanning it asked) and reopens the link
 * once the app has reloaded on it. False when the link belongs here. */
export function followSignInService(link: string, service: keyof typeof SERVICE_ORIGINS | undefined,
  account: { origin: string; signOut(): Promise<void> } | null, reload: () => void = () => window.location.reload()): boolean {
  const elsewhere = account ? signInServiceSwitch(service, account.origin) : null;
  if (!elsewhere || !account) return false;
  holdSignInForService(elsewhere, link);
  void account.signOut().catch(() => {}).finally(reload);
  return true;
}
