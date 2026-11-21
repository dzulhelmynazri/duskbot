import { useState } from "react";
import { useStore } from "@/state/store";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/cn";
import { removePlace, usePlaces, type RailPlace } from "@/lib/places";
import { thisComputerPage, vpsLinkAvailable } from "@/lib/vps-link";
import { openCloudMove } from "@/lib/cloud-move";
import { desktopShowsOtherServer } from "@/lib/other-server";
import { useVpsCloudMove } from "@/lib/vps-cloud-move";
import { Trash2 } from "../icons";
import { CloudMoveRow } from "./CloudMoveSettings";
import { askConfirm } from "./ConfirmDialog";
import { useWorkspacePlace } from "./DesktopWorkspaceSwitcher";
import { NavRow, NoteRow } from "./ListRows";
import { Icon } from "./Icon";
import { PixelIcon, type PixelIconName } from "./ui/PixelIcon";
import type { SettingGlyphName } from "./ui/SettingGlyph";
import { SettingsGroup, SettingsRows } from "./SettingsPrimitives";

type Health = "online" | "offline" | "problem" | "setting-up";

export function placeHealth(place: Pick<RailPlace, "ended" | "waiting" | "offline" | "opens" | "progress">): Health {
  if (place.ended || place.waiting) return "problem";
  if (place.progress !== undefined && place.progress < 1) return "setting-up";
  if (place.offline || !place.opens) return "offline";
  return "online";
}

export const DOT: Record<Health, string> = {
  online: "bg-success",
  problem: "bg-danger",
  offline: "bg-ink/25",
  "setting-up": "bg-ink/25",
};

export const HEALTH_WORD: Record<Health, "settings.docs.ws.online" | "settings.docs.ws.offline" | "settings.docs.ws.problem" | "settings.docs.ws.settingUp"> = {
  online: "settings.docs.ws.online",
  offline: "settings.docs.ws.offline",
  problem: "settings.docs.ws.problem",
  "setting-up": "settings.docs.ws.settingUp",
};

export function kindWord(kind: RailPlace["kind"]): string {
  if (kind === "computer") return window.madaniDesktop?.platform === "darwin" ? t("settings.docs.ws.thisMac") : t("settings.docs.ws.thisComputer");
  if (kind === "cloud") return t("settings.docs.ws.cloud");
  if (kind === "team") return t("settings.docs.ws.team");
  return t("settings.docs.ws.server");
}

export const KIND_ICON: Record<RailPlace["kind"], PixelIconName & SettingGlyphName> = { computer: "laptop", server: "server", cloud: "cloud", team: "team", account: "cloud" };

/** What a place is, from the window's own word for it when there is no list of places to read: a Cloud that is home,
 * this computer's own data, a team's Cloud (it carries a role), or else a server connected by hand. */
export function currentKind(current: { local?: boolean; home?: boolean; role?: string } | null): RailPlace["kind"] {
  if (current?.home) return "cloud";
  if (!current || current.local) return "computer";
  return current.role ? "team" : "server";
}

/** One workspace: a status dot in the row's leading slot, its name and what it is, then the remove button and "current"
 * or the switch pill, flush with the other rows' chevrons. */
function WorkspaceRow({ place, onOpen, onRemove, busy }: { place: RailPlace; onOpen: () => void; onRemove?: () => void; busy: boolean }) {
  const health = placeHealth(place);
  const current = place.active === true;
  const kind = kindWord(place.kind);
  const hint = place.name === kind ? t(HEALTH_WORD[health]) : `${kind} · ${t(HEALTH_WORD[health])}`;
  const body = (
    <>
      <span aria-hidden="true" className="relative flex size-6 shrink-0 items-center justify-center">
        <PixelIcon name={KIND_ICON[place.kind]} size={24} />
        <span data-workspace-dot={health} className={cn("absolute -bottom-0.5 -right-0.5 size-2 rounded-full ring-2 ring-app", DOT[health])} />
      </span>
      <span className="min-w-0 flex-1">
        <span data-row-title="" className="block truncate text-[13px] leading-[18px] text-ink">{place.name}</span>
        <span data-row-hint="" className="block truncate text-[12px] leading-4 text-ink-secondary">{hint}</span>
      </span>
    </>
  );
  const status = current
    ? <span data-workspace-current="" className="flex h-7 shrink-0 items-center gap-1 ps-2.5 text-[12px] leading-4 text-ink"><Icon name="check" size={12} />{t("connectedWorkspaces.current")}</span>
    : <span aria-hidden="true" className="flex h-7 shrink-0 items-center rounded-full bg-ink/[0.06] px-2.5 text-[12px] leading-4 text-ink">{t("connectedWorkspaces.switch")}</span>;
  return (
    <div data-workspace={place.kind} data-workspace-health={health} className="relative flex min-w-0 items-center gap-4">
      {current
        ? <div className="flex min-w-0 flex-1 items-center gap-4" aria-current="true">{body}</div>
        : <button type="button" disabled={busy || !place.opens} onClick={onOpen} aria-label={t("settings.s2.servers.switchTo", { name: place.name })}
            className="flex min-w-0 flex-1 cursor-pointer items-center gap-4 text-start outline-none after:absolute after:inset-0 after:rounded-[12px] focus-visible:after:outline-2 focus-visible:after:-outline-offset-2 focus-visible:after:outline-focus disabled:cursor-default disabled:opacity-60">
            {body}
          </button>}
      {onRemove && !current && (
        <button type="button" disabled={busy} onClick={onRemove} aria-label={t("settings.s2.servers.forget", { name: place.name })} title={t("settings.s2.servers.forget", { name: place.name })}
          className="relative z-10 -my-1 flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-full text-ink-secondary outline-none hover:bg-ink/[0.06] hover:text-danger focus-visible:outline-2 focus-visible:outline-focus disabled:opacity-45">
          <Trash2 size={13} aria-hidden="true" />
        </button>
      )}
      {status}
    </div>
  );
}

/** Settings → Computer's first group: every workspace the bots can live in, with the current one marked and one click to
 * switch, then moving to madani cloud (or getting one) and adding another (only on this computer's own page, never in a
 * madani cloud or server window). */
export function WorkspacesGroup({ onAdd }: { onAdd: () => void }) {
  const { state, dispatch } = useStore();
  const rail = usePlaces();
  const here = useWorkspacePlace({ cloudHome: state.config?.cloudHome === true });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const mine = rail.places[0]?.group;
  const listed = rail.places.filter((place) => place.kind !== "account" && place.group === mine);
  const places: RailPlace[] = listed.length ? listed : [{
    id: "local", name: here.current?.name || kindWord(currentKind(here.current)), color: null, opens: true, active: true,
    kind: currentKind(here.current),
  }];
  const hasCloud = places.some((place) => place.kind === "cloud" || place.kind === "team");
  const canBuy = Boolean(window.madaniDesktop?.cloudAccount) && window.madaniDesktop?.remoteClient?.active !== true;
  // a server of the person's own on screen: main answers the move's view only there, so an answer means it can move
  const serverMove = useVpsCloudMove(desktopShowsOtherServer() && state.config?.cloudHome !== true).view;
  const moveServer = () => { dispatch({ type: "toggleSettings", open: false }); openCloudMove("cloud"); };

  const open = (place: RailPlace) => {
    const bridge = window.madaniDesktop?.workspaces;
    if (!bridge?.open || busy) return;
    setBusy(true); setError("");
    void bridge.open(place.id).catch(() => setError(t("connectedWorkspaces.switchError"))).finally(() => setBusy(false));
  };
  const remove = async (place: RailPlace) => {
    if (busy || !await askConfirm({ art: <PixelIcon name={KIND_ICON[place.kind]} size={28} />, title: t("settings.docs.ws.removeTitle", { name: place.name }), body: t("settings.docs.ws.removeBody"), confirmLabel: t("confirm.remove"), tone: "neutral" })) return;
    setBusy(true); setError("");
    const outcome = await removePlace(place.id);
    if (outcome !== "removed" && outcome !== "gone") setError(t("settings.docs.ws.removeFailed", { name: place.name }));
    setBusy(false);
  };

  return (
    <SettingsGroup label={t("settings.docs.ws.title")} hint={t("settings.docs.ws.hint")} block="workspaces">
      <SettingsRows>
        {places.map((place) => (
          <WorkspaceRow key={place.id} place={place} busy={busy} onOpen={() => open(place)}
            onRemove={place.removable ? () => void remove(place) : undefined} />
        ))}
        <CloudMoveRow otherwise={!hasCloud && canBuy
          ? <NavRow data-settings-open="get-cloud" pixel={<PixelIcon name="cloud" size={24} />} title={t("settings.docs.ws.getCloud")} hint={t("settings.docs.ws.getCloudHint")}
              onClick={() => dispatch({ type: "openCloudAdd", source: "app_settings" })} />
          : serverMove ? <NavRow data-settings-open="server-cloud-move" pixel={<PixelIcon name="cloud" size={24} />} title={t("vpsMove.title")} hint={t("vpsMove.perk.server")} onClick={moveServer} />
          : null} />
        {thisComputerPage() && <NavRow data-settings-open="add-workspace" pixel={<PixelIcon name="plus" size={24} />} title={t("settings.docs.ws.add")} hint={t("settings.docs.ws.addHint")} onClick={onAdd} />}
        {(error || here.error) && <NoteRow tone="danger">{error || here.error}</NoteRow>}
      </SettingsRows>
    </SettingsGroup>
  );
}

/** Installing madani on a server of one's own, in three short steps; the line itself comes from the add-a-VPS flow, which
 * makes a fresh one each time and watches for the server to answer. */
export function InstallOnVpsGroup({ onStart }: { onStart: () => void }) {
  if (!vpsLinkAvailable()) return null;
  const steps = ["settings.docs.vps.step1", "settings.docs.vps.step2", "settings.docs.vps.step3"] as const;
  return (
    <SettingsGroup label={t("settings.docs.vps.title")} block="install-vps">
      <div className="flex flex-col gap-3 px-2.5">
        <ol className="m-0 flex list-none flex-col gap-2 p-0">
          {steps.map((step, index) => (
            <li key={step} className="flex items-start gap-3 text-[13px] leading-[19px] text-ink">
              <span aria-hidden="true" className="flex size-5 shrink-0 items-center justify-center rounded-full bg-ink/[0.06] text-[11px] font-semibold tabular-nums text-ink-secondary">{index + 1}</span>
              <span className="min-w-0">{t(step)}</span>
            </li>
          ))}
        </ol>
        <div>
          <button type="button" data-settings-open="install-vps" className="ui-button ui-button-primary" onClick={onStart}>{t("settings.docs.vps.cta")}</button>
        </div>
      </div>
    </SettingsGroup>
  );
}
