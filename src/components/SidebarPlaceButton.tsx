import { useEffect, useState } from "react";

import { cloudAsleep, cloudPaused, onCloudPower } from "@/lib/cloud-power";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { useStore } from "@/state/store";

import { endCloudHowTo, openServerMenu, useWorkspacePlace } from "./DesktopWorkspaceSwitcher";
import { Icon } from "./Icon";
import { RECONNECTING_AFTER_MS } from "./LiveConnectionStrip";
import { SIMPLE_TOP_BUTTON } from "./SidebarSimpleTop";

export type PlaceKind = "computer" | "cloud" | "server";
export type PlaceStatus = "online" | "asleep" | "offline";

export function placeKind(current: { local: boolean; home?: boolean; role?: string } | null, { cloudHome = false, team = false } = {}): PlaceKind {
  if (current?.local !== false) return cloudHome && !current ? "cloud" : "computer";
  return cloudHome || team || current.home || current.role ? "cloud" : "server";
}

const ICON = { computer: "laptop", cloud: "cloud", server: "server" } as const;
const DOT = { online: "bg-success", asleep: "bg-ink-tertiary", offline: "bg-danger" } as const;
const WORD = { online: "slack.state.online", asleep: "runsOn.status.asleep", offline: "runsOn.status.offline" } as const;

const DOT_SEEN = "madani-place-dot-seen";
/** The green "online" dot shows until the person has opened the list of places once; a grey or red one always shows. */
export function placeDotSeen(): boolean {
  try { return localStorage.getItem(DOT_SEEN) === "1"; } catch { return false; }
}
function markPlaceDotSeen(): void {
  try { localStorage.setItem(DOT_SEEN, "1"); } catch { /* storage off: seen for this page only */ }
}

export function usePlaceStatus(waking: boolean): PlaceStatus {
  const { state } = useStore();
  const [paused, setPaused] = useState(cloudPaused);
  const [late, setLate] = useState(false);
  const [network, setNetwork] = useState(() => typeof navigator === "undefined" || navigator.onLine !== false);
  useEffect(() => onCloudPower(() => setPaused(cloudPaused())), []);
  useEffect(() => {
    const on = () => setNetwork(true), off = () => setNetwork(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => { window.removeEventListener("online", on); window.removeEventListener("offline", off); };
  }, []);
  const down = state.hydrated === true && !state.connected;
  useEffect(() => {
    setLate(false);
    if (!down) return;
    const timer = setTimeout(() => setLate(true), RECONNECTING_AFTER_MS);
    return () => clearTimeout(timer);
  }, [down]);
  // only the owner's own pause reads as asleep; a sleep we chose to save cost reads live, and its wake is quiet
  if (paused) return "asleep";
  if (waking) return "online";
  return !network || (down && late && !cloudAsleep()) ? "offline" : "online";
}

export function switchPlaceCommand(): (() => void) | null {
  const bridge = typeof window === "undefined" ? undefined : window.madaniDesktop?.workspaces;
  return bridge ? () => void openServerMenu(bridge).catch(() => {}) : null;
}

/** Security: the list of places is main's native menu; this page, which a server connected by hand may have written,
 * learns only the place it is on (cloud-rail.mjs). */
export function SidebarPlaceButton() {
  const { state, dispatch } = useStore();
  const cloudHome = state.config?.cloudHome === true;
  const place = useWorkspacePlace({ cloudHome, howTo: state.cloudHowTo, onMenuClosed: () => endCloudHowTo(dispatch) });
  const status = usePlaceStatus(place.waking !== "");
  const [seen, setSeen] = useState(placeDotSeen);
  if (!place.bridge) return null;
  const openMenu = () => { if (!seen) { markPlaceDotSeen(); setSeen(true); } place.openMenu(); };
  const dot = status !== "online" || !seen;
  const kind = placeKind(place.current, { cloudHome, team: Boolean(state.config?.team) });
  const name = place.current?.name ?? (cloudHome ? state.config?.team?.name || t("cloudSetup.myCloud") : t("rail.thisComputer"));
  const said = `${name} · ${t(WORD[status])}${place.onLine ? ` · ${place.onLine}` : ""}`;
  const button = <div data-sidebar-place className="relative flex">
    <button type="button" data-tour="server-switcher" data-place-kind={kind} data-place-status={status}
      aria-label={t("sidebar.switchServer", { name: said })} aria-haspopup="menu" aria-expanded={place.open}
      title={place.current?.origin ? `${said} · ${place.current.origin}` : said} onClick={openMenu} className={cn(SIMPLE_TOP_BUTTON, "relative")}>
      <Icon name={ICON[kind]} size={16} />
      {dot && <span aria-hidden="true" data-place-dot className={cn("absolute right-[7px] top-[7px] size-[7px] rounded-full", DOT[status])} />}
    </button>
    {place.error && <p role="alert" className="absolute right-0 top-full z-40 mt-1.5 w-56 rounded-md bg-menu px-2 py-1 text-[11px] text-danger shadow-lg">{place.error}</p>}
  </div>;
  return button;
}
