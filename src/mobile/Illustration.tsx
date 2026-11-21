import type { ReactNode } from "react";
import { motion, useReducedMotion } from "motion/react";
import { cn } from "@/lib/cn";
import { MausAvatar } from "@/components/Avatar";
import type { MausColor } from "@/lib/mascot";
import key from "@/assets/pixel-art/key.webp";
import clock from "@/assets/pixel-art/clock.webp";
import plug from "@/assets/pixel-art/plug.webp";
import mailbox from "@/assets/pixel-art/mailbox.webp";
import phone from "@/assets/pixel-art/phone.webp";
import computer from "@/assets/pixel-art/computer.webp";
import signpost from "@/assets/pixel-art/signpost.webp";
import cloud from "@/assets/pixel-art/cloud.webp";
import books from "@/assets/pixel-art/books.webp";
import parcel from "@/assets/pixel-art/parcel.webp";
import server from "@/assets/pixel-art/server.webp";
import map from "@/assets/pixel-art/map.webp";
import { spring } from "./motion";

/** the madani.bot site's small pixel objects, the same set its docs explain things with */
export const PIXEL_ART = { key, clock, plug, mailbox, phone, computer, signpost, cloud, books, parcel, server, map } as const;
export type PixelArtName = keyof typeof PIXEL_ART;

/** One small piece of explanatory pixel art: decorative, so it carries no name. */
export function PixelArt({ name, size = 88, className }: { name: PixelArtName; size?: number; className?: string }) {
  return <img src={PIXEL_ART[name]} alt="" aria-hidden draggable={false} className={cn("pointer-events-none select-none object-contain", className)} style={{ width: size, height: size }} />;
}

/** A single mascot standing in for the art, for the moments that are about a bot rather than a thing. */
export function PixelMascot({ color = "blue", size = 64 }: { color?: MausColor; size?: number }) {
  return <MausAvatar color={color} size={size} state="idle" label="" />;
}

/** The desktop's starting mascot (its empty window while it connects): the same mark in its loading motion, for
 * every moment the phone waits on its computer to start, connect or wake. */
export function LoadingMascot({ size = 56, color = "green" }: { size?: number; color?: MausColor }) {
  return <span aria-hidden className="inline-flex shrink-0"><MausAvatar color={color} size={size} state="loading" trackPointer={false} personality={false} label="" /></span>;
}

/**
 * The phone's one empty, error and waiting state: a small picture, a short title, a line that says what to do, and at
 * most one action. Used everywhere a list has nothing in it or a load failed, so they all read the same.
 */
export function EmptyState({ art, mascot, title, body, action, secondary, tone = "empty", className }: {
  art?: PixelArtName;
  mascot?: MausColor;
  title: string;
  body?: ReactNode;
  action?: { label: string; onClick: () => void; icon?: ReactNode };
  secondary?: { label: string; onClick: () => void };
  tone?: "empty" | "error";
  className?: string;
}) {
  const reduced = useReducedMotion();
  return (
    <motion.div
      role={tone === "error" ? "alert" : undefined}
      data-empty-state={tone}
      initial={reduced ? false : { opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ ...spring.settle, opacity: { duration: 0.2 } }}
      className={cn("mx-auto flex w-full max-w-[300px] flex-col items-center px-6 py-10 text-center", className)}
    >
      {art ? <PixelArt name={art} /> : mascot ? <PixelMascot color={mascot} /> : null}
      <h2 className="mt-5 text-[18px] font-semibold leading-6 text-ink">{title}</h2>
      {body && <p className="mt-1.5 text-[15px] leading-[22px] text-ink-secondary">{body}</p>}
      {action && (
        <button type="button" onClick={action.onClick} className="mobile-press mt-6 inline-flex min-h-11 items-center justify-center gap-2 rounded-full bg-ink px-6 text-[15px] font-semibold text-app">
          {action.icon}{action.label}
        </button>
      )}
      {secondary && (
        <button type="button" onClick={secondary.onClick} className="mobile-press mt-2 inline-flex min-h-11 items-center justify-center rounded-full px-5 text-[15px] font-semibold text-ink-secondary">
          {secondary.label}
        </button>
      )}
    </motion.div>
  );
}
