import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AnimatePresence } from "motion/react";
import { MascotLoader } from "@/components/MascotLoader";
import { readSessionState } from "@/lib/session";
import { resetSessionEnded, useSessionEnded } from "@/lib/session-ended";
import { THEME_SKINS } from "@/lib/skins";
import { pairSignIn, parseMobilePairingLink, parseSignInLink, type MobileConnectionRecord, type PairSignIn } from "../../../shared/mobile-link";
import { usePlatform } from "../platform";
import { useMobileAccount } from "../account/AccountGate";
import type { AccountPlaces } from "../account/account-client";
import { enrollWorkspace } from "../account/enroll-workspace";
import { linkedHere } from "../account/CloudPicker";
import { placeKind } from "./connection-notice";
import { followSignInService, takeHeldSignIn } from "../account/environment";
import { installTransport, type PhoneTransport } from "../transport/transport";
import { Onboarding, type OnboardingStart } from "../onboarding/Onboarding";
import { SignInOffer } from "../account/SignInOffer";
import { Success } from "../onboarding/Success";
import { connectToWorkspace, createConnectionStore, PlaceGoneError } from "./connections";
import { LINK_DEADLINE_MS, linkDeadline, PairError, parseTypedPairing, relaySecrets, type TypedPairing } from "./pair";
import { ActiveConnection } from "./active";
import { TranscriptShelfScope } from "@/state/transcript-scope";
import { forgetTranscriptShelf } from "@/state/transcript-cache";
import { reportPresence } from "./presence";
import { registerPushForConnection } from "./push";
import { Unreachable } from "./Unreachable";
import { PhoneUpdateLine } from "./PhoneUpdateLine";
import { markCloudAsleep, noteCloudPageActivity, onCloudGone } from "@/lib/cloud-power";
import { liveEventsHeardAt, retryLiveEventsNow } from "@/lib/live-events";
import { phoneOffline } from "../network";
import { workspaceAnsweredAt } from "./reachability";
import { sameRoute, watchRoute } from "./route-watch";
import { learnRoutes } from "./learn-routes";

type GateState = { kind: "loading" } | { kind: "pair"; reason?: "revoked" } | { kind: "ready"; id: string }
  | { kind: "offline"; record: MobileConnectionRecord; others: MobileConnectionRecord[]; attempts: number; trying: boolean; gone?: true };

/** A first connect that failed after the computer accepted the pairing: only a refused token undoes it. */
export function pairedButUnreachable(error: unknown): boolean {
  return !(error instanceof PairError && error.code === "refused");
}

/** which signed-in account lists this madani cloud, the one in use asked first */
async function cloudOwner(account: { accounts: { id: string; email: string }[]; places(accountId?: string): Promise<AccountPlaces | null> },
  record: MobileConnectionRecord): Promise<{ id: string; email: string } | null> {
  for (const one of account.accounts) {
    const places = await account.places(one.id).catch(() => null);
    if (places && [...places.clouds, ...places.teams].some((cloud) => linkedHere(cloud, [record]))) return { id: one.id, email: one.email };
  }
  return null;
}

export function ConnectionGate({ children, forcePair }: { children: ReactNode; forcePair?: boolean }) {
  const platform = usePlatform();
  const account = useMobileAccount();
  const accountRef = useRef(account);
  accountRef.current = account;
  const store = useMemo(() => createConnectionStore(platform), [platform]);
  const [state, setState] = useState<GateState>({ kind: "loading" });
  const [incoming, setIncoming] = useState<{ payload: TypedPairing; signIn?: PairSignIn; sequence: number } | null>(null);
  const [celebrate, setCelebrate] = useState<{ name: string; sequence: number } | null>(null);
  const [entered, setEntered] = useState(false);
  const [adding, setAdding] = useState(0);
  // "madani:sign-in" (Settings, signed out) opens the madani cloud sign-in, "madani:add-account" an empty one beside it
  const [addingStep, setAddingStep] = useState<OnboardingStart>("welcome");
  // a madani cloud's qr opens the app at that sign-in, its email filled in
  const [signInEmail, setSignInEmail] = useState<{ email: string; code?: string; cloud?: string; sequence: number } | null>(null);
  useEffect(() => {
    const signIn = () => { setAddingStep("signin"); setAdding((n) => n + 1); };
    const addPlace = () => { setAddingStep("welcome"); setAdding((n) => n + 1); };
    const addAccount = () => { setSignInEmail(null); setAddingStep("addAccount"); setAdding((n) => n + 1); };
    window.addEventListener("madani:sign-in", signIn);
    window.addEventListener("madani:add-place", addPlace);
    window.addEventListener("madani:add-account", addAccount);
    return () => {
      window.removeEventListener("madani:sign-in", signIn); window.removeEventListener("madani:add-place", addPlace); window.removeEventListener("madani:add-account", addAccount);
    };
  }, []);
  // the app never reads the shelf shared by every workspace again; it may still hold an unlinked one's chats
  useEffect(() => { if (platform.native) void forgetTranscriptShelf(null); }, [platform]);
  const sequence = useRef(0);
  const uninstall = useRef<(() => void) | null>(null);
  const route = useRef<PhoneTransport | null>(null);
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  useEffect(() => {
    let stopped = false;
    const controller = new AbortController();
    // a retry keeps the unreachable screen up while it tries
    setState((s) => s.kind === "offline" ? { ...s, trying: true } : { kind: "loading" });
    const decide = async () => {
      if (forcePair) { setState({ kind: "pair" }); return; }
      const active = await store.active();
      if (stopped) return;
      if (active) {
        try {
          const transport = await connectToWorkspace(active.record, active.token, platform, controller.signal);
          if (stopped) { if (transport.kind === "relay") transport.channel.close(); return; }
          uninstall.current = installTransport(transport, retry);
          route.current = transport;
          if (transport.asleep) markCloudAsleep();
          setState({ kind: "ready", id: active.record.id });
          void store.touch(active.record.id).catch(() => {});
          void learnRoutes(active.record, transport, store.setRoutes, fetch, () => relaySecrets(platform, active.record.id));
        } catch (error) {
          if (stopped) return;
          if (error instanceof PairError && error.code === "refused") {
            await store.remove(active.record.id);
            if (!stopped) setState({ kind: "pair", reason: "revoked" });
          } else {
            // offline is not unpaired: keep the link and the other saved installations reachable
            const others = (await store.list().catch(() => [])).filter((record) => record.id !== active.record.id);
            const gone = error instanceof PlaceGoneError ? { gone: true as const } : {};
            if (!stopped) setState((s) => ({ kind: "offline", record: active.record, others, attempts: s.kind === "offline" ? s.attempts + 1 : 1, trying: false, ...gone }));
          }
        }
        return;
      }
      // a native app's own origin is its bundled files, never an installation: it always links one
      if (platform.native) { setState({ kind: "pair" }); return; }
      const session = await readSessionState();
      if (stopped) return;
      if (session.kind === "loopback" || session.kind === "session") {
        uninstall.current = installTransport({ kind: "same-origin", origin: window.location.origin });
        setState({ kind: "ready", id: "same-origin" });
      } else setState({ kind: "pair" });
    };
    void decide().catch(() => { if (!stopped) setState({ kind: "pair" }); });
    return () => { stopped = true; controller.abort(); uninstall.current?.(); uninstall.current = null; route.current = null; };
  }, [forcePair, platform, store, attempt, retry]);

  // a place with more than one route: when it goes quiet, the others are tried in the background and a working one
  // takes over without leaving the chat
  const readyId = state.kind === "ready" && state.id !== "same-origin" ? state.id : null;
  useEffect(() => {
    if (!readyId) return;
    const controller = new AbortController();
    const stop = watchRoute({
      heardAt: () => Math.max(liveEventsHeardAt() ?? 0, workspaceAnsweredAt() ?? 0) || null,
      online: () => !phoneOffline(),
      visible: () => document.visibilityState === "visible",
      onNetworkChange: platform.onNetworkChange && ((listener) => platform.onNetworkChange!(() => { retryLiveEventsNow({ redial: true }); listener(); })),
      rewalk: async () => {
        const active = await store.active();
        // a relay link already follows its tunnel from node to node, and a second one on the same channel would race it
        if (!active || active.record.id !== readyId || (active.record.via?.length ?? 0) < 2 || route.current?.kind !== "bearer" || controller.signal.aborted) return;
        const found = await connectToWorkspace(active.record, active.token, platform, controller.signal);
        const current = route.current;
        if (controller.signal.aborted || found.asleep || !current || sameRoute(found, current)) {
          if (found.kind === "relay") found.channel.close();
          return;
        }
        uninstall.current?.();
        uninstall.current = installTransport(found, retry);
        route.current = found;
        retryLiveEventsNow({ redial: true });
        void learnRoutes(active.record, found, store.setRoutes, fetch, () => relaySecrets(platform, active.record.id));
      },
    });
    return () => { controller.abort(); stop(); };
  }, [readyId, store, platform, retry]);

  // the place's edge said its madani cloud was deleted: connecting again finds that out and shows it, final
  useEffect(() => (state.kind === "ready" ? onCloudGone(retry) : undefined), [state.kind, retry]);

  // the workspace stopped taking this phone's session (it was removed there): connecting again finds out which it is,
  // and a refused token leaves for pairing with the reason
  const ended = useSessionEnded();
  useEffect(() => {
    if (!ended || state.kind !== "ready" || state.id === "same-origin") return;
    resetSessionEnded();
    retry();
  }, [ended, state, retry]);

  useEffect(() => {
    if (state.kind === "ready" && platform.native) void registerPushForConnection(platform);
  }, [state, platform]);

  useEffect(() => (state.kind === "ready" && platform.native ? reportPresence(platform) : undefined), [state, platform]);
  // the app coming back is the person using it, also when the web view misses its visibilitychange
  useEffect(() => platform.onResume?.(() => noteCloudPageActivity()), [platform]);

  // the account in use follows the place on screen: a madani cloud opens with the account it belongs to, so Settings,
  // pairing and enrollment speak for that account and never for another one signed in on the phone
  const [placeAccount, setPlaceAccount] = useState<{ id: string; owner: string | null } | null>(null);
  const tagged = useRef(new Set<string>());
  useEffect(() => {
    if (state.kind !== "ready" || state.id === "same-origin" || !account?.account) return;
    const key = `${state.id}:${account.accounts.map((one) => one.id).sort().join(",")}`;
    if (tagged.current.has(key)) return;
    tagged.current.add(key);
    const placeId = state.id;
    void (async () => {
      const record = (await store.list()).find((entry) => entry.id === placeId);
      if (!record) return;
      const owner = record.account && account.accounts.some((one) => one.id === record.account!.id) ? record.account : placeKind(record) === "cloud" ? await cloudOwner(account, record) : null;
      if (owner && (record.account?.id !== owner.id || record.account.email !== owner.email)) await store.setAccount(record.id, owner);
      if (owner && owner.id !== account.account?.id) await account.switchAccount(owner.id);
      setPlaceAccount({ id: placeId, owner: owner?.id ?? record.account?.id ?? null });
    })().catch(() => {});
  }, [state, store, account]);

  useEffect(() => {
    const signedIn = account?.account;
    if (state.kind !== "ready" || !signedIn || !account || placeAccount?.id !== state.id) return;
    // Security invariant: a place another account owns is never enrolled into the account in use.
    if (placeAccount.owner && placeAccount.owner !== signedIn.id) return;
    void enrollWorkspace(platform, state.id, signedIn.id, account.enrollGrant);
  }, [state, platform, account, placeAccount]);

  useEffect(() => {
    const receive = (url: string) => {
      const signIn = parseSignInLink(url);
      if (signIn && followSignInService(url, signIn.service, accountRef.current)) return true;
      if (signIn) {
        setIncoming(null);
        setSignInEmail({ email: signIn.email, ...(signIn.code ? { code: signIn.code } : {}), ...(signIn.cloud ? { cloud: signIn.cloud } : {}), sequence: ++sequence.current });
        setAddingStep("signin");
        setAdding((n) => n + 1);
        return true;
      }
      const payload = parseMobilePairingLink(url);
      const carried = payload ? pairSignIn(url) : null;
      if (payload) setIncoming({ payload, ...(carried ? { signIn: carried } : {}), sequence: ++sequence.current });
      return Boolean(payload);
    };
    const customLink = (event: Event) => {
      const detail: unknown = (event as CustomEvent).detail;
      if (typeof detail !== "string") return;
      const parsed = parseTypedPairing(detail);
      if (parsed && !("kind" in parsed)) setIncoming({ payload: parsed, sequence: ++sequence.current });
    };
    const stop = platform.onAppUrl?.(receive);
    const held = takeHeldSignIn();
    if (held) receive(held);
    window.addEventListener("madani:pair-link", customLink);
    return () => { stop?.(); window.removeEventListener("madani:pair-link", customLink); };
  }, [platform]);

  /** Linked: the app mounts on the new installation straight away, under the success moment, so Home is loaded by the
   * time the moment hands over. No reload. */
  const linked = useCallback(async (record: MobileConnectionRecord, token: string, name: string) => {
    await store.save(record, token);
    let transport: Awaited<ReturnType<typeof connectToWorkspace>>;
    try {
      transport = await linkDeadline(connectToWorkspace(record, token, platform, AbortSignal.timeout(LINK_DEADLINE_MS)));
    } catch (error) {
      if (!pairedButUnreachable(error)) { await store.remove(record.id); throw error; }
      // the pairing took: the computer already lists this phone, so the phone keeps the link and says it can't reach it
      // yet (with Try again) instead of a pairing error over a pairing that worked
      setIncoming(null);
      setAdding(0);
      setEntered(true);
      retry();
      return;
    }
    uninstall.current?.();
    uninstall.current = installTransport(transport, retry);
    route.current = transport;
    if (transport.asleep) markCloudAsleep();
    void learnRoutes(record, transport, store.setRoutes, fetch, () => relaySecrets(platform, record.id));
    resetSessionEnded();
    // the system's own notifications question, over the screen, right as the link is made
    if (platform.native) void registerPushForConnection(platform, { prompt: true });
    setIncoming(null);
    setAdding(0);
    setEntered(true);
    setCelebrate({ name, sequence: ++sequence.current });
    setState({ kind: "ready", id: record.id });
  }, [store, platform, retry]);
  const cancel = () => { ++sequence.current; setIncoming(null); };
  const switchTo = useCallback((id: string) => { void store.setActive(id).then(retry, retry); }, [store, retry]);
  const openKept = useCallback((id: string) => { ++sequence.current; setIncoming(null); setAdding(0); switchTo(id); }, [switchTo]);
  const removeGone = useCallback((id: string, next: string | undefined) => {
    void store.remove(id).then(() => (next ? store.setActive(next) : undefined)).then(retry, retry);
  }, [store, retry]);

  const success = (
    <AnimatePresence>
      {celebrate && <Success key={celebrate.sequence} name={celebrate.name} onDone={() => { setCelebrate(null); platform.setStatusBar?.(document.documentElement.dataset.skin === THEME_SKINS.dark ? "light" : "dark"); }} />}
    </AnimatePresence>
  );
  const onboarding = state.kind !== "ready" || (forcePair && !entered);
  if (state.kind === "loading" && !incoming && !forcePair) return <div className="madani-mobile flex size-full items-center justify-center bg-app"><MascotLoader naps={false} /></div>;
  if (state.kind === "offline" && !forcePair) {
    if (!incoming && adding === 0) return <>{success}<Unreachable record={state.record} others={state.others} attempts={state.attempts} trying={state.trying} gone={state.gone === true} onRetry={retry} onSwitch={switchTo} onRemove={() => removeGone(state.record.id, state.others[0]?.id)} /></>;
    return <>{success}<Onboarding key={incoming ? `in-${incoming.sequence}` : `add-${adding}`} initial={incoming?.payload} initialSignIn={incoming?.signIn} startAtLink startAt={incoming ? undefined : addingStep} email={addingStep === "addAccount" ? undefined : signInEmail?.email} signInCode={incoming ? undefined : signInEmail?.code} signInCloud={incoming ? undefined : signInEmail?.cloud} onOpen={openKept} onLinked={linked} onCancel={() => { cancel(); setAdding(0); }} /></>;
  }
  if (onboarding) {
    return <>{success}<Onboarding key={incoming?.sequence ?? signInEmail?.sequence ?? 0} initial={incoming?.payload} initialSignIn={incoming?.signIn} reason={state.kind === "pair" ? state.reason : null}
      startAt={!incoming && signInEmail ? "signin" : undefined} email={signInEmail?.email} signInCode={incoming ? undefined : signInEmail?.code} signInCloud={incoming ? undefined : signInEmail?.cloud} onOpen={openKept} onLinked={linked} onCancel={cancel} /></>;
  }
  return (
    <>
      <ActiveConnection value={state.id}><TranscriptShelfScope value={state.id === "same-origin" ? null : state.id}><Fragment key={state.id}>{children}</Fragment></TranscriptShelfScope></ActiveConnection>
      <PhoneUpdateLine connection={state.kind === "ready" ? state.id : null} />
      {(incoming || adding > 0) && (
        <div className="fixed inset-0 z-50">
          <Onboarding key={incoming ? `in-${incoming.sequence}` : `add-${adding}`} initial={incoming?.payload} initialSignIn={incoming?.signIn} startAtLink startAt={incoming ? undefined : addingStep} email={addingStep === "addAccount" ? undefined : signInEmail?.email} signInCode={incoming ? undefined : signInEmail?.code} signInCloud={incoming ? undefined : signInEmail?.cloud} onOpen={openKept}
            onLinked={linked} onCancel={() => { cancel(); setAdding(0); }} />
        </div>
      )}
      <SignInOffer paused={Boolean(celebrate || incoming || adding > 0)} />
      {success}
    </>
  );
}
