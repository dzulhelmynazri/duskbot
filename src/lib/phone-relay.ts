import { useCallback, useEffect, useRef, useState } from "react";

import { universalPairLink, type MobileDevice, type MobilePairingRequest, type MobilePairingResponse } from "../../shared/mobile-link";
import type { PhoneRelayState } from "../types/madaniDesktop";
import { companionBridge } from "./companion-bridge";
import { t } from "./i18n";
import { friendlyError } from "./plain-error";
import { api } from "@/state/store";

export const phoneRelayBridge = () =>
  (typeof window === "undefined" ? undefined : window.madaniDesktop?.phoneRelay) ?? null;

/** a pairing code from this computer reaches it from any network: its relay is up, or comes up when asked */
export const relayPairingUsable = (relay: PhoneRelayState | null): boolean =>
  relay !== null && relay.status !== "signed-out" && relay.status !== "error";

/** why pairing from anywhere is not on offer, or null when it is (or this build has no relay) */
export function relayUnavailableMessage(relay: PhoneRelayState | null): string | null {
  if (relay?.status === "signed-out") return t("phone.relay.signIn");
  if (relay?.status === "error" && relay.code === "tunnel_limit") return t("phone.relay.tunnelLimit");
  if (relay?.status === "error") return t("phone.relay.failed", { reason: relay.message ?? t("phone.relay.unreachable") });
  return null;
}

/** asks the relay to come up before a code is made, so the code carries it; never fails the pairing */
export async function relayBeforePairing(): Promise<PhoneRelayState | null> {
  try {
    return (await phoneRelayBridge()?.ready()) ?? null;
  } catch {
    return null;
  }
}

export interface RelayOffer { qr: string; code: string | null; expiresAt: number; anywhere: boolean }

/** the code to scan, made by this workspace's own phone pairing (shared/mobile-link.ts) with the relay and wi-fi routes */
export async function mintRelayOffer(): Promise<RelayOffer> {
  const request: MobilePairingRequest = {};
  const companion = companionBridge();
  if (companion) {
    try { request.companion = (await companion.start()).endpoints; } catch {}
  }
  await relayBeforePairing();
  const body = await api<MobilePairingResponse>("/api/mobile/pairing", { method: "POST", body: JSON.stringify(request) });
  return { qr: universalPairLink(body.link, body.code), code: body.code, expiresAt: body.expiresAt, anywhere: body.payload.via.some((route) => route.kind === "relay") };
}

export function newPhone(baseline: readonly string[], devices: readonly MobileDevice[]): MobileDevice | null {
  const known = new Set(baseline);
  return devices.find((device) => !known.has(device.id)) ?? null;
}

const POLL_MS = 2_000;

/** the relay pairing's code while `active`: made once, renewed on request, and the phone that used it once one did */
export function useRelayPairing(active: boolean) {
  const [offer, setOffer] = useState<RelayOffer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [paired, setPaired] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const generation = useRef(0);
  const baseline = useRef<string[] | null>(null);

  const mint = useCallback(async () => {
    const epoch = ++generation.current;
    setOffer(null);
    setError(null);
    try {
      const { devices } = await api<{ devices: MobileDevice[] }>("/api/mobile/devices");
      baseline.current = devices.map((device) => device.id);
      const next = await mintRelayOffer();
      if (generation.current === epoch) { setOffer(next); setNow(Date.now()); }
    } catch (cause) {
      if (generation.current === epoch) setError(friendlyError(cause, t("settings.mobile.error")));
    }
  }, []);

  useEffect(() => {
    if (!active) { generation.current += 1; setOffer(null); setError(null); setPaired(null); baseline.current = null; return; }
    void mint();
  }, [active, mint]);

  useEffect(() => {
    if (!active || !offer || paired) return;
    const epoch = generation.current;
    const timer = window.setInterval(() => {
      setNow(Date.now());
      void api<{ devices: MobileDevice[] }>("/api/mobile/devices").then(({ devices }) => {
        const phone = baseline.current && generation.current === epoch ? newPhone(baseline.current, devices) : null;
        if (phone) setPaired(phone.name);
      }).catch(() => {});
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [active, offer, paired]);

  const secondsLeft = offer ? Math.max(0, Math.round((offer.expiresAt - now) / 1000)) : 0;
  return { offer, error, paired, secondsLeft, expired: Boolean(offer) && secondsLeft === 0, renew: mint };
}
