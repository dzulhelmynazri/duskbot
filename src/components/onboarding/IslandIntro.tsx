import { useCallback, useEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from "react";
import { AnimatePresence, motion, useSpring, useTransform } from "motion/react";
import { Plus } from "../../icons";
import { MausAvatar, type MausAvatarHandle } from "@/components/Avatar";
import { usePrefersReducedMotion } from "@/components/mascot-clock";
import { MOOD_EMOJI } from "@/ambient/mood";
import { FADE, FADE_OUT, LIVELY, SETTLE, markState } from "@/ambient/shared";
import type { AmbientAppBridge, AmbientStatus } from "@/ambient/types";
import { cn } from "@/lib/cn";
import { DEFAULT_BOT_NAME } from "@/lib/default-bot";
import { t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";
import type { MausColor } from "../../../shared/wire";

export type IslandChoice = "notch" | "dock";

/** The setup step that plays with the notch island and the bot dock, then asks where the bots live. While it shows,
 * the real island is on (the person sees it light up at the top of their screen); leaving without a choice puts it back. */

// one display, drawn at a fixed size: everything below is in its coordinates
const STAGE_W = 560;
const STAGE_H = 300;
const MID = STAGE_W / 2;
const NOTCH_W = 112;
const BAR_H = 26;
const TILE = 18;
const SHAPES = {
  notch: { w: NOTCH_W, h: BAR_H },
  compact: { w: 180, h: BAR_H },
  peek: { w: 300, h: 70 },
  open: { w: 340, h: 212 },
} as const;
const PANEL_W = SHAPES.open.w;
const PANEL_H = SHAPES.open.h;
const EAR = 9;
const HERO = 76;
const DOCK_TILE = 32;
const DOCK_CELL = 46;
/** The demo's beat: lights down, the island blooms, the mascot drops out of the notch and flies home, the dock slides in. */
const BEAT = { notch: 260, bloom: 520, hero: 760, home: 1900, live: 2250 } as const;
const CYCLE_MS = 1600;
const CHEER_MS = 1500;
const RESUME_MS = 900;

interface DemoBot { id: string; name: () => string; color: MausColor; status: AmbientStatus; line: LocaleKey }
const BOTS: DemoBot[] = [
  { id: "maus", name: () => DEFAULT_BOT_NAME, color: "chrome", status: "idle", line: "onboarding.notch.line.maus" },
  { id: "invoices", name: () => t("onboarding.jobs.invoices"), color: "red", status: "working", line: "onboarding.notch.line.invoices" },
  { id: "standup", name: () => t("onboarding.jobs.standup"), color: "teal", status: "thinking", line: "onboarding.notch.line.standup" },
  { id: "forecast", name: () => t("onboarding.jobs.forecast"), color: "blue", status: "needs-you", line: "onboarding.notch.line.forecast" },
];
type Shown = AmbientStatus | "celebrate";
/** What the island walks through on its own: every mood it has, each on the bot it would be about. */
const SCRIPT: [number, Shown][] = [[0, "idle"], [2, "thinking"], [1, "working"], [0, "talking"], [3, "needs-you"], [1, "done"], [2, "celebrate"]];
const STATUS_WORD: Record<Shown, LocaleKey> = {
  idle: "ambient.status.idle", thinking: "ambient.status.thinking", working: "ambient.status.working", talking: "ambient.status.talking",
  "needs-you": "ambient.status.needsYou", done: "ambient.status.done", error: "ambient.status.error", celebrate: "ambient.status.done",
};
const DOT: Partial<Record<Shown, string>> = { "needs-you": "#4d9bff", done: "#00ba69", celebrate: "#00ba69", error: "#ff6463" };
const emojiOf = (status: Shown) => MOOD_EMOJI[status];
const faceOf = (status: Shown) => (status === "celebrate" ? "celebrate" : markState(status));

/** The island's own prefs, read once; null until known, false where there is no island (not a Mac, not the desktop app). */
export function useIslandAvailable(): boolean | null {
  const bridge = window.madaniDesktop?.ambient as AmbientAppBridge | undefined;
  const [available, setAvailable] = useState<boolean | null>(bridge ? null : false);
  useEffect(() => {
    if (!bridge) return;
    let live = true;
    void bridge.prefs().then((prefs) => { if (live) setAvailable(prefs.available === true); }, () => { if (live) setAvailable(false); });
    return () => { live = false; };
  }, [bridge]);
  return available;
}

/** Turns the real island on once `armed`, and back off if the step closes with no choice made. */
function useLiveIsland(armed: boolean) {
  const bridge = window.madaniDesktop?.ambient as AmbientAppBridge | undefined;
  const [live, setLive] = useState(false);
  const was = useRef<boolean | null>(null);
  const turnedOn = useRef(false);
  const decided = useRef(false);
  useEffect(() => {
    if (!bridge || !armed) return;
    let active = true;
    void bridge.prefs().then(async (prefs) => {
      if (!active || !prefs.available || decided.current) return;
      was.current = prefs.island;
      if (!prefs.island) {
        await bridge.set({ island: true });
        turnedOn.current = true;
      }
      if (active) setLive(true);
    }).catch(() => {});
    return () => { active = false; };
  }, [bridge, armed]);
  useEffect(() => () => {
    if (!decided.current && turnedOn.current) void bridge?.set({ island: false }).catch(() => {});
  }, [bridge]);
  const choose = useCallback(async (choice: IslandChoice) => {
    decided.current = true;
    if (!bridge) return;
    await bridge.set(choice === "notch" ? { island: true } : { island: false, dock: true });
  }, [bridge]);
  return { live, choose };
}

function useReduced(): boolean {
  const prefers = usePrefersReducedMotion();
  return prefers || (typeof document !== "undefined" && document.documentElement.dataset.reducedMotion === "true");
}

type Phase = "dark" | "notch" | "bloom" | "hero" | "home" | "live";

export function IslandIntro({ onDone, titleId = "welcome-title" }: { onDone: (choice: IslandChoice) => void; titleId?: string }) {
  const reduced = useReduced();
  const [phase, setPhase] = useState<Phase>(reduced ? "live" : "dark");
  useEffect(() => {
    if (reduced) { setPhase("live"); return; }
    const timers = (Object.entries(BEAT) as [Phase, number][]).map(([next, at]) => setTimeout(() => setPhase(next), at));
    return () => timers.forEach(clearTimeout);
  }, [reduced]);
  const live = phase === "live";
  const real = useLiveIsland(live);

  const [step, setStep] = useState(0);
  const [pinned, setPinned] = useState<number | null>(null);
  const [open, setOpen] = useState(false);
  const [cheer, setCheer] = useState<{ bot: number; key: number } | null>(null);
  const [over, setOver] = useState(false);
  const [absorbed, setAbsorbed] = useState<number | null>(null);
  const resume = useRef<ReturnType<typeof setTimeout>>(undefined);
  const cheerTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const absorbTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => { clearTimeout(resume.current); clearTimeout(cheerTimer.current); clearTimeout(absorbTimer.current); }, []);

  useEffect(() => {
    if (!live || pinned !== null || open || cheer) return;
    const timer = setInterval(() => setStep((now) => (now + 1) % SCRIPT.length), reduced ? CYCLE_MS * 1.5 : CYCLE_MS);
    return () => clearInterval(timer);
  }, [live, pinned, open, cheer, reduced]);

  const [scriptBot, scriptStatus] = SCRIPT[step]!;
  const focusIndex = cheer?.bot ?? pinned ?? scriptBot;
  const focusStatus: Shown = cheer ? "celebrate" : pinned !== null ? BOTS[pinned]!.status : scriptStatus;
  const focus = BOTS[focusIndex]!;
  const statusOf = (index: number): Shown => (index === focusIndex ? focusStatus : BOTS[index]!.status);

  const marks = useRef<(MausAvatarHandle | null)[]>([]);
  const point = (index: number) => {
    clearTimeout(resume.current);
    setPinned(index);
  };
  const release = () => {
    clearTimeout(resume.current);
    resume.current = setTimeout(() => setPinned(null), RESUME_MS);
  };
  const cheerOn = (index: number) => {
    clearTimeout(cheerTimer.current);
    setCheer((now) => ({ bot: index, key: (now?.key ?? 0) + 1 }));
    if (!reduced) marks.current[index]?.react?.("cheer");
    cheerTimer.current = setTimeout(() => setCheer(null), CHEER_MS);
  };
  const absorb = (index: number) => {
    clearTimeout(absorbTimer.current);
    setAbsorbed(index);
    cheerOn(index);
    absorbTimer.current = setTimeout(() => setAbsorbed(null), 700);
  };

  // the island's shape rides one spring per axis; a bot dragged over it makes room for a moment
  const shape = phase === "dark" ? { w: NOTCH_W - 24, h: BAR_H - 6 } : phase === "notch" ? SHAPES.notch
    : phase === "live" ? (open ? SHAPES.open : SHAPES.peek) : SHAPES.compact;
  const targetW = shape.w + (over && !open ? 24 : 0);
  const w = useSpring(targetW, SETTLE);
  const h = useSpring(shape.h, SETTLE);
  useEffect(() => { if (reduced) w.jump(targetW); else w.set(targetW); }, [targetW, reduced, w]);
  useEffect(() => { if (reduced) h.jump(shape.h); else h.set(shape.h); }, [shape.h, reduced, h]);
  const r = useTransform(h, [BAR_H, SHAPES.peek.h, PANEL_H], [12, 22, 26]);
  const clip = useTransform(() => {
    const side = Math.max(0, (PANEL_W - w.get()) / 2);
    const bottom = Math.max(0, PANEL_H - h.get());
    return `inset(0px ${side}px ${bottom}px ${side}px round 0px 0px ${r.get()}px ${r.get()}px)`;
  });
  const leftEar = useTransform(w, (value) => MID - value / 2 - EAR);
  const rightEar = useTransform(w, (value) => MID + value / 2);
  const tileX = useTransform(w, (value) => MID - value / 2 + 11);
  const emojiX = useTransform(w, (value) => MID + value / 2 - 11 - TILE);

  const islandRef = useRef<HTMLButtonElement>(null);
  const nearIsland = (x: number, y: number) => {
    const box = islandRef.current?.getBoundingClientRect();
    return Boolean(box) && x >= box!.left - 28 && x <= box!.right + 28 && y >= box!.top - 28 && y <= box!.bottom + 36;
  };

  const [saving, setSaving] = useState<IslandChoice | null>(null);
  const [failed, setFailed] = useState(false);
  const pick = async (choice: IslandChoice) => {
    setSaving(choice);
    setFailed(false);
    try {
      await real.choose(choice);
      onDone(choice);
    } catch {
      setFailed(true);
      setSaving(null);
    }
  };
  const onKeyDown = (event: ReactKeyboardEvent) => {
    if (event.key === "Escape" && open) {
      event.stopPropagation();
      setOpen(false);
    }
  };

  const heroStage = phase === "hero" ? "out" : phase === "home" ? "home" : "in";
  const fadeIn = (at: number, y = 6): object => reduced
    ? { initial: { opacity: 0 }, animate: { opacity: 1 }, transition: { duration: 0.2 } }
    : { initial: { opacity: 0, y }, animate: { opacity: 1, y: 0 }, transition: { opacity: { ...FADE, delay: at / 1000 }, y: { ...SETTLE, delay: at / 1000 } } };

  return (
    <div data-island-intro="" onKeyDown={onKeyDown} className="relative h-full min-h-[600px] w-full text-[#f5f5f5]"
      style={{ "--color-ink": "#f5f5f5" } as CSSProperties}>
      {/* the lights go down */}
      <motion.div aria-hidden className="absolute inset-0 bg-[#0b0b0c]" initial={{ opacity: 0 }} animate={{ opacity: 1 }}
        transition={{ duration: reduced ? 0.15 : 0.42, ease: [0.22, 1, 0.36, 1] }} />
      <motion.h1 id={titleId} {...fadeIn(160)}
        className="absolute left-1/2 top-[calc(50%-264px)] w-max max-w-[min(480px,calc(100%-32px))] -translate-x-1/2 text-center text-[28px] font-normal leading-[34px] tracking-[-0.02em]">
        {t("onboarding.notch.title")}
      </motion.h1>

      <div className="absolute left-1/2 top-[calc(50%-206px)] -translate-x-1/2" style={{ width: STAGE_W, height: STAGE_H }}>
        <motion.div role="group" aria-label={t("onboarding.notch.stage")} {...fadeIn(120, 10)}
          className="relative size-full overflow-hidden rounded-[20px] bg-[#161618] shadow-none">
          <MenuBar />

          {/* the island: true black so it reads as one piece with the camera housing */}
          <motion.span aria-hidden className="absolute top-0 bg-[radial-gradient(circle_farthest-side_at_0_100%,transparent_96%,#000_100%)]" style={{ x: leftEar, left: 0, width: EAR, height: EAR }} />
          <motion.span aria-hidden className="absolute top-0 bg-[radial-gradient(circle_farthest-side_at_100%_100%,transparent_96%,#000_100%)]" style={{ x: rightEar, left: 0, width: EAR, height: EAR }} />
          <motion.div data-island="" className="absolute top-0 bg-black will-change-[clip-path]"
            style={{ left: MID - PANEL_W / 2, width: PANEL_W, height: PANEL_H, clipPath: clip }}>
            <button ref={islandRef} type="button" aria-expanded={open} aria-label={t("ambient.island")} disabled={!live}
              onClick={() => setOpen((now) => !now)} onMouseLeave={() => { if (open) setOpen(false); }}
              className="absolute left-1/2 top-0 -translate-x-1/2 rounded-b-[22px] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-transparent"
              style={{ width: SHAPES.peek.w, height: open ? PANEL_H : SHAPES.peek.h }} />
            <AnimatePresence initial={false}>
              {live && !open && (
                <motion.div key="peek" aria-live="polite" className="pointer-events-none absolute" style={{ left: (PANEL_W - SHAPES.peek.w) / 2 + 16, top: BAR_H + 4, width: SHAPES.peek.w - 32 }}
                  initial={{ opacity: 0 }} animate={{ opacity: 1, transition: { ...FADE, delay: 0.08 } }} exit={{ opacity: 0, transition: FADE_OUT }}>
                  <AnimatePresence initial={false} mode="popLayout">
                    <motion.div key={`${focus.id}:${focusStatus}`}
                      initial={reduced ? { opacity: 0 } : { opacity: 0, y: 4, filter: "blur(2px)" }}
                      animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
                      exit={reduced ? { opacity: 0 } : { opacity: 0, y: -3, filter: "blur(2px)" }}
                      transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}>
                      <div className="flex items-center gap-2 text-[13px] font-[550] leading-[18px]">
                        <span className="truncate">{focus.name()}</span>
                        <StatusWord status={focusStatus} />
                      </div>
                      <p className="m-0 truncate text-[12px] leading-4 text-[rgb(245_245_245/0.66)]">
                        {focusStatus === "celebrate" ? t("onboarding.notch.line.cheered") : t(focus.line)}
                      </p>
                    </motion.div>
                  </AnimatePresence>
                </motion.div>
              )}
              {open && (
                <motion.ul key="open" className="pointer-events-none absolute m-0 list-none p-0" style={{ left: 12, right: 12, top: BAR_H + 6 }}
                  initial="hidden" animate="shown" exit={{ opacity: 0, transition: FADE_OUT }}
                  variants={{ hidden: { opacity: 0 }, shown: { opacity: 1, transition: { ...FADE, delay: 0.05, staggerChildren: 0.03 } } }}>
                  {BOTS.map((bot, index) => (
                    <motion.li key={bot.id} variants={{ hidden: { opacity: 0, y: reduced ? 0 : 6 }, shown: { opacity: 1, y: 0 } }}
                      className="flex h-11 items-center gap-2.5 rounded-[14px] px-2">
                      <MausAvatar color={bot.color} bodyId="kit" size={26} state={faceOf(statusOf(index))} animated={!reduced} trackPointer={false} personality={false} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[13px] font-[550] leading-[18px]">{bot.name()}</span>
                        <span className="block truncate text-[11px] leading-4 text-[rgb(245_245_245/0.5)]">{t(bot.line)}</span>
                      </span>
                      <StatusWord status={statusOf(index)} />
                    </motion.li>
                  ))}
                </motion.ul>
              )}
            </AnimatePresence>
          </motion.div>
          {live && (
            <motion.span aria-hidden className="pointer-events-none absolute left-0 flex" style={{ x: tileX, top: (BAR_H - TILE) / 2, width: TILE, height: TILE }}>
              <MausAvatar key={focus.id} color={focus.color} bodyId="kit" size={TILE} state={faceOf(focusStatus)} animated={!reduced} trackPointer={false} personality={false} />
            </motion.span>
          )}
          {phase !== "dark" && phase !== "notch" && (
            <motion.span aria-hidden className="pointer-events-none absolute left-0 grid place-items-center" style={{ x: emojiX, top: (BAR_H - TILE) / 2, width: TILE, height: TILE, fontSize: 15 }}>
              <AnimatePresence initial={false} mode="popLayout">
                <motion.span key={live ? emojiOf(focusStatus) : "start"} data-island-emoji={live ? focusStatus : "idle"}
                  className="block leading-none [font-family:'Apple_Color_Emoji','Segoe_UI_Emoji','Noto_Color_Emoji',sans-serif]"
                  initial={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.5, y: 6, filter: "blur(3px)" }}
                  animate={{ opacity: 1, scale: 1, y: 0, filter: "blur(0px)" }}
                  exit={reduced ? { opacity: 0, transition: FADE_OUT } : { opacity: 0, scale: 0.96, filter: "blur(4px)", transition: FADE_OUT }}
                  transition={{ opacity: FADE, filter: FADE, scale: LIVELY, y: LIVELY }}>
                  {live ? emojiOf(focusStatus) : MOOD_EMOJI.idle}
                </motion.span>
              </AnimatePresence>
            </motion.span>
          )}

          {/* Madani drops out of the notch, says hello, and flies home into the island */}
          {!reduced && (phase === "bloom" || phase === "hero" || phase === "home") && (
            <motion.span aria-hidden className="pointer-events-none absolute left-0 top-0 flex" style={{ width: HERO, height: HERO, zIndex: heroStage === "in" ? 0 : 2 }}
              initial={{ x: MID - HERO / 2, y: -HERO / 2, scale: 0.4, opacity: 0 }}
              animate={heroStage === "in" ? { x: MID - HERO / 2, y: -HERO / 2, scale: 0.4, opacity: 0 }
                : heroStage === "out" ? { x: MID - HERO / 2, y: 104, scale: 1, opacity: 1 }
                  : { x: MID - SHAPES.compact.w / 2 + 11 + TILE / 2 - HERO / 2, y: BAR_H / 2 - HERO / 2, scale: TILE / HERO, opacity: 1 }}
              transition={heroStage === "out" ? { x: LIVELY, y: { type: "spring", stiffness: 420, damping: 19 }, scale: LIVELY, opacity: FADE }
                : { x: SETTLE, y: SETTLE, scale: SETTLE, opacity: FADE }}
              onAnimationComplete={() => { if (heroStage === "out") marks.current[BOTS.length]?.react?.("greet"); }}>
              <MausAvatar ref={(node) => { marks.current[BOTS.length] = node; }} color="chrome" bodyId="kit" size={HERO}
                state={heroStage === "out" ? "excited" : "idle"} animated trackPointer={false} personality={false} />
            </motion.span>
          )}

          <Dock
            shown={phase === "home" || live}
            reduced={reduced}
            statusOf={statusOf}
            focusIndex={focusIndex}
            absorbed={absorbed}
            marks={marks}
            onPoint={point}
            onRelease={release}
            onCheer={cheerOn}
            onDragOver={(x, y) => setOver(nearIsland(x, y))}
            onDrop={(index, x, y) => { setOver(false); if (nearIsland(x, y)) absorb(index); }}
          />
        </motion.div>
      </div>

      <motion.p {...fadeIn(BEAT.live - 200 + 120, 4)} className="absolute left-1/2 top-[calc(50%+108px)] m-0 w-[440px] max-w-[calc(100%-32px)] -translate-x-1/2 text-center text-[13px] leading-[18px] text-[rgb(245_245_245/0.55)]">
        {t("onboarding.notch.hint")}
      </motion.p>
      <AnimatePresence>
        {real.live && (
          <motion.p key="live" role="status" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.22 }}
            className="absolute left-1/2 top-[calc(50%+138px)] m-0 flex -translate-x-1/2 items-center gap-2 whitespace-nowrap text-[13px] leading-[18px]">
            <span aria-hidden className="size-1.5 rounded-full bg-[#00ba69]" />{t("onboarding.notch.live")}
          </motion.p>
        )}
      </AnimatePresence>

      <motion.div {...fadeIn(380, 4)} className="absolute left-1/2 top-[calc(50%+200px)] flex w-[288px] max-w-[calc(100%-32px)] -translate-x-1/2 flex-col items-center gap-3">
        {failed && <p role="alert" className="absolute -top-7 m-0 whitespace-nowrap text-[13px] leading-[18px] text-[#ff6463]">{t("settings.ambient.failed")}</p>}
        <button type="button" data-primary="" disabled={saving !== null} onClick={() => void pick("notch")}
          className={cn(PILL_BASE, "bg-[#f5f5f5] text-[#0b0b0c] [@media(hover:hover)_and_(pointer:fine)]:hover:bg-[rgb(245_245_245/0.88)]")}>
          {t("onboarding.notch.keep")}
        </button>
        <button type="button" data-island-dock="" disabled={saving !== null} onClick={() => void pick("dock")}
          className={cn(PILL_BASE, "bg-[rgb(245_245_245/0.08)] text-[#f5f5f5] [@media(hover:hover)_and_(pointer:fine)]:hover:bg-[rgb(245_245_245/0.14)]")}>
          {t("onboarding.notch.dock")}
        </button>
      </motion.div>
    </div>
  );
}

const PILL_BASE = "flex h-12 w-full items-center justify-center rounded-full px-5 text-[15px] leading-5 transition-[background-color,transform,opacity] duration-150 ease-out active:scale-[0.96] disabled:opacity-60 motion-reduce:active:scale-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-transparent";

function StatusWord({ status }: { status: Shown }) {
  return (
    <span className="inline-flex shrink-0 items-center gap-[5px] whitespace-nowrap text-[11px] font-normal leading-4 text-[rgb(245_245_245/0.66)]">
      <span aria-hidden className="size-1.5 rounded-full" style={{ background: DOT[status] ?? "rgb(245 245 245 / 0.8)" }} />
      {t(STATUS_WORD[status])}
    </span>
  );
}

/** A Mac's menu bar, faint, on both sides of the notch: enough to read as the person's own screen. */
function MenuBar() {
  return (
    <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 flex h-[26px] items-center justify-between px-4">
      <span className="flex items-center gap-3">
        <span className="size-2.5 rounded-full bg-[rgb(245_245_245/0.28)]" />
        {[30, 22, 26, 34].map((width, index) => <span key={index} className="h-1.5 rounded-full bg-[rgb(245_245_245/0.14)]" style={{ width }} />)}
      </span>
      <span className="flex items-center gap-3">
        {[12, 12, 16].map((width, index) => <span key={index} className="h-1.5 rounded-full bg-[rgb(245_245_245/0.14)]" style={{ width }} />)}
        <span className="h-1.5 w-9 rounded-full bg-[rgb(245_245_245/0.22)]" />
      </span>
    </div>
  );
}

function Dock({ shown, reduced, statusOf, focusIndex, absorbed, marks, onPoint, onRelease, onCheer, onDragOver, onDrop }: {
  shown: boolean;
  reduced: boolean;
  statusOf: (index: number) => Shown;
  focusIndex: number;
  absorbed: number | null;
  marks: RefObject<(MausAvatarHandle | null)[]>;
  onPoint: (index: number) => void;
  onRelease: () => void;
  onCheer: (index: number) => void;
  onDragOver: (x: number, y: number) => void;
  onDrop: (index: number, x: number, y: number) => void;
}) {
  const dragged = useRef(false);
  const height = BOTS.length * DOCK_CELL + 44 + 16;
  const top = (STAGE_H - height) / 2 + 10;
  const ear = 14;
  return (
    <motion.div className="absolute right-0" style={{ top: top - ear, width: 58, height: height + 2 * ear }}
      initial={false}
      animate={shown ? { x: 0, opacity: 1 } : { x: reduced ? 0 : 70, opacity: 0 }}
      transition={{ x: SETTLE, opacity: FADE }}>
      <span aria-hidden className="absolute right-0 top-0 bg-[radial-gradient(circle_farthest-side_at_0_0,transparent_96%,#0c0c0c_100%)]" style={{ width: ear, height: ear }} />
      <span aria-hidden className="absolute bottom-0 right-0 bg-[radial-gradient(circle_farthest-side_at_0_100%,transparent_96%,#0c0c0c_100%)]" style={{ width: ear, height: ear }} />
      <ul aria-label={t("ambient.dock")} className="absolute inset-x-0 m-0 flex list-none flex-col items-center rounded-l-[20px] bg-[#0c0c0c] p-0 py-2" style={{ top: ear, height }}>
        {BOTS.map((bot, index) => (
          <li key={bot.id} className="grid place-items-center" style={{ height: DOCK_CELL, width: "100%" }}>
            <motion.button type="button" data-dock-bot={bot.id}
              aria-label={`${bot.name()}, ${t(STATUS_WORD[statusOf(index)])}`}
              aria-current={focusIndex === index ? "true" : undefined}
              className="relative grid size-11 cursor-grab touch-none place-items-center rounded-[14px] active:cursor-grabbing focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-transparent"
              initial={false}
              animate={shown ? { opacity: absorbed === index ? 0 : 1, scale: absorbed === index ? 0.6 : 1 } : { opacity: 0, scale: reduced ? 1 : 0.6 }}
              transition={{ opacity: FADE, scale: { ...LIVELY, delay: shown && absorbed === null ? (reduced ? 0 : 0.12 + index * 0.06) : 0 } }}
              whileHover={reduced ? undefined : { scale: 1.14 }}
              whileTap={reduced ? undefined : { scale: 0.92 }}
              drag
              dragSnapToOrigin
              dragElastic={0.5}
              dragMomentum={false}
              whileDrag={reduced ? { zIndex: 5 } : { scale: 1.25, zIndex: 5 }}
              onPointerEnter={() => onPoint(index)}
              onPointerLeave={onRelease}
              onFocus={() => onPoint(index)}
              onBlur={onRelease}
              onDragStart={() => { dragged.current = true; onPoint(index); }}
              onDrag={(event) => { const pointer = event as PointerEvent; onDragOver(pointer.clientX, pointer.clientY); }}
              onDragEnd={(event) => { const pointer = event as PointerEvent; onDrop(index, pointer.clientX, pointer.clientY); }}
              onClick={() => {
                if (dragged.current) { dragged.current = false; return; }
                onCheer(index);
              }}>
              <MausAvatar ref={(node) => { marks.current[index] = node; }} color={bot.color} bodyId="kit" size={DOCK_TILE}
                state={faceOf(statusOf(index))} animated={!reduced} trackPointer={false} personality={false} />
              {bot.status === "needs-you" && (
                <span aria-hidden className="absolute left-0.5 top-0.5 grid h-4 min-w-4 place-items-center rounded-full bg-[#116dd2] px-1 text-[10px] font-semibold leading-none text-white shadow-[0_0_0_2px_#0c0c0c]">1</span>
              )}
            </motion.button>
          </li>
        ))}
        <li aria-hidden className="mt-auto grid h-11 w-full place-items-center text-[rgb(245_245_245/0.5)]"><Plus size={16} strokeWidth={2} /></li>
      </ul>
    </motion.div>
  );
}
