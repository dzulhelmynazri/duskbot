import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { MascotLoader } from "@/components/MascotLoader";
import type { SignInVerify } from "@/components/account-gate/bridge";
import { problemLine } from "@/components/cloud-buy/SignInScreen";
import { t } from "@/lib/i18n";
import type { CloudSignInStart } from "../../../electron/cloud-account.mjs";
import type { OAuthProvider } from "../../../shared/account-api";
import { usePlatform, type MobilePlatform } from "../platform";
import { createMobileAccount, isAccountAuthUrl, keptSignInOrigin, type AppleProblem, type AccountPlaces, type AuthResult, type CloudPairResult, type ComputerPairResult, type MobileAccount, type MobileComputer, type MobileCloud, type MobileTeamCloud, type PhoneCodeResult } from "./account-client";
import { setTurnSource } from "../transport/direct-rtc";
import { chooseAccountOrigin, chosenAccountOrigin, PREVIEW_ORIGIN, PRODUCTION_ORIGIN } from "./environment";
import { claimFreshInstall } from "./install";
import { signOutPhone } from "./sign-out";

type AccountContextValue = { account: MobileAccount | null; origin: string;
  /** every account signed in on the phone, the one in use first */
  accounts: MobileAccount[];
  /** counts the sign-ins made since launch, so a sign-in screen opened while signed in knows when its own one landed */
  signIns: number;
  /** this app keeps a madani account (the native app, or the preview's ?account=1) */
  offered: boolean;
  /** another account signed in on the phone becomes the one in use; false when it is not signed in here */
  switchAccount(id: string): Promise<boolean>;
  /** the account only, for a sign-in screen moving to another service */
  signOut(): Promise<void>;
  /** Settings' Sign out: the account in use and its madani clouds leave the phone, which opens again on what is left */
  signOutOfPhone(): Promise<void>;
  /** Every account and every madani cloud leave the phone, for a move to another account service. */
  signOutEverywhere(): Promise<void>;
  /** deletes the account from the app; false when it could not be done (nothing changed) */
  deleteAccount(): Promise<boolean>; enrollGrant(): Promise<{ enrollToken: string; dashboardUrl: string } | null>;
  clouds(): Promise<MobileCloud[] | null>; pairCloud(cloud: MobileCloud, accountId?: string): Promise<CloudPairResult>; wakeCloud(accountId?: string): Promise<boolean>;
  /** `accountId`: another account signed in on the phone; the one in use without it */
  places(accountId?: string): Promise<AccountPlaces | null>; pairTeamCloud(cloud: MobileTeamCloud, accountId?: string): Promise<CloudPairResult>;
  pairComputer(computer: MobileComputer, accountId?: string): Promise<ComputerPairResult>;
  /** what the sign-in screen asks of the account service */
  signIn: {
    providers(): Promise<OAuthProvider[]>; emailStart(email: string): Promise<CloudSignInStart>; emailVerify(code: string): Promise<SignInVerify>;
    cancelEmail(): void; browser(provider: OAuthProvider): Promise<void>;
    /** a code from a signed-in desktop's settings › phone: logs this phone in to that account, no email step */
    phoneCode(code: string): Promise<PhoneCodeResult>;
    /** a sign-in that came back through madanibot://auth and did not finish */
    problem?: string; signedIn(): void;
  } };
const AccountContext = createContext<AccountContextValue | null>(null);
export const useMobileAccount = () => useContext(AccountContext);

export function mobileAccountOrigin(native: boolean, params: URLSearchParams): string {
  const configured = import.meta.env.VITE_MADANI_ACCOUNT_ORIGIN;
  if (configured) return configured;
  const value = !native && params.get("accountOrigin");
  if (value) {
    try {
      const url = new URL(value);
      if (url.origin === value && !url.username && !url.password && (url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) return value;
    } catch {}
  }
  return chosenAccountOrigin();
}

/** The sign-in buttons a phone shows, of those the account service says work. App Store guideline 4.8: an iPhone app
 * that offers another company's sign-in offers Sign in with Apple too, so without Apple the iPhone app offers none of
 * them (the email code stays). Apple leads where it is offered. */
export function providersFor(kind: MobilePlatform["kind"], enabled: readonly OAuthProvider[]): OAuthProvider[] {
  if (kind !== "ios") return [...enabled];
  return enabled.includes("apple") ? ["apple", ...enabled.filter((provider) => provider !== "apple")] : [];
}

export function appleProblemLine(problem: AppleProblem): string {
  switch (problem) {
    case "unavailable": return t("mobile.apple.unavailable");
    case "signup-closed": return t("mobile.apple.signupClosed");
    case "taken": return t("mobile.apple.taken");
    case "rate-limited": return t("mobile.apple.rateLimited");
    case "offline": return t("mobile.apple.offline");
    case "failed": return t("mobile.apple.failed");
  }
}

function authProblem(result: AuthResult): string | undefined {
  if (!result || result.outcome === "signed-in") return;
  switch (result.outcome) {
    case "oauth_denied": return t("accountGate.oauthDenied");
    case "oauth_failed": return t("accountGate.oauthFailed");
    case "oauth_expired": case "invalid-state": return t("accountGate.oauthExpired");
    case "provider_unavailable": return t("accountGate.providerUnavailable");
    case "signup_closed": return t("cloudBuy.signIn.signupClosed");
    case "identity_taken": return t("accountGate.identityTaken");
    default: return problemLine(result.outcome, result.outcome === "wrong-code" ? result.triesLeft : null);
  }
}

export function AccountGate({ children }: { children: ReactNode }) {
  const platform = usePlatform();
  const params = new URLSearchParams(location.search);
  const wanted = platform.native ? import.meta.env.VITE_MADANI_ALLOW_SIGNED_OUT !== "1" : params.get("account") === "1";
  // a sign-in kept from the other service (production or the preview stack) is followed there, never left unread
  const [, setFollowed] = useState<string | null>(null);
  const origin = mobileAccountOrigin(platform.native, params);
  const follows = platform.native && !import.meta.env.VITE_MADANI_ACCOUNT_ORIGIN;
  const client = useMemo(() => createMobileAccount({ platform, origin }), [platform, origin]);
  const [account, setAccount] = useState<MobileAccount | null>(null);
  const [signIns, setSignIns] = useState(0);
  // the phone's direct link to its server asks this account for TURN; signed out it uses STUN only
  useEffect(() => { setTurnSource(() => client.screenIce()); return () => setTurnSource(null); }, [client]);
  const [restoring, setRestoring] = useState(wanted);
  const [problem, setProblem] = useState<string>();
  const pendingAuth = useRef<Promise<AuthResult> | null>(null);
  useEffect(() => {
    let active = true;
    let revision = 0;
    const stamp = revision;
    const follow = (task: Promise<AuthResult>) => {
      void task.then(result => {
        if (active) { setAccount(client.account()); if (result && result.outcome === "signed-in") setSignIns((count) => count + 1); setProblem(authProblem(result)); setRestoring(false); }
      }).catch(() => { if (active) { setProblem(t("cloudBuy.signIn.failed")); setRestoring(false); } }).finally(() => {
        if (active && pendingAuth.current === task) pendingAuth.current = null;
      });
    };
    if (pendingAuth.current) { ++revision; follow(pendingAuth.current); }
    const stop = platform.onAppUrl?.(url => {
      if (!isAccountAuthUrl(url)) return false;
      // the browser sheet the sign-in ran in would otherwise stay up over the app on the page it ended at
      platform.closeBrowser?.();
      ++revision;
      const task = client.handleAuthUrl(url);
      pendingAuth.current = task;
      follow(task);
      return true;
    });
    // the Keychain's sign-in shows at once and the service's check runs behind it, where only a gone session signs out;
    // a new install waits for the check, so a sign-in left from before the app was deleted shows only while it works
    if (wanted && !pendingAuth.current) void (async () => {
      const kept = follows ? await keptSignInOrigin(platform) : null;
      if (kept && kept !== origin && (kept === PRODUCTION_ORIGIN || kept === PREVIEW_ORIGIN)) {
        chooseAccountOrigin(kept);
        if (active) setFollowed(kept);
        return;
      }
      const fresh = await claimFreshInstall(platform);
      if (!fresh) {
        const value = await client.cached();
        if (active && stamp === revision && value) { setAccount(value); setRestoring(false); }
      }
      const value = await client.restore();
      if (active && stamp === revision) setAccount(value);
      if (active) setRestoring(false);
    })().catch(() => { if (active) setRestoring(false); });
    else if (!pendingAuth.current) setRestoring(false);
    // signed out or deleted somewhere else (the website, another device): the app finds out when it comes back
    const stopResume = wanted ? platform.onResume?.(() => {
      if (pendingAuth.current || !client.account()) return;
      const resumed = revision;
      void client.restore().then(value => { if (active && resumed === revision) setAccount(value); }).catch(() => {});
    }) : undefined;
    return () => { active = false; stop?.(); stopResume?.(); };
  }, [client, platform, wanted, origin, follows]);
  const context = useMemo<AccountContextValue>(() => {
    const signedIn = () => { setAccount(client.account()); setSignIns((count) => count + 1); };
    /** whose clouds leave with the account in use: its own and the ones it lists, the rest only when no account stays */
    const leaving = async () => {
      const id = client.account()?.id ?? null;
      const listed = await client.places().catch(() => null);
      const origins = listed ? [...listed.clouds, ...listed.teams].flatMap((cloud) => (cloud.origin ? [cloud.origin] : [])) : [];
      return { account: id, othersStay: client.accounts().length > 1, listed: origins };
    };
    return { account, origin, offered: wanted, accounts: account ? client.accounts() : [], signIns,
      switchAccount: async (id) => {
        const next = await client.switchAccount(id);
        setAccount(client.account()); setProblem(undefined);
        return Boolean(next);
      },
      signOut: async () => { setAccount(null); setProblem(undefined); await client.signOut(); setAccount(client.account()); },
      signOutOfPhone: async () => {
        await signOutPhone({ platform, signOutAccount: () => client.signOut(), signedOut: await leaving() });
        window.location.reload();
      },
      signOutEverywhere: async () => {
        await signOutPhone({ platform, signOutAccount: () => client.signOutAll() });
        window.location.reload();
      },
      deleteAccount: async () => {
        const signedOut = await leaving();
        const outcome = await client.deleteAccount();
        if (outcome === "failed") return false;
        await signOutPhone({ platform, signOutAccount: async () => {}, signedOut });
        setAccount(client.account()); setProblem(undefined);
        return true;
      },
      enrollGrant: () => client.enrollGrant(),
      clouds: () => client.clouds(), pairCloud: (cloud, id) => client.pairCloud(cloud, id), wakeCloud: id => client.wakeCloud(id),
      places: id => client.places(id), pairTeamCloud: (cloud, id) => client.pairTeamCloud(cloud, id), pairComputer: (computer, id) => client.pairComputer(computer, id),
      signIn: {
        providers: async () => providersFor(platform.kind, await client.providers()),
        emailStart: email => client.emailStart(email), emailVerify: code => client.emailVerify(code), cancelEmail: () => client.cancelEmail(),
        phoneCode: async code => {
          const result = await client.phoneCode(code);
          if (result.outcome === "signed-in") { signedIn(); setProblem(undefined); }
          return result;
        },
        browser: async provider => {
          setProblem(undefined);
          // on the iPhone, Apple signs in in the system's own sheet, not a web page
          if (provider !== "apple" || !platform.appleSignIn) return client.oauthStart(provider);
          const result = await client.appleNative();
          if (result.outcome === "signed-in") signedIn();
          else if (result.outcome !== "canceled") setProblem(appleProblemLine(result.outcome));
        },
        problem, signedIn: () => { signedIn(); setProblem(undefined); },
      },
    };
  }, [account, signIns, origin, wanted, client, platform, problem]);
  if (wanted && restoring) return <div className="madani-mobile flex size-full items-center justify-center bg-app"><MascotLoader naps={false} /></div>;
  return <AccountContext value={context}>{children}</AccountContext>;
}
