import { motion } from "motion/react";
import type { MarkState } from "./mascot-engine";
import type { MausColor } from "@/lib/mascot";
import type { Bot } from "@/state/store";
import { botsAcross } from "@/lib/cloud-move-offer";
import { cn } from "@/lib/cn";
import { MausAvatar } from "./Avatar";
import { useMotionReduced } from "./ui/SheetMotion";

const CELL = 4;
const W = 320, H = 132;
const BOTS: MausColor[] = ["orange", "blue", "green"];
const BOT = 26;
const LAPTOP = { x: 24, y: 68, cols: 22, rows: 13 };
const CLOUD = { x: 200, y: 62, cols: 24, rows: 12 };
/** Where each bot stands: its centre, and the line its feet are on. */
const ON_LAPTOP = [{ x: 42, y: 70 }, { x: 68, y: 70 }, { x: 94, y: 70 }];
const ON_CLOUD = [{ x: 222, y: 76 }, { x: 248, y: 72 }, { x: 274, y: 76 }];
const HOP_MS = 720;

type Px = { x: number; y: number; tone: string };

function laptopPixels(): Px[] {
  const out: Px[] = [];
  for (let y = 0; y <= 10; y++) for (let x = 2; x <= 19; x++) {
    const frame = y === 0 || y === 10 || x === 2 || x === 19;
    out.push({ x, y, tone: frame ? "frame" : y <= 2 && x <= 6 ? "glow" : "screen" });
  }
  for (let x = 0; x <= 21; x++) out.push({ x, y: 11, tone: x >= 9 && x <= 12 ? "notch" : "frame" });
  for (let x = 1; x <= 20; x++) out.push({ x, y: 12, tone: "base" });
  return out;
}

function cloudPixels(): Px[] {
  const puffs = [[6, 7, 4.2], [12, 5, 5.6], [18.5, 7, 4.4]] as const;
  const inside = (x: number, y: number) => y >= 0 && x >= 0 && x < CLOUD.cols && y < CLOUD.rows
    && ((y >= 7 && y <= 10 && x >= 2 && x <= 21) || puffs.some(([cx, cy, r]) => (x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2 <= r * r));
  const out: Px[] = [];
  for (let y = 0; y < CLOUD.rows; y++) for (let x = 0; x < CLOUD.cols; x++) {
    if (!inside(x, y)) continue;
    const edge = !inside(x, y + 1) || !inside(x + 1, y);
    const top = !inside(x, y - 1) || !inside(x - 1, y);
    out.push({ x, y, tone: edge ? "shade" : top ? "light" : "body" });
  }
  return out;
}

const LAPTOP_PX = laptopPixels(), CLOUD_PX = cloudPixels();
// the scene sits on its own sky in every skin, so its pixels are fixed colours: never pure black or white
const FILL: Record<string, string> = {
  frame: "#3d4757",
  base: "#5a6577",
  notch: "#2b323d",
  screen: "#203047",
  glow: "#4a8fd0",
  body: "#f1f7fd",
  light: "#fbfdff",
  shade: "#9dbbdb",
};
/** The sky behind the scene, in four bands from #c2ecfc down to #eaf6fd, as pixel art draws a sky. */
export const SKY = "linear-gradient(#c2ecfc 0 25%, #cdeffc 25% 50%, #d9f2fd 50% 75%, #eaf6fd 75% 100%)";

function Pixels({ at, pixels, cell = CELL }: { at: { x: number; y: number }; pixels: Px[]; cell?: number }) {
  return <g transform={`translate(${at.x} ${at.y})`}>
    {pixels.map((px) => <rect key={`${px.x}-${px.y}`} x={px.x * cell} y={px.y * cell} width={cell} height={cell} fill={FILL[px.tone]} />)}
  </g>;
}

const spot = (slot: { x: number; y: number }) => `translate(${slot.x - BOT / 2}px, ${slot.y - BOT}px)`;

/** Bots hopping from this computer onto madani cloud: `progress` 0 to 1, the last bot hops only once everything arrived. */
export function CloudMoveScene({ progress, done = false, className }: { progress: number; done?: boolean; className?: string }) {
  const reduced = useMotionReduced();
  const across = botsAcross(done ? 1 : progress, BOTS.length);
  return <div aria-hidden="true" data-cloud-move-scene={across} className={cn("flex w-full justify-center overflow-hidden", className)} style={{ background: SKY }}>
    <div className="relative h-[132px] w-[320px] max-w-full shrink-0">
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} shapeRendering="crispEdges" className="absolute inset-0">
      <Pixels at={LAPTOP} pixels={LAPTOP_PX} />
      <Pixels at={CLOUD} pixels={CLOUD_PX} />
    </svg>
    {BOTS.map((color, index) => {
      const there = index < across, from = ON_LAPTOP[index]!, to = ON_CLOUD[index]!;
      const at = there ? to : from;
      const peak = `translate(${(from.x + to.x) / 2 - BOT / 2}px, ${Math.min(from.y, to.y) - BOT - 44}px)`;
      const bot = <MausAvatar color={color} size={BOT} state={done ? "celebrate" : "idle"} trackPointer={false} animated={!reduced} label="" />;
      if (reduced) {
        return <motion.span key={`${index}-${there}`} data-bot-at={there ? "cloud" : "laptop"} className="absolute left-0 top-0 block"
          style={{ transform: spot(at) }} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.2, ease: "easeOut" }}>{bot}</motion.span>;
      }
      return <motion.span key={index} data-bot-at={there ? "cloud" : "laptop"} className="absolute left-0 top-0 block will-change-transform"
        initial={false}
        animate={{ transform: there ? [spot(from), peak, spot(to)] : spot(from) }}
        transition={{ duration: HOP_MS / 1000, ease: "easeInOut", times: [0, 0.45, 1], delay: there ? 0.16 * index : 0 }}>{bot}</motion.span>;
    })}
    </div>
  </div>;
}

const BAND = { w: 240, h: 84, cell: 3, bot: 26, small: 20, gap: 18 };
const BAND_LAPTOP = { x: 30, y: 40 }, BAND_CLOUD = { x: 146, y: 36 };
const BAND_ON = { laptop: { x: 63, y: 42 }, cloud: { x: 182, y: 47 } } as const;
const bandSpot = (slot: { x: number; y: number }, size: number) => `translate(${slot.x - size / 2}px, ${slot.y - size}px)`;

/** Bots and their way to madani cloud, as a short band: asleep on this computer, on the cloud, or hopping across.
 * One bot stands alone; a group chat's bots (up to three drawn) stand side by side and hop one after another. */
export function CloudHopScene({ bots, on, asleep = false, sky = true, className }: {
  bots: readonly Pick<Bot, "id" | "color" | "mascotBody" | "name">[];
  on: "laptop" | "cloud";
  asleep?: boolean;
  /** false: no sky of its own, the scene sits on its card's surface */
  sky?: boolean;
  className?: string;
}) {
  const reduced = useMotionReduced();
  const shown = bots.slice(0, 3);
  const size = shown.length > 1 ? BAND.small : BAND.bot;
  const state: MarkState = on === "cloud" ? "happy" : asleep ? "sleeping" : "idle";
  return <div aria-hidden="true" data-cloud-hop={on} className={cn("flex w-full justify-center overflow-hidden", className)} style={sky ? { background: SKY } : undefined}>
    <div className="relative shrink-0" style={{ width: BAND.w, height: BAND.h }}>
      <svg width={BAND.w} height={BAND.h} viewBox={`0 0 ${BAND.w} ${BAND.h}`} shapeRendering="crispEdges" className="absolute inset-0">
        <Pixels at={BAND_LAPTOP} pixels={LAPTOP_PX} cell={BAND.cell} />
        <Pixels at={BAND_CLOUD} pixels={CLOUD_PX} cell={BAND.cell} />
      </svg>
      {shown.map((bot, index) => {
        const dx = (index - (shown.length - 1) / 2) * BAND.gap;
        const from = { x: BAND_ON.laptop.x + dx, y: BAND_ON.laptop.y }, to = { x: BAND_ON.cloud.x + dx, y: BAND_ON.cloud.y };
        const peak = `translate(${(from.x + to.x) / 2 - size / 2}px, ${Math.min(from.y, to.y) - size - 26}px)`;
        const mascot = <MausAvatar color={bot.color} bodyId={bot.mascotBody ?? undefined} size={size} state={state} trackPointer={false} animated={!reduced} label="" />;
        if (reduced) return <span key={`${bot.id}-${on}`} data-bot-at={on} className="absolute left-0 top-0 block animate-fade-in" style={{ transform: bandSpot(on === "cloud" ? to : from, size) }}>{mascot}</span>;
        const order = on === "cloud" ? index : shown.length - 1 - index;
        return <motion.span key={bot.id} data-bot-at={on} className="absolute left-0 top-0 block will-change-transform" initial={false}
          // null: each hop starts from wherever the bot is, so pointing off mid-hop turns it back in the air instead of snapping
          // it to the far side first
          animate={{ transform: [null, peak, bandSpot(on === "cloud" ? to : from, size)] }}
          transition={{ duration: 0.56, ease: "easeInOut", times: [0, 0.45, 1], delay: 0.07 * order }}>{mascot}</motion.span>;
      })}
    </div>
  </div>;
}
