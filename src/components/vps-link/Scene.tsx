// the picture every screen of Add your VPS shares: this Mac, the server, the dotted line between them and the mascot on
// it, which keeps changing shape and colour the whole way. During the move the bots travel along the line one by one.
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { BotAvatar, MausAvatar, type MausAvatarHandle } from "@/components/Avatar";
import { usePrefersReducedMotion } from "@/components/mascot-clock";
import { cn } from "@/lib/cn";
import type { MausState } from "@/lib/mascot";
import type { MarkReaction } from "@/components/mascot-engine";
import { useStore } from "@/state/store";
import { MADANI_BODY_IDS, type MadaniBodyId } from "../../../shared/body-migration";
import { isMausColor, type MausColor } from "../../../shared/wire";
import "../../styles/vps-flow.css";

export type SceneMode = "waiting" | "working" | "stuck" | "linked" | "moving" | "moved";
export interface SceneBot { id: string; name: string }
export interface SceneHandle { react(kind: MarkReaction): void }

const PALETTE = (["green", "blue", "pink", "orange", "purple", "teal", "red", "yellow", "chrome", "coral", "cyan"] as const).filter(isMausColor);
// a body step coprime with the ten bodies visits every one before repeating, and neighbours never look alike
const BODY_STEP = 3;
const SHIFT_MS = 1900;
const DOTS = 13;
const LINE_FROM = 152;
const LINE_SPAN = 216;
const FACE = 22;
const SHOWN = 4;

/** The mascot that never sits still: every couple of seconds it hops into another body and colour, as the new-bot
 * picker's preview does. Under reduced motion it keeps one shape. */
const ShapeShifter = forwardRef<SceneHandle, { state: MausState; size: number }>(function ShapeShifter({ state, size }, ref) {
  const reduced = usePrefersReducedMotion();
  const mark = useRef<MausAvatarHandle>(null);
  const [turn, setTurn] = useState(0);
  useImperativeHandle(ref, () => ({ react: (kind) => mark.current?.react?.(kind) }), []);
  useEffect(() => {
    if (reduced) return;
    const timer = setInterval(() => {
      if (document.hidden) return;
      setTurn((now) => now + 1);
      mark.current?.react?.("hop");
    }, SHIFT_MS);
    return () => clearInterval(timer);
  }, [reduced]);
  const body: MadaniBodyId = MADANI_BODY_IDS[(turn * BODY_STEP) % MADANI_BODY_IDS.length]!;
  const color: MausColor = PALETTE[turn % PALETTE.length]!;
  return <MausAvatar ref={mark} bodyId={body} color={color} state={state} size={size} trackPointer={false} />;
});

const FALLBACK: MausColor[] = ["blue", "pink", "orange", "teal", "purple", "red"];

/** A bot's own face where this app knows it, else a mascot in a steady colour of its own. */
export function BotFace({ bot, index, size = FACE }: { bot: SceneBot; index: number; size?: number }) {
  const { state } = useStore();
  const known = state.bots?.find((entry) => entry.id === bot.id);
  return known
    ? <BotAvatar bot={known} size={size} animated={false} trackPointer={false} />
    : <MausAvatar color={FALLBACK[index % FALLBACK.length]!} bodyId={MADANI_BODY_IDS[(index * 3 + 1) % MADANI_BODY_IDS.length]} size={size} animated={false} trackPointer={false} />;
}

function Faces({ bots, offset, total }: { bots: SceneBot[]; offset: number; total: number }) {
  const shown = bots.slice(0, total > SHOWN ? SHOWN - 1 : SHOWN);
  const more = total - shown.length;
  return (
    <>
      {shown.map((bot, index) => <span key={bot.id} className="vps-land flex"><BotFace bot={bot} index={offset + index} /></span>)}
      {more > 0 && <span className="flex h-[22px] min-w-[22px] items-center justify-center rounded-full border border-ink/12 px-1 text-[10px] leading-3 tabular-nums text-ink/68">+{more}</span>}
    </>
  );
}

function Laptop({ bots, offset, mode }: { bots: SceneBot[]; offset: number; mode: SceneMode }) {
  return (
    <div className="absolute left-0 top-[34px] h-[86px] w-[136px]">
      <div className="absolute left-2 top-0 flex h-[78px] w-[120px] items-center justify-center rounded-[10px] border-[1.5px] border-ink/18 bg-app">
        {bots.length > 0
          ? <div className="grid grid-cols-2 gap-1.5"><Faces bots={bots} offset={offset} total={bots.length} /></div>
          : mode !== "moved" && <div className="flex w-[76px] flex-col gap-1.5">
                <span className="h-[5px] w-[60px] rounded-full bg-ink/10" />
                <span className="h-[5px] w-[76px] rounded-full bg-ink/10" />
                <span className="h-[5px] w-[44px] rounded-full bg-ink/10" />
              </div>}
      </div>
      <div className="absolute bottom-0 left-0 h-[7px] w-[136px] rounded-b-[6px] rounded-t-[2px] bg-ink/14" />
      <div className="absolute bottom-[3px] left-[56px] h-[2px] w-[24px] rounded-full bg-ink/14" />
    </div>
  );
}

function Server({ bots, offset, total }: { bots: SceneBot[]; offset: number; total: number }) {
  return (
    <div className="absolute right-0 top-[34px] w-[136px]">
      <div className="absolute -top-[30px] left-0 flex w-full items-end justify-center gap-1.5">
        {total > 0 && <Faces bots={bots} offset={offset} total={total} />}
      </div>
      <div className="flex flex-col gap-1">
        {[0, 1, 2].map((unit) => (
          <div key={unit} className="relative flex h-[26px] items-center gap-1.5 rounded-[6px] border-[1.5px] border-ink/18 bg-app px-2.5">
            <span className="h-[3px] w-10 rounded-full bg-ink/12" />
            <span className="h-[3px] w-5 rounded-full bg-ink/12" />
            <span className="ms-auto flex gap-1">
              {[0, 1].map((led) => (
                <span key={led} className="relative size-[5px] rounded-full bg-ink/16">
                  <span className="vps-led vps-led-on absolute inset-0 rounded-full bg-success" />
                  <span className="vps-led vps-led-busy absolute inset-0 rounded-full bg-ink" style={{ animationDelay: `${(unit * 2 + led) * 130}ms` }} />
                  {unit === 1 && led === 1 && <span className="vps-led vps-led-stuck absolute inset-0 rounded-full bg-danger" />}
                </span>
              ))}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

export const Scene = forwardRef<SceneHandle, {
  mode: SceneMode;
  mascot: MausState;
  /** Every bot that is moving, in order; `arrived` of them are on the server already. */
  bots: SceneBot[];
  arrived: number;
  className?: string;
}>(function Scene({ mode, mascot, bots, arrived, className }, ref) {
  const lit = mode === "linked" || mode === "moving" || mode === "moved";
  const done = mode === "moved" ? bots.length : Math.min(arrived, bots.length);
  const flying = mode === "moving" && done < bots.length ? bots[done] : undefined;
  const onMac = bots.slice(done + (flying ? 1 : 0));
  const onServer = bots.slice(0, done);
  return (
    <div aria-hidden="true" data-mode={mode} data-lit={lit ? "" : undefined} data-vps-scene={mode}
      className={cn("vps-scene pointer-events-none relative h-[150px] w-[520px] max-[600px]:origin-top max-[600px]:scale-[0.62]", className)}>
      <Laptop bots={onMac} offset={done + (flying ? 1 : 0)} mode={mode} />
      <Server bots={onServer} offset={0} total={onServer.length} />
      {Array.from({ length: DOTS }, (_, index) => (
        <span key={index} className="absolute top-[75px] size-[5px] rounded-full bg-ink/16" style={{ left: LINE_FROM + (index * LINE_SPAN) / (DOTS - 1) - 2.5 }}>
          <span className="vps-dot-pulse absolute inset-0 rounded-full bg-ink" style={{ animationDelay: `${index * 90}ms` }} />
          <span className="vps-dot-lit absolute inset-0 rounded-full bg-success" style={{ transitionDelay: lit ? `${index * 45}ms` : "0ms" }} />
        </span>
      ))}
      {flying && (
        <span key={flying.id} data-vps-traveler={flying.id} className="vps-traveler absolute top-[66px] flex" style={{ left: LINE_FROM - FACE / 2 }}>
          <BotFace bot={flying} index={done} />
        </span>
      )}
      <span className="vps-guide absolute left-[228px] top-[45px] flex size-16">
        <ShapeShifter ref={ref} state={mascot} size={64} />
      </span>
    </div>
  );
});
