import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Award, CreditCard, Crown, Heart, Lock, PartyPopper, Star, Users, X } from "@/icons";
import { cx } from "../ui/kit";
import { SkyEmpty } from "../ui/Sky";
import { ago } from "../lib/format";
import { PersonLink } from "./sheet";
import { useNow } from "../lib/now";
import { countryName } from "./geo";
import { Avatar, duration, personName, usd, type Mark } from "./kit";
import { n } from "./ui";

export type PaymentKind = "new" | "renewal" | "one_time" | "refund";
/** `expected` is paying plus `conversion` of the trials not set to cancel; `full` counts every trial at its price */
export interface MrrForecast { expected: number; paying: number; trials: number; full: number; conversion: number; atRisk?: number; atRiskCount?: number }
export interface RevenueKpis { net: number; gross: number; refunds: number; payments: number; customers: number; newCustomers: number; renewals: number; mrr: number; mrrForecast?: MrrForecast | null }
export interface RecentPayment {
  id: string; at: number; amountCents: number; currency: string; kind: PaymentKind; accountId: string; seed: string; email: string | null;
  source: string; channel: string; firstSource: string | null; campaign: string | null; country: string | null; city: string | null; device: string | null;
  firstSeen: number | null; signedUpAt: number | null;
}
export interface RevenueAnswer {
  current: RevenueKpis; previous: RevenueKpis; series: { new: number[]; renewal: number[]; refund: number[]; mrr?: number[] | null };
  cards: Record<string, Record<string, number>>; recent: RecentPayment[]; live: boolean; first: number | null;
}

const KIND: Record<PaymentKind, { label: string; className: string }> = {
  new: { label: "new", className: "bg-wash-lime text-money" },
  renewal: { label: "renewal", className: "bg-wash-lilac text-ink-2" },
  one_time: { label: "top-up", className: "bg-wash-lemon text-ink-2" },
  refund: { label: "refund", className: "bg-wash-pink text-bad" },
};

/** who paid, how much, where they came from and how long it took them */
export function PaymentsCard({ revenue }: { revenue: RevenueAnswer }) {
  const now = useNow(60_000);
  const [all, setAll] = useState(false);
  const list = all ? revenue.recent : revenue.recent.slice(0, 6);
  return (
    <section aria-labelledby="payments-title" className="flex min-w-0 flex-col rounded-[24px] bg-card p-2">
      <div className="flex items-center justify-between gap-2 px-2 pb-1.5 pt-1">
        <h2 id="payments-title" className="inline-flex h-8 items-center gap-1.5 text-14 font-medium text-ink"><CreditCard size={14} strokeWidth={1.75} aria-hidden /> money in</h2>
        {revenue.recent.length > 0 && <span className="t-meta">{n(revenue.current.payments)} payment{revenue.current.payments === 1 ? "" : "s"} · {usd(revenue.current.net)}</span>}
      </div>
      <div className="flex-1 rounded-[18px] bg-pop p-1.5">
        {!revenue.live ? (
          <SkyEmpty art="notebook" className="!py-8" title="no payments yet.">payments start landing here the moment checkout goes live, each with who paid, where they came from and how long it took.</SkyEmpty>
        ) : !list.length ? (
          <SkyEmpty art="cat" className="!py-8" title="no payments in this window.">try a longer range, or check back after the next renewal.</SkyEmpty>
        ) : (
          <ul className="">
            {list.map((p) => {
              const waited = p.firstSeen !== null && p.kind !== "refund" && p.kind !== "renewal" ? Math.max(0, p.at - p.firstSeen) : null;
              return (
                <li key={p.id}>
                  <PersonLink id={p.accountId} className="hover-row grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 rounded-[12px] px-2.5 py-2.5">
                    <span className="flex min-w-0 items-center gap-3">
                      <Avatar seed={p.seed} size={24} customer={p.kind !== "refund"} />
                      <span className="min-w-0">
                        <span className="flex min-w-0 items-center gap-2">
                          <span className="truncate text-14 font-medium text-ink">{personName(p.seed, p.email)}</span>
                          <span className={cx("inline-flex h-5 shrink-0 items-center rounded-full px-2 text-[11.5px]", KIND[p.kind].className)}>{KIND[p.kind].label}</span>
                        </span>
                        <span className="mt-0.5 block truncate text-12 text-ink-3">
                          via {p.source}{p.firstSource ? `, first from ${p.firstSource}` : ""}{p.country ? ` · ${countryName(p.country)}` : ""}{waited !== null ? ` · paid ${duration(waited)} after the first visit` : ""}
                        </span>
                      </span>
                    </span>
                    <span className="text-end">
                      <span className={cx("block font-mono text-14 font-medium num text-money")}>{p.amountCents > 0 ? "+" : ""}{usd(p.amountCents)}</span>
                      <span className="block text-12 text-ink-4">{ago(p.at, now)}</span>
                    </span>
                  </PersonLink>
                </li>
              );
            })}
          </ul>
        )}
      </div>
      {revenue.recent.length > 6 && <button type="button" onClick={() => setAll((v) => !v)} className="text-link mx-auto mt-1.5 h-8 px-3 text-12">{all ? "show fewer" : `show all ${revenue.recent.length}`}</button>}
    </section>
  );
}

interface Badge { id: string; label: string; icon: ReactNode; done: boolean; progress?: string; wash: string }
/** a few things worth reaching, with how far along each is */
export function milestones(input: { visitorsBest: number; signups: number; accounts: number | null; firstPaid: number | null; customers: number; mrr: number }): Badge[] {
  const I = { size: 14, strokeWidth: 1.75 } as const;
  const list: Badge[] = [
    { id: "paid", label: "first paying customer", icon: <Star {...I} />, done: input.firstPaid !== null, wash: "bg-wash-lime" },
    { id: "day100", label: "100 visitors in a day", icon: <Users {...I} />, done: input.visitorsBest >= 100, progress: `${n(input.visitorsBest)} best`, wash: "bg-wash-sky" },
    { id: "users100", label: "100 accounts", icon: <Heart {...I} />, done: (input.accounts ?? 0) >= 100, progress: input.accounts === null ? undefined : `${n(input.accounts)} so far`, wash: "bg-wash-lilac" },
    { id: "cust10", label: "10 paying customers", icon: <Award {...I} />, done: input.customers >= 10, progress: `${n(input.customers)} so far`, wash: "bg-wash-pink" },
    { id: "mrr1k", label: "$1k a month", icon: <Crown {...I} />, done: input.mrr >= 100_000, progress: `${usd(input.mrr, true)} now`, wash: "bg-wash-lemon" },
  ];
  return list;
}

export function Badges({ badges }: { badges: Badge[] }) {
  return (
    <ul aria-label="milestones" className="flex flex-wrap gap-1.5">
      {badges.map((b) => (
        <li key={b.id} title={b.done ? `reached: ${b.label}` : `not yet: ${b.label}${b.progress ? `, ${b.progress}` : ""}`}
          className={cx("inline-flex h-7 items-center gap-1.5 rounded-full px-2.5 text-12", b.done ? `${b.wash} text-ink` : "bg-pop/70 text-ink-3")}>
          <span aria-hidden className={b.done ? "text-ink-2" : "text-ink-4"}>{b.done ? b.icon : <Lock size={12} strokeWidth={1.75} />}</span>
          <span>{b.label}</span>
          {!b.done && b.progress && <span className="font-mono text-[11px] text-ink-4">{b.progress}</span>}
          <span className="sr-only">{b.done ? "reached" : "not reached yet"}</span>
        </li>
      ))}
    </ul>
  );
}

export interface Cheer { key: string; at: number; text: string; seed: string; money: boolean }
const SEEN = "madani-admin-cheered";
/** signups and payments newer than the last one cheered on this browser; the first visit only remembers, never cheers */
export function useCheer(marks: Mark[] | undefined, payments: RecentPayment[] | undefined) {
  const [cheer, setCheer] = useState<Cheer | null>(null);
  const items = useMemo(() => {
    const list: Cheer[] = [
      ...(payments ?? []).filter((p) => p.amountCents > 0).map((p) => ({ key: `pay:${p.id}`, at: p.at, seed: p.seed, money: true, text: `${personName(p.seed, p.email)} paid ${usd(p.amountCents)}${p.source !== "unknown" ? ` via ${p.source}` : ""}.` })),
      ...(marks ?? []).filter((m) => m.kind === "signup").map((m) => ({ key: `sign:${m.seed}:${m.at}`, at: m.at, seed: m.seed, money: false, text: `${personName(m.seed, m.email)} just signed up.` })),
    ];
    return list.sort((a, b) => b.at - a.at);
  }, [marks, payments]);
  useEffect(() => {
    if (!items.length) return;
    let seen: number | null = null;
    try { const raw = localStorage.getItem(SEEN); seen = raw === null ? null : Number(raw); } catch { return; }
    const newest = items[0]!.at;
    if (seen !== null && newest > seen) setCheer(items.find((item) => item.money && item.at > seen!) ?? items[0]!);
    if (seen === null || newest > seen) { try { localStorage.setItem(SEEN, String(newest)); } catch { /* private mode keeps no memory */ } }
  }, [items]);
  return [cheer, () => setCheer(null)] as const;
}

const CONFETTI = ["var(--viz-new)", "var(--viz-renewal)", "var(--viz-refund)", "var(--viz-visitors)", "#ffd84d"];
/** a little burst and a line; dismissable, and it goes by itself */
export function CheerBubble({ cheer, onClose }: { cheer: Cheer; onClose(): void }) {
  const timer = useRef<number>(0);
  useEffect(() => { timer.current = window.setTimeout(onClose, 9000); return () => clearTimeout(timer.current); }, [cheer.key, onClose]);
  const bits = useMemo(() => Array.from({ length: 18 }, (_, i) => ({ dx: `${Math.round(Math.cos((i / 18) * Math.PI * 2) * (40 + (i % 3) * 22))}px`, dy: `${Math.round(Math.sin((i / 18) * Math.PI * 2) * (30 + (i % 4) * 14) - 20)}px`, r: `${(i % 2 ? 1 : -1) * (90 + i * 20)}deg`, d: `${(i % 5) * 30}ms`, c: CONFETTI[i % CONFETTI.length]! })), []);
  return (
    <div role="status" className="cheer-in relative flex items-center gap-2 rounded-full bg-pop py-1 pe-1 ps-3 text-13 text-ink" style={{ boxShadow: "var(--pop-shadow)" }}>
      <span className="pointer-events-none absolute left-6 top-1/2" aria-hidden>
        {bits.map((b, i) => <span key={i} className="confetti rounded-[1px]" style={{ background: b.c, ["--dx" as string]: b.dx, ["--dy" as string]: b.dy, ["--r" as string]: b.r, ["--d" as string]: b.d }} />)}
      </span>
      <PartyPopper size={14} strokeWidth={1.75} aria-hidden className={cheer.money ? "text-money" : "text-coral-deep"} />
      <span className="max-w-[46ch] truncate">{cheer.text}</span>
      <button type="button" onClick={onClose} aria-label="dismiss" className="hover-ghost grid size-7 place-items-center rounded-full text-ink-3"><X size={13} strokeWidth={2} /></button>
    </div>
  );
}
