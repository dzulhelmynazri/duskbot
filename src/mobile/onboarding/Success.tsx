import { useEffect, useMemo, useRef, useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import { BotAvatar, MausAvatar } from "@/components/Avatar";
import type { Bot } from "@/state/store";
import { t } from "@/lib/i18n";
import { haptic } from "../haptics";
import { dur, ease, spring } from "../motion";
import { useScreen } from "./SkyScene";

const MIN_MS = 1900;
const CAP_MS = 3200;
const RING = 8;

type Snapshot = { bots?: Bot[] };

/** The linked moment: the computer's own bots fly in from the edges of the sky and gather round its name, then the
 * scene hands over to Home, which has been loading underneath the whole time. */
export function Success({ name, onDone }: { name: string; onDone: () => void }) {
  const reduced = useReducedMotion();
  const { w, h } = useScreen();
  const [bots, setBots] = useState<Bot[] | null>(null);
  const done = useRef(onDone);
  done.current = onDone;
  const loaded = useRef(false);
  loaded.current = bots !== null;

  useEffect(() => {
    let alive = true;
    const started = performance.now();
    void fetch("/api/bots?messages=0").then((r) => (r.ok ? r.json() : {})).then((body: Snapshot) => {
      if (alive) setBots((body.bots ?? []).filter((bot) => !bot.hidden).slice(0, RING));
    }).catch(() => { if (alive) setBots([]); });
    const finish = window.setInterval(() => {
      const elapsed = performance.now() - started;
      if (alive && elapsed >= MIN_MS && (loaded.current || elapsed >= CAP_MS)) { window.clearInterval(finish); done.current(); }
    }, 100);
    return () => { alive = false; window.clearInterval(finish); };
  }, []);

  useEffect(() => {
    if (!bots) return;
    const landed = window.setTimeout(() => haptic("success"), reduced ? 0 : 380);
    return () => window.clearTimeout(landed);
  }, [bots, reduced]);

  const seats = useMemo(() => {
    const count = Math.max(1, bots?.length ?? 0);
    const radius = Math.min(w * 0.36, 150);
    return Array.from({ length: count }, (_, i) => {
      const angle = -Math.PI / 2 + (i / count) * Math.PI * 2;
      const from = angle + Math.PI * 0.15;
      return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius * 0.9, fx: Math.cos(from) * Math.max(w, h), fy: Math.sin(from) * Math.max(w, h), r: (i % 2 ? 1 : -1) * (8 + (i * 7) % 10) };
    });
  }, [bots, w, h]);

  return (
    <motion.div className="madani-mobile fixed inset-0 z-[60] overflow-hidden bg-app text-ink"
      initial={{ opacity: 1 }} exit={{ opacity: 0, transition: { duration: dur.slow, ease: ease.out } }}
      role="status" aria-live="polite">
        <div className="absolute left-1/2 top-[44%]">
          {(bots === null ? [] : bots.length ? bots : [null]).map((bot, i) => {
            const seat = seats[i] ?? seats[0]!;
            return (
              <motion.div key={bot?.id ?? "none"} className="absolute left-[-36px] top-[-36px]"
                initial={reduced ? { x: seat.x, y: seat.y, opacity: 0 } : { x: seat.fx, y: seat.fy, rotate: seat.r * 3, scale: 0.7, opacity: 1 }}
                animate={{ x: seat.x, y: seat.y, rotate: seat.r, scale: 1, opacity: 1 }}
                transition={{ ...spring.lively, stiffness: 260, damping: 22, delay: reduced ? 0 : 0.06 * i, opacity: { duration: dur.fast } }}>
                <span className="madani-float relative block" style={{ animationDuration: `${5 + (i % 3)}s` }}>
                  {bot ? <BotAvatar bot={bot} size={72} state="happy" label="" /> : <MausAvatar color="blue" bodyId="kit" size={72} state="happy" label="" />}
                </span>
              </motion.div>
            );
          })}
          <motion.div className="absolute w-[min(78vw,300px)] -translate-x-1/2 -translate-y-1/2 text-center"
            initial={{ opacity: 0, scale: reduced ? 1 : 0.94 }} animate={{ opacity: 1, scale: 1 }}
            transition={{ ...spring.modal, delay: reduced ? 0 : 0.28, opacity: { duration: dur.base, delay: reduced ? 0 : 0.28 } }}>
            <p className="text-[15px] font-medium text-ink-secondary">{t("mobile.onboarding.linked")}</p>
            <p className="mt-1.5 text-[30px] font-semibold leading-[1.15] tracking-tight text-ink">{name}</p>
            {bots && bots.length > 0 && <p className="mt-2 text-[16px] text-ink-secondary">{t("mobile.onboarding.botsReady", { count: bots.length })}</p>}
          </motion.div>
        </div>
    </motion.div>
  );
}
