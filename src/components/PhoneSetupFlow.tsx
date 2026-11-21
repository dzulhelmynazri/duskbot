import { companionBridge } from "@/lib/companion-bridge";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/cn";
import { AlertTriangle, Check, Loader2 } from "../icons";
import { QRCodeSVG } from "qrcode.react";
import { phonePairingLink } from "../../shared/pairing-link";
import {
  companionPairingAddressText,
  companionPairingRoute,
  companionPairingRoutePin,
  companionPairingRoutePinAvailable,
  type CompanionEndpoint,
  type CompanionPairingRoutePin,
  type CompanionPairingRouteMode,
} from "../lib/companion-pairing";
import {
  PHONE_SETUP_PROVISIONING_TIMEOUT_MS,
  claimPhonePairingAttempt,
  closePhonePairingIfOwned,
  completePhonePairingAttempt,
  companionPairingMode,
  companionPairingOpenFailure,
  companionStartFailure,
  derivePhoneSetupPhase,
  initialPhoneSetupFlowState,
  keepPhonePairingIfCurrent,
  invalidatePhonePairingAttempt,
  newlyPairedDeviceForFlow,
  normalizePhoneSetupActionError,
  phonePairingGate,
  phoneSetupBaseline,
  phoneSetupReducer,
  preparePhonePairingRoute,
  queuePhonePairingAttempt,
  releasePhonePairingAttempt,
  secureAddressRequestLapsed,
  shouldArmPhoneSetupProvisioningTimeout,
  shouldPrepareSecureAddress,
  startNonOverlappingPhoneSetupPoll,
  type PhoneSetupPhase,
  type PhonePairingAttemptLock,
  type PhonePairingAttemptQueue,
} from "../lib/phone-setup";
import type { CompanionAccountState } from "../types/madaniDesktop";
import {
  companionStateRefreshIsCurrent,
  mutateCompanionBridgeState,
  phonePairingManualCodeMode,
} from "../lib/companion-state";
import { ConnectionDetail } from "./ConnectionDetail";
import { requireUserPresence } from "@/lib/user-presence";
import { phoneRelayBridge, relayPairingUsable } from "@/lib/phone-relay";
import type { PhoneRelayState } from "../types/madaniDesktop";
import { AnywhereUnavailableRows, ErrorLine, FIELD, FlowRow, RelayPairingRows, WifiRow } from "./PhoneFlowRows";

export interface PhoneDevice {
  id: string;
  name: string;
  createdAt: number;
  lastSeenAt: number;
  cloudDesktopAccess: boolean;
  /** Absent (older sidecars) means no browser access. */
  browserControlAccess?: boolean;
}

export interface CompanionState {
  enabled: boolean;
  keepAwake: boolean;
  port: number;
  devices: PhoneDevice[];
  connectedDeviceIds?: string[];
  pairing: { code: string; token: string; expiresAt: number } | null;
  addresses?: string[];
  tailscale?: string;
  tailnetName?: string;
  lan?: string | null;
  hosts?: string[];
  endpoints?: CompanionEndpoint[];
  secretPublicKey?: string;
  discovery?: { advertising: boolean; name: string };
  /** Windows has that network down as Public, where its firewall drops a phone's connection. */
  publicNetwork?: string;
  error?: string;
}

export type CompanionBridge = {
  state: () => Promise<CompanionState>;
  start: () => Promise<CompanionState>;
  stop: () => Promise<CompanionState>;
  keepAwake: (enabled: boolean) => Promise<CompanionState>;
  refreshTailscale: () => Promise<CompanionState>;
  pairing: (open: boolean, expectedToken?: string) => Promise<CompanionState>;
  cloudDesktop: (deviceId: string, allowed: boolean) => Promise<CompanionState>;
  browserControl: (deviceId: string, allowed: boolean) => Promise<CompanionState>;
  revoke: (deviceId: string) => Promise<CompanionState>;
};

type AccountBridge = NonNullable<NonNullable<Window["madaniDesktop"]>["companionAccount"]>;
type StateBridge<T> = { state: () => Promise<T> };
// Functions, not constants: a message resolved at import time would keep the language the app booted in.
const directPairingUnavailable = () => t("phone.error.directUnavailable");
const protectedPairingUnavailable = () => t("phone.error.protectedUnavailable");

interface OwnedCompanionPairingRoutePin extends CompanionPairingRoutePin {
  generation: number;
  token: string;
}

interface PhonePairingRequest {
  routeMode: CompanionPairingRouteMode;
  accountOverride?: CompanionAccountState | null;
  generation: number;
}

export { companionBridge };

export const companionAccountBridge = (): AccountBridge | null =>
  // SAFETY: Electron exposes only these account operations and never sends credentials to the renderer.
  (globalThis as { madaniDesktop?: { companionAccount?: AccountBridge } }).madaniDesktop?.companionAccount ?? null;

export const loadCompanionBridgeState = async (
  companion: StateBridge<CompanionState> | null,
  remote: StateBridge<CompanionAccountState> | null,
): Promise<{ companion: CompanionState | null; account: CompanionAccountState | null }> => {
  const [companionResult, accountResult] = await Promise.allSettled([
    companion ? Promise.resolve().then(() => companion.state()) : Promise.resolve(null),
    remote ? Promise.resolve().then(() => remote.state()) : Promise.resolve(null),
  ]);
  return {
    companion: companionResult.status === "fulfilled" ? companionResult.value : null,
    account: accountResult.status === "fulfilled" ? accountResult.value : null,
  };
};

export const shouldHydrateCompanionEmail = (
  userEdited: boolean,
  account: CompanionAccountState,
): boolean => !userEdited && Boolean(account.email);

export const companionAccountActionError = (
  account: CompanionAccountState | null,
  actionError: string | null,
): string | null => {
  if (actionError) return actionError;
  return account?.available && account.status === "signed-out" ? account.message ?? null : null;
};

export interface PhoneSetupController {
  state: CompanionState | null;
  account: CompanionAccountState | null;
  /** this computer's relay to its phones; null in a build without one */
  relay: PhoneRelayState | null;
  /** the secure route is the relay: the pairing code reaches this computer from any network */
  relayPairing: boolean;
  /** the relay's state was asked for at least once, so a null relay means this build has none */
  relayChecked: boolean;
  phase: PhoneSetupPhase;
  email: string;
  code: string;
  codeSent: boolean;
  busy: boolean;
  accountBusy: boolean;
  error: string | null;
  accountError: string | null;
  pairingLink: string | null;
  secondsLeft: number;
  address: string | undefined;
  pairingPort: number;
  addressText: string | undefined;
  hostedReady: boolean;
  localFallback: boolean;
  tailscaleFallback: boolean;
  tailscaleAvailable: boolean;
  pairingExpired: boolean;
  setupTimedOut: boolean;
  setEmail: (email: string) => void;
  setCode: (code: string) => void;
  changeEmail: () => void;
  start: () => void;
  useLocal: () => void;
  useTailscale: () => void;
  refreshTailscale: () => void;
  requestCode: () => void;
  verifyCode: () => void;
  retryAccount: () => void;
  retryRelay: () => void;
  cancel: () => void;
  refreshCode: () => void;
  finish: () => void;
  act: (call: (companion: CompanionBridge) => Promise<CompanionState>) => Promise<void>;
  accountAct: (call: (remote: AccountBridge) => Promise<CompanionAccountState>) => Promise<void>;
}

export function usePhoneSetupController(profileEmail = ""): PhoneSetupController {
  const [state, setState] = useState<CompanionState | null>(null);
  const [account, setAccount] = useState<CompanionAccountState | null>(null);
  const [relay, setRelay] = useState<PhoneRelayState | null>(null);
  const [relayChecked, setRelayChecked] = useState(false);
  const [email, setEmailState] = useState(profileEmail);
  const [code, setCodeState] = useState("");
  const [codeSent, setCodeSent] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  const [pairingBusy, setPairingBusy] = useState(false);
  const [accountBusy, setAccountBusy] = useState(false);
  const [provisioning, setProvisioning] = useState(false);
  const [setupTimedOut, setSetupTimedOut] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [accountError, setAccountError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [flow, dispatchFlow] = useReducer(phoneSetupReducer, initialPhoneSetupFlowState);
  const emailEdited = useRef(false);
  const pairingUiOwner = useRef<PhonePairingAttemptLock>({ generation: null });
  const pairingAttemptQueue = useRef<PhonePairingAttemptQueue<PhonePairingRequest>>({
    active: null,
    pending: null,
  });
  const runPairingAttemptRef = useRef<(request: PhonePairingRequest) => Promise<void>>(
    async () => {},
  );
  const pairingRoutePinRef = useRef<OwnedCompanionPairingRoutePin | null>(null);
  const [pairingRoutePinState, setPairingRoutePinState] =
    useState<OwnedCompanionPairingRoutePin | null>(null);
  const setupGeneration = useRef(0);
  const mounted = useRef(true);
  const companionMutationEpoch = useRef(0);
  const loadInFlight = useRef<Promise<void> | null>(null);

  const publishPairingRoutePin = useCallback((pin: OwnedCompanionPairingRoutePin | null) => {
    pairingRoutePinRef.current = pin;
    setPairingRoutePinState(pin);
  }, []);

  const loadRelay = useCallback((ask: "state" | "ready" = "state") => {
    const bridge = phoneRelayBridge();
    if (!bridge) {
      setRelayChecked(true);
      return;
    }
    void bridge[ask]()
      .then((next) => { if (mounted.current) setRelay(next); }, () => {})
      .finally(() => { if (mounted.current) setRelayChecked(true); });
  }, []);

  useEffect(() => {
    mounted.current = true;
    loadRelay();
    return () => {
      mounted.current = false;
      setupGeneration.current += 1;
    };
  }, []);

  const load = useCallback((): Promise<void> => {
    if (loadInFlight.current) return loadInFlight.current;
    const refreshEpoch = companionMutationEpoch.current;
    const pending = (async () => {
      const next = await loadCompanionBridgeState(companionBridge(), companionAccountBridge());
      if (!mounted.current) return;
      if (
        next.companion
        && companionStateRefreshIsCurrent(companionMutationEpoch, refreshEpoch)
      ) {
        setState(next.companion);
      }
      if (next.account) {
        setAccount(next.account);
        if (shouldHydrateCompanionEmail(emailEdited.current, next.account)) {
          setEmailState(next.account.email ?? "");
        }
      }
    })().finally(() => {
      if (loadInFlight.current === pending) loadInFlight.current = null;
    });
    loadInFlight.current = pending;
    return pending;
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!emailEdited.current && profileEmail) setEmailState(profileEmail);
  }, [profileEmail]);

  const act = useCallback(async (call: (companion: CompanionBridge) => Promise<CompanionState>) => {
    const companion = companionBridge();
    if (!companion) return;
    setActionBusy(true);
    setError(null);
    try {
      const next = await mutateCompanionBridgeState(
        companionMutationEpoch,
        () => call(companion),
      );
      if (mounted.current) setState(next);
    } catch (cause) {
      if (mounted.current) setError(
        normalizePhoneSetupActionError(
          cause,
          t("phone.error.remoteUpdate"),
        ),
      );
    } finally {
      if (mounted.current) setActionBusy(false);
    }
  }, []);

  const accountAct = useCallback(
    async (call: (remote: AccountBridge) => Promise<CompanionAccountState>) => {
      const remote = companionAccountBridge();
      if (!remote) return;
      setAccountBusy(true);
      setAccountError(null);
      try {
        const next = await mutateCompanionBridgeState(
          companionMutationEpoch,
          () => call(remote),
        );
        if (!mounted.current) return;
        setAccount(next);
        await load();
      } catch (cause) {
        if (mounted.current) setAccountError(normalizePhoneSetupActionError(
          cause,
          t("phone.error.secureUpdate"),
        ));
      } finally {
        if (mounted.current) setAccountBusy(false);
      }
    },
    [load],
  );

  const runPairingAttempt = useCallback(
    async ({ routeMode, accountOverride, generation }: PhonePairingRequest) => {
      const finishAttempt = () => {
        if (releasePhonePairingAttempt(pairingUiOwner.current, generation) && mounted.current) {
          setPairingBusy(false);
        }
        const next = completePhonePairingAttempt(pairingAttemptQueue.current, generation);
        if (next) void runPairingAttemptRef.current(next);
      };
      const isCurrent = () => mounted.current && setupGeneration.current === generation;
      if (!isCurrent()) {
        finishAttempt();
        return;
      }
      const companion = companionBridge();
      if (!companion) {
        if (mounted.current && setupGeneration.current === generation) {
          setError(t("phone.error.desktopOnly"));
        }
        finishAttempt();
        return;
      }
      const staleAttemptMayClose = () => {
        const activePin = pairingRoutePinRef.current;
        return !activePin || activePin.generation === generation;
      };
      const previousPin = pairingRoutePinRef.current;
      if (previousPin && previousPin.generation !== generation) {
        publishPairingRoutePin(null);
        setState((current) => current?.pairing?.token === previousPin.token
          ? { ...current, pairing: null }
          : current);
      }
      setError(null);
      try {
        const started = await preparePhonePairingRoute(
          routeMode,
          Boolean(state?.enabled),
          {
            read: () => companion.state(),
            start: () => mutateCompanionBridgeState(
              companionMutationEpoch,
              () => companion.start(),
            ),
            refreshTailscale: () => mutateCompanionBridgeState(
              companionMutationEpoch,
              () => companion.refreshTailscale(),
            ),
            shouldContinue: isCurrent,
          },
        );
        if (!isCurrent()) return;
        setState(started);
        const startFailure = companionStartFailure(started);
        if (startFailure) {
          setProvisioning(false);
          setError(startFailure);
          dispatchFlow({ type: "reset" });
          return;
        }
        const explicitRoute = routeMode !== "automatic";
        const gate = phonePairingGate(accountOverride ?? account, started, explicitRoute);
        const remote = companionAccountBridge();
        const prepare = remote?.prepare && shouldPrepareSecureAddress(routeMode, gate, accountOverride ?? account)
          ? remote.prepare
          : null;
        if (gate !== "open") {
          setProvisioning(gate === "wait" || gate === "start");
          if (prepare) {
            const next = await mutateCompanionBridgeState(companionMutationEpoch, () => prepare());
            if (isCurrent()) setAccount(next);
          }
          return;
        }
        if (prepare) void Promise.resolve().then(() => prepare()).catch(() => {});
        if (explicitRoute && !companionPairingRoute(started, routeMode)) {
          setProvisioning(false);
          setError(routeMode === "tailscale"
            ? t("phone.error.tailscaleUnavailable")
            : directPairingUnavailable());
          dispatchFlow({ type: "reset" });
          return;
        }
        const paired = await keepPhonePairingIfCurrent(
          () => mutateCompanionBridgeState(
            companionMutationEpoch,
            () => companion.pairing(true),
          ),
          (opened) => closePhonePairingIfOwned(
            opened,
            () => companion.state(),
            () => mutateCompanionBridgeState(
              companionMutationEpoch,
              () => companion.pairing(false, opened.pairing?.token),
            ),
            staleAttemptMayClose,
          ),
          isCurrent,
        );
        if (!paired) return;

        const pairingWindow = paired.pairing;
        const pairingFailure = companionPairingOpenFailure(
          paired,
          started.pairing?.token ?? null,
        );
        const routePin = pairingFailure ? null : companionPairingRoutePin(paired, routeMode);
        if (pairingFailure || !routePin || !pairingWindow) {
          await closePhonePairingIfOwned(
            paired,
            () => companion.state(),
            () => mutateCompanionBridgeState(
              companionMutationEpoch,
              () => companion.pairing(false, paired.pairing?.token),
            ),
            isCurrent,
          );
          if (!isCurrent()) return;
          publishPairingRoutePin(null);
          setState({ ...paired, pairing: null });
          setProvisioning(false);
          setError(pairingFailure ?? (routeMode === "local"
            ? directPairingUnavailable()
            : routeMode === "tailscale"
              ? t("phone.error.tailscaleUnavailable")
              : protectedPairingUnavailable()));
          dispatchFlow({ type: "reset" });
          return;
        }
        publishPairingRoutePin({
          ...routePin,
          generation,
          token: pairingWindow.token,
        });
        setState(paired);
        setProvisioning(false);
        setSetupTimedOut(false);
        dispatchFlow({
          type: "pairing-opened",
          deviceIds: paired.devices.map((device) => device.id),
        });
      } catch (cause) {
        if (!isCurrent()) return;
        publishPairingRoutePin(null);
        setProvisioning(false);
        setError(normalizePhoneSetupActionError(
          cause,
          t("phone.error.pairingPrepare"),
        ));
        dispatchFlow({ type: "reset" });
      } finally {
        finishAttempt();
      }
    },
    [account, publishPairingRoutePin, state],
  );

  useLayoutEffect(() => {
    runPairingAttemptRef.current = runPairingAttempt;
  }, [runPairingAttempt]);

  const openPairing = useCallback((
    routeMode: CompanionPairingRouteMode,
    accountOverride?: CompanionAccountState | null,
    generation = setupGeneration.current,
  ) => {
    const request = { routeMode, accountOverride, generation };
    const decision = queuePhonePairingAttempt(pairingAttemptQueue.current, request);
    if (decision === "duplicate") return;
    claimPhonePairingAttempt(pairingUiOwner.current, generation);
    setPairingBusy(true);
    if (decision === "start") void runPairingAttemptRef.current(request);
  }, []);

  const startNow = useCallback(() => {
    const baseline = phoneSetupBaseline(state?.devices ?? null);
    if (!baseline) return;
    const generation = ++setupGeneration.current;
    dispatchFlow({ type: "start", deviceIds: baseline });
    setError(null);
    setAccountError(null);
    setSetupTimedOut(false);
    loadRelay();
    if (relayPairingUsable(relay) && phonePairingGate(account, state, false) !== "open") return;
    if (
      phonePairingGate(account, state, false) === "open"
      || (account?.available && (account.status === "ready" || account.status === "connecting"))
    ) {
      setProvisioning(true);
      void openPairing("automatic", account, generation);
    }
  }, [account, loadRelay, openPairing, relay, state]);

  const useLocalNow = useCallback(() => {
    const baseline = phoneSetupBaseline(state?.devices ?? null);
    if (!baseline) return;
    if (!flow.active) {
      dispatchFlow({ type: "start", deviceIds: baseline });
    }
    const generation = ++setupGeneration.current;
    dispatchFlow({ type: "use-local" });
    setProvisioning(true);
    setSetupTimedOut(false);
    setAccountError(null);
    void openPairing("local", undefined, generation);
  }, [flow.active, openPairing, state?.devices]);

  const useTailscaleNow = useCallback(() => {
    const baseline = phoneSetupBaseline(state?.devices ?? null);
    if (!baseline) return;
    if (!flow.active) {
      dispatchFlow({ type: "start", deviceIds: baseline });
    }
    const generation = ++setupGeneration.current;
    dispatchFlow({ type: "use-tailscale" });
    setProvisioning(true);
    setSetupTimedOut(false);
    setAccountError(null);
    void openPairing("tailscale", undefined, generation);
  }, [flow.active, openPairing, state?.devices]);

  // One OS check per pairing flow: it starts the flow, and Cancel or Done ends it, so the next flow asks again.
  const presence = useRef<"none" | "asking" | "granted">("none");
  const entries = useRef({ startNow, useLocalNow, useTailscaleNow });
  useLayoutEffect(() => {
    entries.current = { startNow, useLocalNow, useTailscaleNow };
  }, [startNow, useLocalNow, useTailscaleNow]);
  const afterPresence = useCallback((run: () => void) => {
    if (presence.current === "granted") {
      run();
      return;
    }
    if (presence.current === "asking") return;
    presence.current = "asking";
    void requireUserPresence().then((ok) => {
      if (presence.current !== "asking") return;
      presence.current = ok ? "granted" : "none";
      if (ok && mounted.current) run();
    });
  }, []);
  const start = useCallback(() => afterPresence(() => entries.current.startNow()), [afterPresence]);
  const useLocal = useCallback(() => afterPresence(() => entries.current.useLocalNow()), [afterPresence]);
  const useTailscale = useCallback(() => afterPresence(() => entries.current.useTailscaleNow()), [afterPresence]);

  const refreshTailscale = useCallback(() => {
    void act((companion) => companion.refreshTailscale());
  }, [act]);

  const requestCode = useCallback(() => {
    const remote = companionAccountBridge();
    const normalized = email.trim().toLowerCase();
    if (!remote || !normalized) return;
    const generation = setupGeneration.current;
    setAccountBusy(true);
    setAccountError(null);
    void remote
      .requestCode(normalized)
      .then((next) => {
        if (!mounted.current || setupGeneration.current !== generation) return;
        setAccount(next);
        setCodeSent(true);
      })
      .catch((cause: unknown) => {
        if (!mounted.current || setupGeneration.current !== generation) return;
        setAccountError(
          normalizePhoneSetupActionError(cause, t("phone.error.sendCode")),
        );
      })
      .finally(() => {
        if (mounted.current && setupGeneration.current === generation) setAccountBusy(false);
      });
  }, [email]);

  const verifyCode = useCallback(() => {
    const remote = companionAccountBridge();
    const normalized = email.trim().toLowerCase();
    if (!remote || code.length !== 8) return;
    const generation = setupGeneration.current;
    setAccountBusy(true);
    setProvisioning(true);
    setSetupTimedOut(false);
    setAccountError(null);
    void mutateCompanionBridgeState(
      companionMutationEpoch,
      () => remote.verifyCode(normalized, code),
    )
      .then(async (next) => {
        if (!mounted.current || setupGeneration.current !== generation) return;
        setAccount(next);
        setCodeState("");
        setCodeSent(false);
        await openPairing("automatic", next, generation);
      })
      .catch((cause: unknown) => {
        if (!mounted.current || setupGeneration.current !== generation) return;
        setProvisioning(false);
        setAccountError(
          normalizePhoneSetupActionError(cause, t("phone.error.verifyCode")),
        );
      })
      .finally(() => {
        if (mounted.current && setupGeneration.current === generation) setAccountBusy(false);
      });
  }, [code, email, openPairing]);

  const retryAccount = useCallback(() => {
    const remote = companionAccountBridge();
    if (!remote) return;
    const baseline = flow.active ? phoneSetupBaseline(state?.devices ?? null) : null;
    const generation = ++setupGeneration.current;
    if (baseline) dispatchFlow({ type: "start", deviceIds: baseline });
    setAccountBusy(true);
    setProvisioning(true);
    setSetupTimedOut(false);
    setAccountError(null);
    void mutateCompanionBridgeState(
      companionMutationEpoch,
      () => remote.retry(),
    )
      .then(async (next) => {
        if (!mounted.current || setupGeneration.current !== generation) return;
        setAccount(next);
        if (flow.active) await openPairing("automatic", next, generation);
        else {
          await load();
          if (mounted.current && setupGeneration.current === generation) setProvisioning(false);
        }
      })
      .catch((cause: unknown) => {
        if (!mounted.current || setupGeneration.current !== generation) return;
        setProvisioning(false);
        setAccountError(
          normalizePhoneSetupActionError(cause, t("phone.error.restore")),
        );
      })
      .finally(() => {
        if (mounted.current && setupGeneration.current === generation) setAccountBusy(false);
      });
  }, [flow.active, load, openPairing, state?.devices]);

  const phase = derivePhoneSetupPhase(flow, {
    accountStatus: account?.available ? account.status : "unavailable",
    accountBusy,
    provisioning,
    provisioningTimedOut: setupTimedOut,
    pairingOpen: Boolean(
      state?.pairing
      && pairingRoutePinState?.token === state.pairing.token,
    ),
  });

  const onlyWifi = phase === "sign-in" && !account?.available && relayChecked && relay === null
    && !flow.localFallback && !flow.tailscaleFallback;
  useEffect(() => {
    if (onlyWifi) entries.current.useLocalNow();
  }, [onlyWifi]);

  const signingIn = phase === "sign-in";
  useEffect(() => {
    if (!signingIn) return;
    const refresh = () => loadRelay();
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [loadRelay, signingIn]);

  useEffect(() => {
    if (
      !flow.active
      || flow.localFallback
      || flow.tailscaleFallback
      || !account
      || (account.available && account.status !== "signed-out" && account.status !== "error")
    ) {
      return;
    }
    setProvisioning(false);
  }, [account, flow.active, flow.localFallback, flow.tailscaleFallback]);

  useEffect(() => {
    if (!shouldArmPhoneSetupProvisioningTimeout(flow, {
      provisioning,
      provisioningTimedOut: setupTimedOut,
    })) return;
    const timer = window.setTimeout(() => {
      const timedOutGeneration = setupGeneration.current;
      setupGeneration.current += 1;
      invalidatePhonePairingAttempt(pairingAttemptQueue.current, timedOutGeneration);
      releasePhonePairingAttempt(pairingUiOwner.current, timedOutGeneration);
      setPairingBusy(false);
      setAccountBusy(false);
      setProvisioning(false);
      setSetupTimedOut(true);
    }, PHONE_SETUP_PROVISIONING_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [flow, provisioning, setupTimedOut]);

  useEffect(() => {
    const pin = pairingRoutePinState;
    if (!pin || !state) return;
    if (!state.pairing) {
      publishPairingRoutePin(null);
      return;
    }

    const tokenMatches = state.pairing.token === pin.token;
    const routeAvailable = companionPairingRoutePinAvailable(state, pin);
    if (tokenMatches && routeAvailable) return;

    const companion = companionBridge();
    if (setupGeneration.current === pin.generation) setupGeneration.current += 1;
    invalidatePhonePairingAttempt(pairingAttemptQueue.current, pin.generation);
    releasePhonePairingAttempt(pairingUiOwner.current, pin.generation);
    setPairingBusy(false);
    publishPairingRoutePin(null);
    setState((current) => current ? { ...current, pairing: null } : current);
    setProvisioning(false);
    setSetupTimedOut(false);
    setError(tokenMatches
      ? protectedPairingUnavailable()
      : t("phone.error.codeChanged"));
    dispatchFlow({ type: "reset" });

    if (tokenMatches && companion) {
      void closePhonePairingIfOwned(
        state,
        () => companion.state(),
        () => mutateCompanionBridgeState(
          companionMutationEpoch,
          () => companion.pairing(false, state.pairing?.token),
        ),
        () => {
          const activePin = pairingRoutePinRef.current;
          return !activePin || activePin.generation === pin.generation;
        },
      );
    }
  }, [pairingRoutePinState, publishPairingRoutePin, state]);

  useEffect(() => {
    if (!state) return;
    const device = newlyPairedDeviceForFlow(flow, state.devices);
    if (device) dispatchFlow({ type: "paired", deviceName: device.name });
  }, [flow, state]);

  useEffect(() => {
    if (
      !flow.active ||
      flow.localFallback ||
      flow.tailscaleFallback ||
      flow.pairingAttempted ||
      setupTimedOut ||
      !state
    ) {
      return;
    }
    if (
      phonePairingGate(account, state, false) === "open"
      || (!provisioning && secureAddressRequestLapsed(account, state))
    ) {
      void openPairing("automatic");
    }
  }, [account, flow.active, flow.localFallback, flow.pairingAttempted, flow.tailscaleFallback, openPairing, provisioning, setupTimedOut, state]);

  const shouldPoll = flow.active || Boolean(state?.pairing);
  useEffect(() => {
    return startNonOverlappingPhoneSetupPoll(
      () => {
        setNow(Date.now());
        return load();
      },
      shouldPoll ? 1_000 : 10_000,
    );
  }, [load, shouldPoll]);

  const pairingRouteMode: CompanionPairingRouteMode = flow.localFallback
    ? "local"
    : flow.tailscaleFallback
      ? "tailscale"
      : "automatic";
  const pairingRoute = useMemo(
    () => {
      if (!state) return null;
      if (state.pairing) {
        return pairingRoutePinState?.token === state.pairing.token
          ? pairingRoutePinState.route
          : null;
      }
      return companionPairingRoute(state, pairingRouteMode);
    },
    [pairingRouteMode, pairingRoutePinState, state],
  );
  const pairingLink = useMemo(() => {
    if (!state?.pairing || !pairingRoute) return null;
    return phonePairingLink({
      ...pairingRoute,
      code: state.pairing.code,
      token: state.pairing.token,
      name: state.discovery?.name,
      secretPublicKey: state.secretPublicKey,
    });
  }, [pairingRoute, state]);

  const cancel = useCallback(() => {
    presence.current = "none";
    const cancelledGeneration = setupGeneration.current;
    setupGeneration.current += 1;
    invalidatePhonePairingAttempt(pairingAttemptQueue.current, cancelledGeneration);
    releasePhonePairingAttempt(pairingUiOwner.current, cancelledGeneration);
    setPairingBusy(false);
    const snapshot = state;
    const companion = companionBridge();
    publishPairingRoutePin(null);
    setState((current) => current ? { ...current, pairing: null } : current);
    if (companion && snapshot?.pairing) {
      void closePhonePairingIfOwned(
        snapshot,
        () => companion.state(),
        () => mutateCompanionBridgeState(
          companionMutationEpoch,
          () => companion.pairing(false, snapshot.pairing?.token),
        ),
        () => pairingRoutePinRef.current === null,
      );
    }
    setProvisioning(false);
    setAccountBusy(false);
    setSetupTimedOut(false);
    setCodeSent(false);
    setCodeState("");
    dispatchFlow({ type: "reset" });
  }, [publishPairingRoutePin, state]);

  return {
    state,
    account,
    relay,
    relayPairing: flow.active && !flow.localFallback && !flow.tailscaleFallback && relayPairingUsable(relay)
      && !state?.endpoints?.some((endpoint) => endpoint.kind === "hosted"),
    relayChecked,
    phase,
    email,
    code,
    codeSent,
    busy: actionBusy || pairingBusy,
    accountBusy,
    error,
    accountError,
    pairingLink,
    secondsLeft: state?.pairing
      ? Math.max(0, Math.round((state.pairing.expiresAt - now) / 1000))
      : 0,
    address: pairingRoute?.address,
    pairingPort: pairingRoute?.port ?? state?.port ?? 8810,
    addressText: pairingRoute ? companionPairingAddressText(pairingRoute) : undefined,
    hostedReady: Boolean(state?.endpoints?.some((endpoint) => endpoint.kind === "hosted")),
    localFallback: flow.localFallback,
    tailscaleFallback: flow.tailscaleFallback,
    tailscaleAvailable: Boolean(state && companionPairingRoute(state, "tailscale")),
    pairingExpired: flow.pairingAttempted && !state?.pairing,
    setupTimedOut,
    setEmail: (next) => {
      emailEdited.current = true;
      setEmailState(next);
    },
    setCode: (next) => setCodeState(next.replaceAll(/\D/g, "").slice(0, 8)),
    changeEmail: () => {
      setCodeState("");
      setCodeSent(false);
      setAccountError(null);
    },
    start,
    useLocal,
    useTailscale,
    refreshTailscale,
    requestCode,
    verifyCode,
    retryAccount,
    retryRelay: () => loadRelay("ready"),
    cancel,
    refreshCode: () => afterPresence(() => {
      const generation = ++setupGeneration.current;
      void openPairing(pairingRouteMode, undefined, generation);
    }),
    finish: () => {
      presence.current = "none";
      const generation = setupGeneration.current;
      setupGeneration.current += 1;
      invalidatePhonePairingAttempt(pairingAttemptQueue.current, generation);
      releasePhonePairingAttempt(pairingUiOwner.current, generation);
      setPairingBusy(false);
      publishPairingRoutePin(null);
      setSetupTimedOut(false);
      dispatchFlow({ type: "reset" });
    },
    act,
    accountAct,
  };
}


export function phoneAccessStatus(state: CompanionState | null): string {
  if (!state) return t("common.checking");
  if (!state.enabled) return t("settings.w6.phone.off");
  return state.devices.length ? t("settings.w6.phone.paired", { count: state.devices.length }) : t("settings.w6.phone.on");
}

/** Settings' pairing rows: pair, sign in for the HTTPS route, wait, then the QR and its code. */
export function PhoneSetupFlowView({ controller }: { controller: PhoneSetupController }) {
  const c = controller;
  const actionError = companionAccountActionError(c.account, c.accountError);
  const canSubmitEmail = /^\S+@\S+\.\S+$/.test(c.email.trim());
  const manualCodeMode = phonePairingManualCodeMode(Boolean(c.state?.pairing), c.pairingLink);

  if (c.phase === "intro") {
    return (
      <>
        <FlowRow icon="bolt" title={t("settings.w6.phone.title")} detail={phoneAccessStatus(c.state)}>
          <button type="button" data-phone-pairing-action onClick={c.start} disabled={!c.state || c.busy || c.accountBusy} className="ui-button">
            {c.state?.devices.length ? t("settings.w6.phone.pairAnother") : t("settings.w6.phone.pair")}
          </button>
        </FlowRow>
        {c.error && <ErrorLine>{c.error}</ErrorLine>}
      </>
    );
  }

  if (c.relayPairing) return <RelayPairingRows onCancel={c.cancel} onDone={c.finish} />;

  if (c.phase === "sign-in" && !c.account?.available) return <AnywhereUnavailableRows c={c} />;

  if (c.phase === "sign-in") {
    const failed = c.account?.status === "error" || c.setupTimedOut;
    const problem = c.setupTimedOut
      ? t("phone.signIn.timedOut")
      : failed ? c.account?.message ?? t("phone.signIn.failed") : null;
    return (
      <>
        <FlowRow title={failed ? t("phone.signIn.attention") : t("phone.signIn.title")} detail={problem} alert={Boolean(c.setupTimedOut)}>
          {failed && (
            <button type="button" disabled={c.accountBusy} onClick={c.retryAccount} className="ui-button">
              {c.accountBusy ? t("remote.account.retrying") : t("phone.signIn.retry")}
            </button>
          )}
          <button type="button" onClick={c.cancel} className="ui-button">{t("phone.back")}</button>
        </FlowRow>
        {!failed && (
          <>
            <FlowRow title={<label htmlFor="phone-sign-in-email">{t("phone.signIn.email")}</label>}>
              <input
                id="phone-sign-in-email"
                autoFocus
                autoComplete="email"
                inputMode="email"
                value={c.email}
                disabled={c.accountBusy || c.codeSent}
                onChange={(event) => c.setEmail(event.target.value)}
                onKeyDown={(event) => { if (event.key === "Enter" && !c.codeSent && canSubmitEmail) c.requestCode(); }}
                placeholder="you@example.com"
                className={FIELD}
              />
              {c.codeSent
                ? <button type="button" disabled={c.accountBusy} onClick={c.changeEmail} className="ui-button">{t("settings.w6.phone.change")}</button>
                : <button type="button" disabled={c.accountBusy || !canSubmitEmail} onClick={c.requestCode} className="ui-button">{c.accountBusy ? t("phone.signIn.working") : t("settings.w6.phone.sendCode")}</button>}
            </FlowRow>
            {c.codeSent && (
              <FlowRow title={<label htmlFor="phone-sign-in-code">{t("settings.w6.phone.code")}</label>}>
                <input
                  id="phone-sign-in-code"
                  autoFocus
                  autoComplete="one-time-code"
                  inputMode="numeric"
                  value={c.code}
                  disabled={c.accountBusy}
                  onChange={(event) => c.setCode(event.target.value)}
                  onKeyDown={(event) => { if (event.key === "Enter" && c.code.length === 8) c.verifyCode(); }}
                  placeholder="12345678"
                  className={cn(FIELD, "font-mono tracking-[0.18em] placeholder:tracking-normal")}
                />
                <button type="button" disabled={c.accountBusy || c.code.length !== 8} onClick={c.verifyCode} className="ui-button">
                  {c.accountBusy ? t("phone.signIn.working") : t("settings.w6.phone.verify")}
                </button>
              </FlowRow>
            )}
          </>
        )}
        {actionError && <ErrorLine>{actionError}</ErrorLine>}
        <WifiRow c={c} />
      </>
    );
  }

  if (c.phase === "verifying") {
    return (
      <>
        <FlowRow
          title={<span className="inline-flex items-center gap-2"><Loader2 size={13} className="animate-spin text-ink-secondary" />
            {c.localFallback ? t("phone.verifying.local") : c.tailscaleFallback ? t("phone.verifying.tailscale") : t("phone.verifying.secure")}</span>}
        >
          <button type="button" onClick={c.cancel} className="ui-button">{t("common.cancel")}</button>
        </FlowRow>
        {(c.error || c.accountError) && <ErrorLine>{c.error ?? c.accountError}</ErrorLine>}
      </>
    );
  }

  if (c.phase === "success") {
    return (
      <FlowRow title={<span className="inline-flex items-center gap-2"><Check size={14} className="text-success" />{t("phone.success.title")}</span>}>
        <button type="button" onClick={c.finish} className="ui-button">{t("phone.success.done")}</button>
      </FlowRow>
    );
  }

  return (
    <>
      <FlowRow
        title={c.pairingExpired ? t("phone.code.expired") : t("settings.w6.phone.scan")}
        detail={!c.pairingExpired && manualCodeMode === "details" && c.state?.pairing ? t("phone.code.expiresIn", { seconds: c.secondsLeft }) : undefined}
      >
        {c.pairingExpired && <button type="button" onClick={c.refreshCode} className="ui-button">{t("settings.w6.phone.newCode")}</button>}
        <button type="button" onClick={c.cancel} className="ui-button">{t("common.cancel")}</button>
      </FlowRow>
      {!c.pairingExpired && c.pairingLink && (
        <div className="flex justify-center px-3.5 pb-3">
          <div className="rounded-[10px] bg-white p-3 outline outline-[0.5px] -outline-offset-[0.5px] outline-transparent" aria-label={t("phone.code.qrAria")}>
            <QRCodeSVG value={c.pairingLink} size={160} level="M" bgColor="#ffffff" fgColor="#111111" />
          </div>
        </div>
      )}
      {!c.pairingExpired && c.localFallback && c.state?.publicNetwork && (
        <p role="note" className="flex gap-2 px-3.5 pb-2.5 text-[13px] leading-[18px] text-ink-secondary">
          <AlertTriangle size={14} className="mt-0.5 shrink-0 text-warning" />{t("phone.code.publicNetwork", { network: c.state.publicNetwork })}
        </p>
      )}
      {!c.pairingExpired && c.state?.pairing && (
        <FlowRow title={t("phone.code.manual")}>
          <span className="font-mono text-[15px] tracking-[0.2em] text-ink">{c.state.pairing.code}</span>
        </FlowRow>
      )}
      {!c.pairingExpired && c.state?.pairing && c.address && (
        <ConnectionDetail label={t("phone.code.address")} value={c.addressText ?? `${c.address}:${c.pairingPort}`} />
      )}
    </>
  );
}


export { companionPairingMode };
