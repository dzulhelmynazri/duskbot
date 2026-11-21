import { useEffect, useState } from "react";
import { Cloud, Users, X } from "../icons";

const LINE_CLOSED = "madani.homeLineClosed";
import { freeFallback } from "../../shared/ai-ranking";
import { engineReady } from "@/components/EngineLibrary";
import { ConnectAiDialog } from "@/components/onboarding/ConnectAi";
import { t } from "@/lib/i18n";
import { setNotificationPlace } from "@/lib/notify";
import { useStore } from "@/state/store";

type Line = { kind: "left"; name: string } | { kind: "clean"; saved?: boolean; place?: string };

/** The words for main's one line: a team this person is no longer in, or that the clean workspace isn't where their bots went (`saved`: the account they moved with is signed in here too, one click away on the rail; `place`: the server of their own they moved to). */
export function homeLineText(line: Line): string {
  if (line.kind === "clean" && line.place) return t("homeLine.cleanPlace", { name: line.place });
  if (line.kind === "clean") return t(line.saved ? "homeLine.cleanSaved" : "homeLine.clean");
  return t("homeLine.left", { name: line.name });
}

/** The clean workspace skips the new-user setup, so connecting an AI is offered here while none is ready. Nothing is sent to
 * test one: nothing starts by itself in this workspace. */
function ConnectAiLink() {
  const { state } = useStore();
  const [open, setOpen] = useState(false);
  if (state.instances.some((instance) => engineReady(instance) && !freeFallback(instance))) return null;
  return <>
    <button type="button" data-home-line-ai className="underline underline-offset-2 hover:text-ink" onClick={() => setOpen(true)}>{t("onboarding.meet.connectAi")}</button>
    {open && <ConnectAiDialog tested={null} onClose={() => setOpen(false)} />}
  </>;
}

/** In the desktop app, never in a browser: one plain line main has for the next page, served once (home-places.mjs):
 * after a team dropped this person, that they are no longer in it. Nothing to press; it goes with the page. (Who can
 * see a team's private chats is said in the chat itself, by the team's own page.) Or, for as long as the clean workspace
 * runs (clean-workspace.mjs), that the person's bots are safe in their Cloud; Sign in stays in the You menu. */
export function HomeLine() {
  const bridge = !window.madaniDesktop?.remoteClient?.active ? window.madaniDesktop?.workspaces : undefined;
  const [line, setLine] = useState<Line | null>(null);
  // the clean workspace's line can be closed for good on this computer
  const [closed, setClosed] = useState(() => typeof localStorage !== "undefined" && localStorage.getItem(LINE_CLOSED) === "1");
  useEffect(() => {
    if (!bridge?.line) return;
    // Served once: the first ask gets the line even when a strict-mode remount asks again (and gets null, which must
    // not take it back); after a real unmount the set is a no-op.
    void bridge.line().then((next) => { if (next) setLine(next); }).catch(() => {});
    // A team's page (main's summary carries this person's role there): its notifications name the team.
    void bridge.state().then((place) => setNotificationPlace(place.role ? place.name : null)).catch(() => {});
  }, [bridge]);
  if (!line || closed) return null;
  return <div role="status" data-home-line={line.kind} className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 px-3 py-1.5 text-[13px] text-ink-secondary">
    {line.kind === "clean" ? <Cloud size={14} aria-hidden="true" /> : <Users size={14} aria-hidden="true" />}
    <span dir="auto">{homeLineText(line)}</span>
    {line.kind === "clean" && <ConnectAiLink />}
    {line.kind === "clean" && <button type="button" aria-label={t("common.close")} title={t("common.close")} data-home-line-close=""
      onClick={() => { localStorage.setItem(LINE_CLOSED, "1"); setClosed(true); }}
      className="grid size-6 place-items-center rounded-full text-ink-tertiary hover:bg-ink/[0.06] hover:text-ink focus-visible:outline-2 focus-visible:outline-focus"><X size={13} aria-hidden="true" /></button>}
  </div>;
}

