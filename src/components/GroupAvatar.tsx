import { useEffect, useState } from "react";
import { Users } from "../icons";

import { cn } from "@/lib/cn";
import { profileForSession, readSessionState, type SessionState } from "@/lib/session";
import { useStore, type Bot } from "@/state/store";
import { BotAvatar } from "./Avatar";
import { personFace, profileInitials, type PersonFace } from "./SidebarProfileMenu";
import { useActiveAccount } from "./AccountMenu";
import { UserFace } from "./UserAvatar";

/** The person in a group chat: their face (photo or drawn head), else their initials. */
export type GroupYou = { initials: string; avatarUrl?: string; face?: PersonFace };

type Cell = { x: number; y: number; size: number };

/** Grok's group grid: one face fills the slot, two sit corner to corner at 2/3, three and four share a 2x2 of 5/9 cells
 * (three with the top one centred). */
export function groupCells(count: number, frame: number): Cell[] {
  if (count <= 1) return [{ x: 0, y: 0, size: frame }];
  if (count === 2) {
    const size = (frame * 2) / 3;
    return [{ x: 0, y: 0, size }, { x: frame - size, y: frame - size, size }];
  }
  const size = (frame * 5) / 9;
  const step = frame - size;
  if (count === 3) return [{ x: step / 2, y: 0, size }, { x: 0, y: step, size }, { x: step, y: step, size }];
  return [{ x: 0, y: 0, size }, { x: step, y: 0, size }, { x: 0, y: step, size }, { x: step, y: step, size }];
}

const MAX_CELLS = 4;
const round = (n: number) => Math.round(n * 100) / 100;

/** The person's round cell cut where a later cell overlaps it, a gap wider all round, so a thin ring of whatever is behind shows between them. */
function cutMask(cell: Cell, later: readonly Cell[], gap: number): string | undefined {
  const r = cell.size / 2;
  const holes = later.filter((other) => Math.hypot(cell.x + r - (other.x + other.size / 2), cell.y + r - (other.y + other.size / 2)) < r + other.size / 2 + gap);
  if (!holes.length) return undefined;
  const circles = holes.map((other) => `<circle cx="${round(other.x + other.size / 2 - cell.x)}" cy="${round(other.y + other.size / 2 - cell.y)}" r="${round(other.size / 2 + gap)}" fill="#000"/>`).join("");
  const s = round(cell.size);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${s} ${s}"><mask id="c"><rect width="${s}" height="${s}" fill="#fff"/>${circles}</mask><rect width="${s}" height="${s}" mask="url(#c)"/></svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}

/** A group chat's avatar at list size, the way Grok draws it: the person's initials first, then up to three members' pixel marks as a small cluster,
 * laid out in a `size` square. Static: the room's working faces live on its status line. */
export function GroupAvatar({ members, size, you, className }: {
  members: readonly Bot[];
  size: number;
  you?: GroupYou | null;
  className?: string;
}) {
  const faces: Array<{ kind: "you"; you: GroupYou } | { kind: "bot"; bot: Bot }> = [
    ...(you && members.length ? [{ kind: "you" as const, you }] : []),
    ...members.map((bot) => ({ kind: "bot" as const, bot })),
  ].slice(0, MAX_CELLS);
  if (!faces.length) {
    return (
      <span data-group-avatar="" aria-hidden className={cn("flex shrink-0 items-center justify-center", className)} style={{ width: size, height: size }}>
        <Users size={Math.round(size * 0.66)} className="text-ink-secondary" />
      </span>
    );
  }
  const cells = groupCells(faces.length, size);
  const gap = (2 * size) / 36;
  const initialsPx = Math.max(1, Math.round((cells[0]!.size) * (faces.length === 1 ? 14 / 36 : faces.length === 2 ? 0.26 : 0.216)));
  return (
    <span data-group-avatar="" aria-hidden className={cn("relative block shrink-0", className)} style={{ width: size, height: size }}>
      {faces.map((face, index) => {
        const cell = cells[index]!;
        const mask = face.kind === "you" ? cutMask(cell, cells.slice(index + 1), gap) : undefined;
        const px = round(cell.size);
        return (
          <span
            key={face.kind === "you" ? "you" : face.bot.id}
            data-group-avatar-cell={face.kind}
            className="absolute flex"
            style={{ left: round(cell.x), top: round(cell.y), width: px, height: px, ...(mask ? { maskImage: mask, WebkitMaskImage: mask, maskRepeat: "no-repeat", WebkitMaskRepeat: "no-repeat", maskSize: "100% 100%", WebkitMaskSize: "100% 100%" } : {}) }}
          >
            {face.kind === "bot" ? (
              <BotAvatar bot={face.bot} size={px} state="idle" animated={false} trackPointer={false} forward={false} />
            ) : face.you.face ? (
              <UserFace account={face.you.face} size={px} className="block size-full" />
            ) : face.you.avatarUrl ? (
              <img src={face.you.avatarUrl} alt="" draggable={false} className="block size-full rounded-full object-cover" />
            ) : (
              <span
                className="flex size-full items-center justify-center rounded-full bg-ink/[0.04] font-semibold leading-none tracking-[-0.025em] text-ink-secondary"
                style={{ fontSize: initialsPx, boxShadow: "inset 0 0 0 0.5px color-mix(in srgb, var(--color-ink) 8%, transparent)" }}
              >
                {face.you.initials}
              </span>
            )}
          </span>
        );
      })}
    </span>
  );
}

let knownSession: SessionState | null = null;
let knownComputer: string | null | undefined;

/** The person as a group's first face: the sidebar's own "you", else this computer's name, else nobody. */
export function useGroupYou(): GroupYou | null {
  const { state } = useStore();
  const [session, setSession] = useState<SessionState | null>(knownSession);
  const [computer, setComputer] = useState<string | null | undefined>(knownComputer);
  useEffect(() => {
    if (knownSession) return;
    let active = true;
    void readSessionState().then((next) => {
      knownSession = next;
      if (active) setSession(next);
    });
    return () => { active = false; };
  }, []);
  const account = useActiveAccount();
  const profile = profileForSession(state.config?.profile, session);
  const nameless = !profile?.name?.trim() && !profile?.email?.trim();
  useEffect(() => {
    const bridge = window.madaniDesktop?.desktopProfile;
    if (!nameless || knownComputer !== undefined || !bridge) return;
    let active = true;
    void (async () => {
      const full = (await bridge.systemName().catch(() => null))?.trim();
      const login = full ? null : (await bridge.loginName?.().catch(() => null))?.trim();
      knownComputer = full || login || null;
      if (active) setComputer(knownComputer);
    })();
    return () => { active = false; };
  }, [nameless]);
  const face = personFace(profile, account);
  if (!nameless || face) return { initials: profileInitials(profile), ...(profile?.avatarUrl ? { avatarUrl: profile.avatarUrl } : {}), ...(face ? { face } : {}) };
  return computer ? { initials: computer[0]!.toUpperCase() } : null;
}
