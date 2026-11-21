// The AIs people already use, as a grid of cards with their own logos. A press starts that AI's connect under the grid
// (connect-flow: getting it ready, its own sign-in in the browser, the code to enter), or shows its setup where it has
// no sign-in (EngineSetup: an API key, a local endpoint). One connect runs at a time: pressing another card cancels the
// running one. A connected AI turns green with a check and can't be pressed again; the window comes back to the front
// when a sign-in finishes. The first run, the Connect an AI dialog and Settings > Models all show this one grid.
import { useEffect, useRef, useState } from "react";
import { Check, Server } from "../../icons";
import { EngineSetup } from "@/components/EngineSetup";
import { engineReady } from "@/components/EngineLibrary";
import { CursorMark, PresetProviderMark, ProviderMark } from "@/components/ProviderIcons";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { plainSignIn } from "@/lib/onboarding";
import { useStore, type InstanceInfo } from "@/state/store";
import { aiName, aiTiles, type AiTile, type AiTileId } from "./funnel";
import { TILE } from "./FunnelSteps";
import { connectsInApp, type ConnectInstance } from "./connect-flow";
import { Reveal, StageSwap } from "./ConnectMotion";
import { ConnectPanel, useConnectFlow, type ConnectFlowHandle } from "./SignInPill";
import type { WelcomeAiNow } from "./welcome-ai";
import { connectedCards, readConnectedCache, writeConnectedCache } from "./ai-connected-cache";

const ready = (instance: InstanceInfo) => engineReady(instance);

function TileMark({ tile, size }: { tile: AiTile<InstanceInfo>; size: number }) {
  switch (tile.id) {
    case "chatgpt": return <ProviderMark driverKind="codex" size={size} />;
    case "claude": return <ProviderMark driverKind="claudeAgent" size={size} />;
    case "grok": return <ProviderMark driverKind="grokAgent" size={size} />;
    case "gemini": return <PresetProviderMark preset="google" size={size} />;
    case "cursor": return <CursorMark size={size} />;
    case "copilot": return <ProviderMark driverKind="copilotAgent" size={size} />;
    case "openrouter": return <PresetProviderMark preset="openrouter" size={size} />;
    case "local": return <Server size={size - 4} strokeWidth={1.5} className="text-ink-secondary" />;
  }
}

const label = (tile: AiTile<InstanceInfo>) => (tile.id === "local" ? t("funnel.ai.local") : tile.label);

/** A local endpoint or a step finished in Terminal keeps its own words; a website sign-in says the plain line. */
export function setupFor(instance: InstanceInfo) {
  if (instance.access === "custom") return { intent: "inject" as const };
  return plainSignIn(instance)
    ? { intent: "cloud" as const, description: t("onboarding.engines.signInHint", { name: instance.displayName }) }
    : { intent: "cloud" as const };
}

export const inAppConnect = (instance: InstanceInfo) => connectsInApp(instance as unknown as ConnectInstance);
const inApp = inAppConnect;

/** The pressed AI's way in: its connect, stage by stage, or the setup for an AI without a sign-in. "Try another way"
 * after a failure shows that setup too. */
export function AiConnect({ tile, flow }: { tile: AiTile<InstanceInfo>; flow: ConnectFlowHandle }) {
  const [trouble, setTrouble] = useState(false);
  const instance = tile.instance;
  const inAppConnect = !trouble && tile.candidates.some(inApp);
  return (
    <StageSwap stage={inAppConnect ? "connect" : "setup"} className="w-full">
      {inAppConnect
        ? <ConnectPanel flow={flow} name={aiName(instance)} driverKind={instance.driverKind} onTrouble={() => setTrouble(true)} />
        : <EngineSetup instance={instance} {...setupFor(instance)} className="w-full rounded-2xl border-0 bg-ink/[0.035] p-4 text-start" />}
    </StageSwap>
  );
}

function AiCard({ tile, connected, arrived, picked, suggested, staysHere, onPick }: { tile: AiTile<InstanceInfo>; connected: boolean; arrived: boolean; picked: boolean; suggested: boolean; staysHere: boolean; onPick: () => void }) {
  if (connected) {
    return (
      <div data-funnel-ai={tile.id} data-connected="" data-stays-here={staysHere ? "" : undefined} role="listitem"
        aria-label={t(staysHere ? "funnel.ai.connectedHereOnly" : "funnel.ai.connectedName", { name: label(tile) })}
        className={cn("ai-connected relative flex h-[96px] flex-col items-center justify-center gap-1.5 rounded-2xl bg-ink/[0.035] px-2", arrived && "place-reveal")}>
        <span className="grid size-7 place-items-center"><TileMark tile={tile} size={26} /></span>
        <span className="flex max-w-full flex-col items-center">
          <span className="max-w-full truncate text-[13px] leading-[18px] text-ink">{label(tile)}</span>
          {staysHere
            ? <span className="max-w-full truncate text-[12px] leading-4 text-ink-tertiary">{t("funnel.ai.staysHere")}</span>
            : <span className={cn("flex items-center gap-1 text-[12px] leading-4 text-success", arrived && "connect-label-in")}>
                <Check size={12} strokeWidth={2.5} aria-hidden="true" className="shrink-0" />{t("funnel.ai.ready")}
              </span>}
        </span>
      </div>
    );
  }
  return (
    <div role="listitem" className="flex">
      <button type="button" data-funnel-ai={tile.id} aria-pressed={picked} onClick={onPick}
        className={cn(TILE, "relative flex h-[96px] w-full flex-col items-center justify-center gap-2 px-2", picked && "bg-ink/[0.08] hover:bg-ink/[0.08]")}>
        <span className="grid size-7 place-items-center"><TileMark tile={tile} size={26} /></span>
        <span className="flex max-w-full flex-col items-center">
          <span className="max-w-full truncate text-[13px] leading-[18px] text-ink">{label(tile)}</span>
          {suggested && <span data-ai-on-computer="" className="max-w-full truncate text-[12px] leading-4 text-ink-tertiary">{t("funnel.ai.onComputer")}</span>}
        </span>
      </button>
    </div>
  );
}

/** Brings the app back to the front when an AI becomes connected while the grid is open (a sign-in in the browser). */
function useFocusOnConnect(connectedIds: readonly string[]) {
  const seen = useRef<Set<string> | null>(null);
  const key = connectedIds.join(",");
  useEffect(() => {
    const now = new Set(key ? key.split(",") : []);
    const before = seen.current;
    seen.current = now;
    if (before && [...now].some((id) => !before.has(id))) void window.madaniDesktop?.focusWindow?.().catch(() => {});
  }, [key]);
}

/** The AIs that are connected here now, by their card. */
export function connectedAiCards(instances: readonly InstanceInfo[]): AiTileId[] {
  return aiTiles(instances, ready).filter((tile) => ready(tile.instance)).map((tile) => tile.id);
}

/** The grid of popular AIs and, under it, the pressed one's way in. `onMore`: the small link to every other provider and
 * API keys (the model directory). Nothing runs until a card is pressed. `onConnected`: called once when the AI pressed
 * here becomes connected. */
export function AiCards({ onMore, className, onConnected, suggested = [], staysHere = [] }: { tested: WelcomeAiNow | null; onMore?: () => void; className?: string;
  onConnected?: (tile: AiTileId) => void;
  /** cards marked as used on the person's computer */
  suggested?: readonly AiTileId[];
  /** connected cards whose sign-in stays on this computer when the person's madani cloud is made */
  staysHere?: readonly AiTileId[] }) {
  const { state, refreshInstances } = useStore();
  const [picked, setPicked] = useState<AiTileId | null>(null);
  const flow = useConnectFlow();
  const tiles = aiTiles(state.instances, ready, inApp);
  const [cached] = useState(readConnectedCache);
  const { shown, next } = connectedCards(tiles, (tile) => ready(tile.instance), cached);
  const nextKey = [...next].sort().join(",");
  useEffect(() => { writeConnectedCache(new Set(nextKey ? nextKey.split(",") as AiTileId[] : [])); }, [nextKey]);
  useEffect(() => { void Promise.resolve(refreshInstances?.({ cached: true })).catch(() => {}); }, [refreshInstances]);
  // a card drawn connected in the first frame stays still; only one that connects while the grid is open fades in
  const [firstShown] = useState(() => new Set(shown));
  const pick = (tile: AiTile<InstanceInfo>) => {
    flow.cancel();
    if (picked === tile.id) return setPicked(null);
    setPicked(tile.id);
    if (tile.candidates.some(inApp)) flow.start({ tile: tile.id, candidates: tile.candidates.map((candidate) => candidate.instanceId) });
  };
  const chosen = tiles.find((tile) => tile.id === picked && !shown.has(tile.id));
  useFocusOnConnect(tiles.filter((tile) => ready(tile.instance)).map((tile) => tile.id));
  const told = useRef(false);
  const pickedReady = Boolean(picked && tiles.some((tile) => tile.id === picked && ready(tile.instance)));
  // a sign-in still confirming has not finished: telling now would close the dialog and cancel it mid-way
  const settled = flow.state.stage === "connected" || flow.state.stage === "idle" || flow.state.stage === "failed";
  useEffect(() => {
    if (told.current || !picked || !settled || !(pickedReady || flow.state.stage === "connected")) return;
    told.current = true;
    onConnected?.(picked);
  }, [picked, pickedReady, settled, flow.state.stage]);

  return (
    <div data-ai-cards="" className={cn("@container flex w-full flex-col items-center", className)}>
      <div role="list" aria-label={t("funnel.ai.title")} className="grid w-full grid-cols-2 gap-2.5 @min-[400px]:grid-cols-4">
        {tiles.map((tile) => (
          <AiCard key={tile.id} tile={tile} connected={shown.has(tile.id)} arrived={!firstShown.has(tile.id)} picked={picked === tile.id}
            suggested={suggested.includes(tile.id)} staysHere={staysHere.includes(tile.id)} onPick={() => pick(tile)} />
        ))}
      </div>
      <Reveal className="pt-5">
        {chosen && (
          <StageSwap stage={chosen.id}>
            <div data-funnel-ai-connect={chosen.id} className="flex w-full flex-col items-center">
              <AiConnect key={chosen.id} tile={chosen} flow={{ ...flow, cancel: () => { flow.cancel(); setPicked(null); } }} />
            </div>
          </StageSwap>
        )}
      </Reveal>
      {/* while a sign-in runs, nothing else to pick */}
      {onMore && !(chosen && flow.state.stage !== "idle" && flow.state.stage !== "failed") && (
        <button type="button" data-ai-more="" onClick={onMore}
          className="mt-3 min-h-9 rounded-full px-3 text-[13px] leading-[18px] text-ink-secondary transition-colors hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus motion-reduce:transition-none">
          {t("connectAi.more")}
        </button>
      )}
    </div>
  );
}
