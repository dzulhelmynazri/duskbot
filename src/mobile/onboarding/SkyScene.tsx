import { useEffect, useRef, useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import { MausAvatar, type MausAvatarHandle } from "@/components/Avatar";
import type { MausColor } from "@/lib/mascot";
import { haptic } from "../haptics";
import { spring } from "../motion";
import "./onboarding.css";

export function useScreen(): { w: number; h: number } {
  const [size, setSize] = useState(() => ({ w: window.innerWidth, h: window.innerHeight }));
  useEffect(() => {
    const onResize = () => setSize({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return size;
}

function TrioMascot({ color, size, raise, delay }: { color: MausColor; size: number; raise: number; delay: number }) {
  const ref = useRef<MausAvatarHandle>(null);
  return (
    <motion.button type="button" tabIndex={-1} aria-hidden className="relative touch-manipulation"
      style={{ marginBottom: raise }} whileTap={{ scale: 1.1, transition: spring.lively }}
      onPointerDown={() => { haptic("tap"); ref.current?.poke?.(); }}>
      <span className="madani-float block" style={{ animationDuration: "6.4s", animationDelay: `${delay}s` }}>
        <MausAvatar ref={ref} color={color} size={size} state="idle" label="" />
      </span>
    </motion.button>
  );
}

/** The dashboard Home card's three mascots, the same colours, bodies and composition, scaled for the phone: orange, a
 * raised blue, green. Onboarding's only art; it floats gently and a tap pokes one. */
export function MascotTrio({ scale = 1.6, className }: { scale?: number; className?: string }) {
  const reduced = useReducedMotion();
  return (
    <motion.div aria-hidden className={`flex items-end justify-center ${className ?? ""}`} style={{ gap: 4 * scale }}
      initial={reduced ? false : { opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ ...spring.settle, opacity: { duration: 0.22 } }}>
      <TrioMascot color="orange" size={36 * scale} raise={0} delay={0} />
      <TrioMascot color="blue" size={48 * scale} raise={12 * scale} delay={-2.1} />
      <TrioMascot color="green" size={36 * scale} raise={0} delay={-4.2} />
    </motion.div>
  );
}
