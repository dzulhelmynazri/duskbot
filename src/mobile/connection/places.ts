import { useCallback, useEffect, useRef, useState } from "react";
import type { MobileConnectionRecord } from "../../../shared/mobile-link";
import { useMobileAccount } from "../account/AccountGate";
import { usePlatform } from "../platform";
import type { AccountPlaces, CloudPairGrant, CloudPairResult, ComputerPairResult, MobileCloud, MobileComputer, MobileTeamCloud } from "../account/account-client";
import { cloudPairing } from "../account/cloud-pair";
import { useConnections } from "./connections";

export type PlaceStatus = "online" | "asleep" | "offline";
/** `accountId`: the phone's other signed-in account the place is reached through; the account in use without it */
export type PlaceTarget = { kind: "linked"; id: string } | { kind: "cloud"; cloud: MobileCloud; accountId?: string } | { kind: "team"; cloud: MobileTeamCloud; accountId?: string }
  | { kind: "computer"; computer: MobileComputer; accountId?: string };
export type PlaceOutcome = CloudPairResult["outcome"] | ComputerPairResult["outcome"] | "switched";
export type Place = { key: string; name: string; status: PlaceStatus; active: boolean; target: PlaceTarget };

const GONE = new Set(["ended", "checkout", "destroyed"]);

function cloudStatus(cloud: { status: string; asleep: boolean }): PlaceStatus {
  if (cloud.status === "ready") return cloud.asleep ? "asleep" : "online";
  return cloud.status === "stopped" ? "asleep" : "offline";
}

function recordOrigins(record: Pick<MobileConnectionRecord, "origin" | "via">): string[] {
  const origins = [record.origin, ...(record.via ?? []).map((route) => (route.kind === "https" ? route.url : undefined))];
  return origins.filter((origin): origin is string => Boolean(origin));
}

/** another account signed in on the phone, with what it lists */
export type OtherAccountPlaces = { accountId: string; places: AccountPlaces };
type Owned<T> = T & { accountId?: string };

/** Everything the person can open from this phone: the places it already links to, then the clouds, teams' clouds and
 * computers of the account in use and of the phone's other accounts that it does not link to yet. A linked place an
 * account also lists shows once, with that account's status. */
export function mergePlaces({ records, activeId, connected, account, others = [] }: {
  records: readonly MobileConnectionRecord[];
  activeId: string | null;
  connected: boolean;
  account: AccountPlaces | null;
  others?: readonly OtherAccountPlaces[];
}): Place[] {
  const lists: { accountId?: string; places: AccountPlaces | null }[] = [{ places: account }, ...others];
  const owned = <T,>(pick: (places: AccountPlaces) => T[]): Owned<T>[] =>
    lists.flatMap(({ accountId, places }) => (places ? pick(places).map((item): Owned<T> => Object.assign({}, item, accountId ? { accountId } : {})) : []));
  const unique = <T extends { id: string }>(items: Owned<T>[]) => items.filter((item, index) => items.findIndex((other) => other.id === item.id) === index);
  const clouds = unique(owned((places) => places.clouds)).filter((cloud) => !GONE.has(cloud.status));
  const teams = unique(owned((places) => places.teams));
  const computers = unique(owned((places) => places.computers));
  const claimed = new Set<string>();
  const linked = records.map((record): Place => {
    const origins = recordOrigins(record);
    const match = [...clouds, ...teams].find((cloud) => cloud.origin && origins.includes(cloud.origin));
    const computer = match ? undefined : computers.find((one) => one.environmentId !== null && one.environmentId === record.environmentId);
    if (match) claimed.add(match.id);
    if (computer) claimed.add(computer.id);
    const active = record.id === activeId;
    const status: PlaceStatus = active && connected ? "online" : match ? cloudStatus(match) : computer ? computer.presence : "offline";
    return { key: `linked:${record.id}`, name: record.label.trim() || match?.name || computer?.name || record.label, status, active, target: { kind: "linked", id: record.id } };
  });
  const by = (accountId?: string) => (accountId ? { accountId } : {});
  const own = clouds.filter((cloud) => !claimed.has(cloud.id)).map(({ accountId, ...cloud }): Place => ({ key: `cloud:${cloud.id}`, name: cloud.name, status: cloudStatus(cloud), active: false, target: { kind: "cloud", cloud, ...by(accountId) } }));
  const team = teams.filter((cloud) => !claimed.has(cloud.id)).map(({ accountId, ...cloud }): Place => ({ key: `team:${cloud.id}`, name: cloud.name, status: cloudStatus(cloud), active: false, target: { kind: "team", cloud, ...by(accountId) } }));
  const machines = computers.filter((one) => !claimed.has(one.id)).map(({ accountId, ...computer }): Place => ({ key: `computer:${computer.id}`, name: computer.name, status: computer.presence, active: false, target: { kind: "computer", computer, ...by(accountId) } }));
  return [...linked, ...own, ...team, ...machines];
}

/** what the pairing step reads as a typed link: the cloud's address and its one-time code */
export const pairingText = (grant: CloudPairGrant) => `${grant.origin} ${grant.code.replace(/-/g, "")}`;

const seen = new Map<string, AccountPlaces>();
const OTHERS_KEY = "others:";
const COUNT_KEY = "madani.mobile.places.count";

/** The places list for Settings: null until both the saved links and the account's answer are in, so the rows draw once
 * at their final size. The last answer per account is kept for the session, so reopening Settings draws at once, and the
 * last row count is kept on the phone, so the skeleton holds the same height. */
export function usePlaces(connected: boolean): { places: Place[] | null; expected: number; open(place: Place): Promise<PlaceOutcome> } {
  const { connections, activeId, loaded, switchTo } = useConnections();
  const platform = usePlatform();
  const [remembered, setRemembered] = useState(0);
  useEffect(() => { void platform.prefs.get(COUNT_KEY).then((value) => setRemembered(Number(value) || 0)).catch(() => {}); }, [platform]);
  const account = useMobileAccount();
  const accountRef = useRef(account);
  accountRef.current = account;
  const accountId = account?.account?.id ?? null;
  const otherIds = (account?.accounts ?? []).map((one) => one.id).filter((id) => id !== accountId).join(",");
  const [remote, setRemote] = useState<AccountPlaces | null | undefined>(() => (accountId ? seen.get(accountId) : null));
  const [others, setOthers] = useState<OtherAccountPlaces[]>([]);
  useEffect(() => {
    const client = accountRef.current;
    if (!accountId || !client) { setRemote(null); return; }
    let live = true;
    setRemote(seen.get(accountId));
    void client.places().then((answer) => {
      if (!live) return;
      if (answer) seen.set(accountId, answer);
      setRemote(answer ?? seen.get(accountId) ?? null);
    });
    return () => { live = false; };
  }, [accountId]);
  useEffect(() => {
    const client = accountRef.current;
    const ids = otherIds ? otherIds.split(",") : [];
    if (!client || ids.length === 0) { setOthers([]); return; }
    let live = true;
    const kept = (id: string) => seen.get(`${OTHERS_KEY}${id}`);
    setOthers(ids.flatMap((id) => { const places = kept(id); return places ? [{ accountId: id, places }] : []; }));
    void Promise.all(ids.map(async (id) => {
      const places = await client.places(id).catch(() => null);
      if (places) seen.set(`${OTHERS_KEY}${id}`, places);
      const known = places ?? kept(id);
      return known ? [{ accountId: id, places: known }] : [];
    })).then((answers) => { if (live) setOthers(answers.flat()); });
    return () => { live = false; };
  }, [otherIds]);
  const places = loaded && remote !== undefined ? mergePlaces({ records: connections, activeId, connected, account: remote, others }) : null;
  const count = places?.length;
  useEffect(() => { if (count !== undefined) void platform.prefs.set(COUNT_KEY, String(count)).catch(() => {}); }, [platform, count]);
  const open = useCallback(async (place: Place): Promise<PlaceOutcome> => {
    const { target } = place;
    if (target.kind === "linked") { await switchTo(target.id); return "switched"; }
    const client = accountRef.current;
    if (!client) return "signed-out";
    // the place's account is in use when it links, so the link is kept as that account's
    if (target.accountId && !(await client.switchAccount(target.accountId))) return "signed-out";
    if (target.kind === "computer") {
      const result = await client.pairComputer(target.computer, target.accountId);
      if (result.outcome === "paired") window.dispatchEvent(new CustomEvent("madani:pair-link", { detail: result.link }));
      return result.outcome;
    }
    const pairing = { pairCloud: (cloud: MobileCloud) => client.pairCloud(cloud, target.accountId), wakeCloud: () => client.wakeCloud(target.accountId) };
    const result = target.kind === "cloud" ? await cloudPairing(pairing, target.cloud) : await client.pairTeamCloud(target.cloud, target.accountId);
    if (result.outcome === "paired") window.dispatchEvent(new CustomEvent("madani:pair-link", { detail: pairingText(result.grant) }));
    return result.outcome;
  }, [switchTo]);
  return { places, expected: remembered || connections.length, open };
}
