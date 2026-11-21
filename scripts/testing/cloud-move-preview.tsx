// The whole app with the move offer's desktop bridge played in the page (scripts/verify-cloud-move.ts serves it):
// ?offer=prompt|banner|settings picks the ask, ?move=copy|failing|done the move, and the buttons move between them as main
// would. Accept starts a copy whose chats count up until it is done; ?skin= picks a skin.
import { createRoot } from "react-dom/client";
import type { CloudSendNotice } from "../../electron/cloud-send.mjs";
import type { OneHomeView } from "../../electron/one-home.mjs";
import App from "../../src/App";
import { setEmailGateDone } from "../../src/lib/analytics";
import { initialDesktopCapabilities } from "../../src/lib/desktop";
import { applySkin, type SkinId } from "../../src/lib/skins";
import "../../src/styles.css";

const params = new URLSearchParams(location.search);
// a set-up install, as the surfaces gallery has: past the first-run welcome
setEmailGateDone("skipped");
const BASE: CloudSendNotice = { ready: false, bots: [], updatedBots: [], skills: 0, logins: 0, onePassword: false, settings: 0, signature: "", dismissed: false, running: false, last: null };
const MOVES: Record<string, OneHomeView> = {
  copy: { phase: "copy", chats: { done: 70, total: 142 } },
  failing: { phase: "copy", failing: { error: "My Cloud did not answer." } },
  done: { phase: "done", counts: { bots: 12, skills: 5, logins: 2, onePassword: false, chats: 142, routines: 4 }, phone: false },
};
const offer = params.get("offer");
let notice: CloudSendNotice = {
  ...BASE,
  ...(offer === "prompt" || offer === "banner" || offer === "settings" ? { offer: { stage: offer, bots: 12 } } : {}),
  ...(params.get("move") && MOVES[params.get("move")!] ? { move: MOVES[params.get("move")!] } : {}),
};
const listeners = new Set<(next: CloudSendNotice) => void>();
const tell = (next: CloudSendNotice) => { notice = next; for (const listener of listeners) listener(next); return next; };
const calls: string[] = [];
Object.assign(window, { cloudMoveCalls: calls });
let ticker: ReturnType<typeof setInterval> | null = null;

// ?cloud=ready: the account already has My Cloud, and this computer's bots have not moved (?clean=1: the clean workspace runs,
// so main offers no move from it). Switch to madani cloud is recorded as "switch-cloud".
const cloud = params.get("cloud") === "ready";
const HOME = { id: "c-home", name: "My Cloud", color: null, role: "owner", tier: "pro", runsOn: "cloud", status: "ready", origin: "https://home.example.test", teamId: null, primary: true, managed: true, provider: "managed" };
const account = { status: "connected", account: { id: "acct-1", email: "owner@qa.madani.test" }, entitlement: { plan: "pro", tier: "personal", status: "active" }, clouds: [HOME] };
let kept = { shown: params.get("clean") !== "1", on: false, moved: false, coming: false };
const cloudBridges = cloud ? {
  cloudAccount: {
    state: async () => account, onState: () => () => {}, offer: async () => null, openDashboard: async () => account,
    connectHome: async () => { calls.push("switch-cloud"); return account; },
  },
} : {};

window.madaniDesktop = {
  platform: "darwin",
  ...cloudBridges,
  getCapabilities: async () => initialDesktopCapabilities(),
  onCapabilitiesChanged: () => () => {},
  // the page opens Settings as main's menu would: window.cloudMoveOpenSettings()
  onOpenAppSettings: (open: (section?: string) => void) => { Object.assign(window, { cloudMoveOpenSettings: open }); return () => {}; },
  workspaces: {
    state: async () => ({ local: true, name: "This computer" }),
    menu: async () => { calls.push("workspace-menu"); },
    onChanged: () => () => {},
  },
  cloudSendPage: {
    ...(cloud ? { keepHere: async () => kept, setKeepHere: async (on: boolean) => { calls.push(`keep:${on}`); return (kept = { ...kept, on }); } } : {}),
    notice: async () => notice,
    onNotice: (listener: (next: CloudSendNotice) => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    dismiss: async (signature: string) => { calls.push(`dismiss:${signature}`); return tell({ ...notice, move: undefined }); },
    moveRetry: async () => { calls.push("retry"); return tell({ ...notice, move: MOVES.copy }); },
    moveOfferAccept: async (from: string) => {
      calls.push(`accept:${from}`);
      let done = 0;
      ticker ??= setInterval(() => {
        done = Math.min(160, done + 12);
        tell({ ...notice, move: done >= 160 ? MOVES.done! : done >= 142 ? { phase: "finishing" } : { phase: "copy", chats: { done, total: 142 } } });
        if (done >= 160 && ticker) { clearInterval(ticker); ticker = null; }
      }, 600);
      return tell({ ...BASE, move: { phase: "copy" } });
    },
    moveOpen: async () => { calls.push("open"); return notice; },
    moveOfferDismiss: async (which: string) => {
      calls.push(`dismiss-offer:${which}`);
      return tell({ ...BASE, offer: { stage: which === "prompt" ? "banner" : "settings", bots: 12 } });
    },
  },
} as unknown as typeof window.madaniDesktop;

applySkin((params.get("skin") ?? "midnight") as SkinId);
createRoot(document.getElementById("root")!).render(<App />);
