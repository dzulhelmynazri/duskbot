import { useEffect, useRef, useState } from "react";
import { ChevronRight, Cloud, Laptop, RotateCw } from "../../icons";
import { LoadingMascot } from "../Illustration";
import { t } from "@/lib/i18n";
import type { TypedPairing } from "../connection/pair";
import { haptic } from "../haptics";
import { ErrorLine } from "../onboarding/parts";
import { useMobileAccount } from "./AccountGate";
import type { AccountPlaces, CloudPairResult, ComputerPairResult, MobileCloud, MobileComputer, MobileTeamCloud } from "./account-client";
import { cloudPairing, cloudPairingPayload } from "./cloud-pair";
import { useConnections } from "../connection/connections";
import type { MobileConnectionRecord } from "../../../shared/mobile-link";

type Outcome = CloudPairResult["outcome"] | ComputerPairResult["outcome"];
type Problem = { outcome: Exclude<Outcome, "paired">; name: string };
type Target = { kind: "cloud"; cloud: MobileCloud } | { kind: "team"; cloud: MobileTeamCloud } | { kind: "computer"; computer: MobileComputer };

/** an asleep cloud is woken by the tap that opens it, so it reads as ready like any other */
function statusLine(cloud: Pick<MobileCloud, "status">): string {
  if (cloud.status === "ready" || cloud.status === "offline") return t("mobile.clouds.ready");
  if (cloud.status === "setting_up") return t("mobile.clouds.settingUp");
  return t("mobile.clouds.stopped");
}

const PRESENCE = { online: "mobile.settings.placeOnline", asleep: "mobile.settings.placeAsleep", offline: "mobile.settings.placeOffline" } as const;

export const pairable = (cloud: Pick<MobileCloud, "origin" | "status">) => Boolean(cloud.origin) && (cloud.status === "ready" || cloud.status === "offline");

type SavedLink = Pick<MobileConnectionRecord, "origin" | "via">;

/** a cloud this phone already links to, by any of the saved links' addresses */
export function linkedHere(cloud: Pick<MobileCloud, "origin">, records: readonly SavedLink[]): boolean {
  return Boolean(cloud.origin) && records.some((record) => record.origin === cloud.origin || (record.via ?? []).some((route) => route.kind === "https" && route.url === cloud.origin));
}

/** the one cloud to open without asking: only on a phone that links nothing yet */
export function autoPickCloud(clouds: readonly MobileCloud[], records: readonly SavedLink[]): MobileCloud | null {
  const ready = clouds.filter((cloud) => pairable(cloud) && !linkedHere(cloud, records));
  return ready.length === 1 && records.length === 0 ? ready[0]! : null;
}

/** The cloud a QR or link asked for: the one at its address, else the account's only cloud; a link the phone already
 * keeps for it, or the cloud to pair. Null when it cannot tell which, so the person picks. */
export function targetCloud(places: AccountPlaces, records: readonly MobileConnectionRecord[], origin: string | null):
  MobileConnectionRecord | Extract<Target, { kind: "cloud" | "team" }> | null {
  const all = [...places.clouds.map((cloud) => ({ kind: "cloud" as const, cloud })), ...places.teams.map((cloud) => ({ kind: "team" as const, cloud }))];
  const candidates = origin ? all.filter((entry) => entry.cloud.origin === origin) : all.filter((entry) => entry.cloud.origin);
  if (candidates.length !== 1) return null;
  const one = candidates[0]!;
  const kept = records.find((record) => linkedHere(one.cloud, [record]));
  if (kept) return kept;
  return pairable(one.cloud) ? one : null;
}

/** Everything the account has to open on this phone, in the order the picker lists it: its own clouds, its teams' clouds,
 * then its computers. */
export function pickerRows(places: AccountPlaces, records: readonly Pick<MobileConnectionRecord, "origin" | "via" | "environmentId">[]): Array<{ target: Target; key: string; name: string; status: string; here: boolean; can: boolean }> {
  const cloudRow = (target: Extract<Target, { kind: "cloud" | "team" }>) => {
    const here = linkedHere(target.cloud, records);
    return { target, key: `${target.kind}:${target.cloud.id}`, name: target.cloud.name, status: statusLine(target.cloud), here, can: pairable(target.cloud) && !here };
  };
  const computers = places.computers.map((computer) => {
    const here = computer.environmentId !== null && records.some((record) => record.environmentId === computer.environmentId);
    return { target: { kind: "computer" as const, computer }, key: `computer:${computer.id}`, name: computer.name, status: t(PRESENCE[computer.presence]), here, can: computer.presence === "online" && !here };
  });
  return [...places.clouds.map((cloud) => cloudRow({ kind: "cloud", cloud })), ...places.teams.map((cloud) => cloudRow({ kind: "team", cloud })), ...computers];
}

/** The signed-in account's clouds and computers: one tap pairs this phone with one, and with `autoPick` a single cloud
 * pairs on its own. */
export function CloudPicker({ busy, onPairing, autoPick = false, target = null, onOpen, onNone, onComputers }: {
  busy: boolean;
  /** a madani cloud's QR or link logged in: its cloud (by address), else the account's only one, opens without a pick */
  target?: { origin: string | null } | null;
  /** a cloud this phone already links, opened as it is */
  onOpen?(id: string): void;
  /** a cloud's pairing, or a computer's pairing link */
  onPairing(payload: TypedPairing | string): Promise<void>;
  autoPick?: boolean;
  /** the list came back empty */
  onNone?(): void;
  /** the list holds computers, not only clouds */
  onComputers?(some: boolean): void;
}) {
  const account = useMobileAccount();
  const signedIn = Boolean(account?.account);
  const { connections, loaded } = useConnections();
  const [places, setPlaces] = useState<AccountPlaces | null | undefined>(undefined);
  const [working, setWorking] = useState<string | null>(null);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [reload, setReload] = useState(0);
  const abort = useRef<AbortController | null>(null);
  const picked = useRef(false);

  useEffect(() => {
    if (!signedIn || !account) return;
    let active = true;
    setPlaces(undefined);
    void account.places().then((list) => { if (active) setPlaces(list); });
    return () => { active = false; };
  }, [account, signedIn, reload]);
  useEffect(() => () => abort.current?.abort(), []);

  const pick = async (target: Target, key: string, name: string) => {
    if (!account || working || busy) return;
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    setProblem(null);
    setWorking(key);
    try {
      const result = target.kind === "cloud" ? await cloudPairing(account, target.cloud, { signal: controller.signal })
        : target.kind === "team" ? await account.pairTeamCloud(target.cloud) : await account.pairComputer(target.computer);
      if (controller.signal.aborted) return;
      if (result.outcome !== "paired") { haptic("error"); setProblem({ outcome: result.outcome, name }); return; }
      await onPairing("link" in result ? result.link : cloudPairingPayload(target.kind === "computer" ? { name } : target.cloud, result.grant));
    } finally {
      if (abort.current === controller) setWorking(null);
    }
  };

  const empty = places ? places.clouds.length + places.teams.length + places.computers.length === 0 : false;
  useEffect(() => {
    if (!places || !loaded) return;
    onComputers?.(places.computers.length > 0);
    if (empty) { onNone?.(); return; }
    const wanted = target && !picked.current ? targetCloud(places, connections, target.origin) : null;
    if (wanted) {
      picked.current = true;
      if ("id" in wanted) onOpen?.(wanted.id);
      else void pick(wanted, `${wanted.kind}:${wanted.cloud.id}`, wanted.cloud.name);
      return;
    }
    const only = autoPick && !picked.current ? autoPickCloud(places.clouds, connections) : null;
    if (only) { picked.current = true; void pick({ kind: "cloud", cloud: only }, `cloud:${only.id}`, only.name); }
  }, [places, loaded]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!signedIn || !account || empty) return null;
  const rows = places ? pickerRows(places, connections) : [];
  const title = t(places?.computers.length ? "mobile.clouds.placesTitle" : "mobile.clouds.title");

  return (
    <section aria-label={title} data-testid="mobile-cloud-picker" className="mt-7 w-full text-left">
      <h2 className="mb-2 px-1 text-[15px] font-semibold text-ink-secondary">{title}</h2>
      {places === undefined && <p role="status" className="flex min-h-16 items-center gap-2.5 rounded-[18px] bg-ink/[0.04] px-4 text-[16px] text-ink-secondary"><LoadingMascot size={24} />{t("mobile.clouds.loading")}</p>}
      {places === null && (
        <ErrorLine action={<button type="button" onClick={() => setReload((n) => n + 1)} className="mobile-press mt-1 flex min-h-11 items-center gap-1.5 font-semibold text-ink"><RotateCw size={15} />{t("mobile.onboarding.retry")}</button>}>
          {t("mobile.clouds.loadFailed")}
        </ErrorLine>
      )}
      {rows.length > 0 && (
        <ul className="flex flex-col gap-2">
          {rows.map(({ target, key, name, status, here, can }) => {
            const mine = working === key;
            const Icon = target.kind === "computer" ? Laptop : Cloud;
            return (
              <li key={key}>
                <button type="button" data-testid="mobile-cloud-connect" data-place-kind={target.kind} disabled={busy || Boolean(working) || !can}
                  aria-label={t("mobile.clouds.connect", { name })} aria-busy={mine || undefined} onClick={() => void pick(target, key, name)}
                  className="mobile-press flex min-h-16 w-full items-center gap-3 rounded-[18px] bg-ink/[0.05] px-4 py-3 text-left text-ink disabled:opacity-100">
                  <Icon size={22} className={can ? "text-ink" : "text-ink-tertiary"} />
                  <span className="min-w-0 flex-1">
                    <span className={`block truncate text-[17px] font-semibold ${can ? "" : "text-ink-secondary"}`}>{name}</span>
                    <span className="mt-0.5 block text-[14px] text-ink-secondary">{mine ? t("mobile.clouds.connecting") : here ? t("mobile.clouds.linked") : status}</span>
                  </span>
                  {mine ? <LoadingMascot size={24} /> : can && <ChevronRight size={18} className="text-ink-tertiary" />}
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {problem && <ErrorLine>{t(`mobile.clouds.err.${problem.outcome}` as Parameters<typeof t>[0], { name: problem.name })}</ErrorLine>}
    </section>
  );
}
