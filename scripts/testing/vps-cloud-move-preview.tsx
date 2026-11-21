// The whole app as a VPS's page, with the vps-cloud-move bridge played in the page: ?state= picks main's view
// (see STATES), ?signin=sheet also hands the page cloudAccount so a signed-out buy opens the sign-in sheet.
// window.vpsMoveOpen() opens the move sheet, window.vpsMoveSet(name) changes the view as main would.
import { createRoot } from "react-dom/client";
import type { VpsCloudMoveView } from "../../src/lib/vps-cloud-move";
import App from "../../src/App";
import { openCloudMove } from "../../src/lib/cloud-move";
import { initialDesktopCapabilities } from "../../src/lib/desktop";
import { applySkin, type SkinId } from "../../src/lib/skins";
import "../../src/styles.css";

const params = new URLSearchParams(location.search);
const PLACE = "hetzner-box";
const STAYS = `Saved logins, 1Password and app keys stay on ${PLACE}. Connect them again on madani cloud.`;
const COUNTS = { bots: 1, chats: 142, routines: 4, skills: 5 };
const STATES: Record<string, VpsCloudMoveView> = {
  "no-cloud": { stage: "none", cloud: "none" },
  "signed-out": { stage: "none", cloud: "signed-out" },
  ready: { stage: "none", cloud: "ready" },
  starting: { stage: "none", cloud: "starting" },
  buying: { stage: "buying", place: PLACE, route: "direct" },
  waiting: { stage: "waiting", place: PLACE, route: "direct" },
  "moving-chats": { stage: "moving", place: PLACE, route: "direct", phase: "copy", chats: { done: 58, total: 142 } },
  "moving-wait": { stage: "moving", place: PLACE, route: "direct", phase: "wait", waitingFor: "Quill" },
  "moving-retry": { stage: "moving", place: PLACE, route: "direct", phase: "copy", chats: { done: 96, total: 142 }, retrying: true, error: "madani cloud didn't answer." },
  "done-direct": { stage: "done", place: PLACE, route: "direct", counts: COUNTS, stays: STAYS },
  fallback: { stage: "fallback", place: PLACE, route: "via-mac", why: "vps_failing" },
  "fallback-progress": { stage: "fallback", place: PLACE, route: "via-mac", why: "outdated", phase: "copy" },
  "done-via-mac": { stage: "done", place: PLACE, route: "via-mac", counts: COUNTS },
  failed: { stage: "failed", place: PLACE, route: "direct", error: "madani cloud didn't answer." },
};
const OFFER = { plans: [{ tier: "pro", amount: 4900, label: "Pro" }, { tier: "plus", amount: 1900, label: "Plus" }], recommended: "pro" };

let view: VpsCloudMoveView = STATES[params.get("state") ?? "no-cloud"] ?? STATES["no-cloud"]!;
const listeners = new Set<(next: VpsCloudMoveView) => void>();
const tell = (next: VpsCloudMoveView) => { view = next; for (const listener of listeners) listener(next); return next; };
const calls: string[] = [];
const signedOut = view.stage === "none" && view.cloud === "signed-out";
const signInSheet = params.get("signin") === "sheet";

window.madaniDesktop = {
  platform: "darwin",
  app: { version: "preview", ownPage: false },
  getCapabilities: async () => initialDesktopCapabilities(),
  onCapabilitiesChanged: () => () => {},
  workspaces: {
    state: async () => ({ local: false, name: PLACE }),
    menu: async () => { calls.push("workspace-menu"); },
    onChanged: () => () => {},
  },
  cloudAdd: { state: async () => (signedOut ? { signedIn: false } : { signedIn: true, hasCloud: false, supported: true, canAdd: true, offer: OFFER, count: 0 }) },
  ...(signInSheet ? { cloudAccount: {
    state: async () => ({ status: "signed-out" }), onState: () => () => {}, offer: async () => OFFER,
    signInStart: async () => ({ ok: true }), signInCancel: async () => {},
  } } : {}),
  vpsCloudMove: {
    view: async () => view,
    start: async () => { calls.push("start"); return tell(STATES["moving-chats"]!); },
    buy: async (plan?: string) => {
      calls.push(`buy:${plan}`);
      if (signedOut) throw new Error("Sign in to madani cloud first.");
      return tell(STATES.buying!);
    },
    retry: async () => { calls.push("retry"); return tell(STATES["moving-chats"]!); },
    cancel: async () => { calls.push("cancel"); return tell(STATES["no-cloud"]!); },
    onChange: (listener: (next: VpsCloudMoveView) => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  },
} as unknown as typeof window.madaniDesktop;
Object.assign(window, { vpsMoveCalls: calls, vpsMoveOpen: () => openCloudMove("cloud"), vpsMoveSet: (name: string) => tell(STATES[name]!) });

applySkin((params.get("skin") ?? "midnight") as SkinId);
createRoot(document.getElementById("root")!).render(<App />);
