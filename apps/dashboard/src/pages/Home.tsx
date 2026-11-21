import { useEffect, useMemo, type ReactNode } from "react";
import { ArrowUpRight, ChevronRight, Download, LayoutGrid, Smartphone } from "@/icons";
import { useCloud } from "../data/cloud";
import { useWorkspaceDetail } from "../data/detail";
import { MOOD_LABEL, type BotMood } from "../data/mood";
import { useSession } from "../data/session";
import { useAccountUsage, type BotRow } from "../data/usage";
import { ago, plural } from "../lib/format";
import { useNow } from "../lib/now";
import { Link } from "../lib/router";
import { DOWNLOAD_URL } from "../lib/usage";
import { Card, cx, Skeleton } from "../ui/kit";
import { dailyLine } from "../lib/fun";
import { BotMascot, Mascot } from "../ui/Mascot";
import { cheerOnce } from "../lib/cheer";
import { CloudCard, MoveGuide } from "./cloud-card";
import { Activity } from "./activity";
import { CloudHero } from "./cloud-offer";
import { LoadError } from "./common";
import { RecentEmpty, StatTiles, WeekStrip } from "./home-stats";
import { homeStats } from "../data/week";

const ORDER: Record<BotMood, number> = { working: 0, waking: 1, idle: 2, drowsy: 3, sleeping: 4 };
const DOT: Record<BotMood, string> = { working: "text-good", waking: "text-warn", idle: "text-accent", drowsy: "text-ink-4", sleeping: "text-ink-4" };

/** every bot on every workspace and what each is doing right now */
function Crew({ rows }: { rows: BotRow[] }) {
  const shown = useMemo(() => [...rows].sort((a, b) => ORDER[a.mood] - ORDER[b.mood] || (b.bot.lastActiveAt ?? 0) - (a.bot.lastActiveAt ?? 0)).slice(0, 8), [rows]);
  const working = rows.filter((r) => r.mood === "working").length;
  const pill = "bg-pop text-ink";
  return (
    <section className="surface enter relative isolate overflow-hidden rounded-card bg-card" style={{ ["--i" as string]: 1 }} aria-labelledby="crew-title">
      <div className="flex items-center justify-between gap-3 px-5 pt-5">
        <h2 id="crew-title" className={cx("flex h-7 items-center gap-2 rounded-full px-3 text-13 font-medium", pill)}><span className={cx("live-dot", working ? "text-good" : "text-ink-4")} data-live={working > 0} />{working ? `${working} of ${plural(rows.length, "bot")} working` : `${plural(rows.length, "bot")}, all quiet`}</h2>
        <Link to="/bots" className={cx("press inline-flex h-7 items-center gap-0.5 rounded-full ps-3 pe-2 text-13 font-medium", pill)}>all bots<ChevronRight size={14} strokeWidth={2} aria-hidden /></Link>
      </div>
      <ul className="scroll-x flex items-end gap-x-7 px-6 pb-5 pt-6 sm:justify-center max-sm:gap-x-4">
        {shown.map(({ bot, where, mood }, i) => (
          <li key={`${where}-${bot.id}`} className="peek flex shrink-0 flex-col items-center gap-2.5" style={{ ["--i" as string]: i }}>
            <BotMascot bot={bot} mood={mood} size={56} track={640} tappable />
            <span className={cx("flex h-7 items-center gap-1.5 whitespace-nowrap rounded-full px-3 text-13", pill)}>
              <span className={cx("live-dot", DOT[mood])} data-live={mood === "working"} aria-hidden />
              <b className="font-medium">{bot.name}</b>
              <span className="text-ink-3">{MOOD_LABEL[mood]}</span>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** nobody here yet: a few bots asleep on the wash, and the way to get the first one */
function CrewEmpty() {
  return (
    <section className="surface enter flex items-center gap-5 rounded-card bg-card p-5 max-sm:flex-col max-sm:items-start max-sm:gap-3" style={{ ["--i" as string]: 1 }} aria-labelledby="crew-empty-title">
      <span className="flex shrink-0 items-end gap-1" aria-hidden>
        <Mascot body="kit" color="blue" size={34} state="sleeping" tappable />
        <Mascot body="wisp" color="purple" size={42} state="sleeping" tappable />
        <Mascot body="pip" color="green" size={30} state="sleeping" tappable />
      </span>
      <div className="min-w-0">
        <h2 id="crew-empty-title" className="text-16 font-medium tracking-[-0.02em] text-ink">no bots yet</h2>
        <p className="text-14 text-ink-2">make one in the app and it shows up here. this lot is keeping the spot warm.</p>
      </div>
    </section>
  );
}

const TINT = { sky: "bg-sky", lime: "bg-lime", rose: "bg-rose", lemon: "bg-lemon" } as const;
const ICON = { size: 20, strokeWidth: 1.75 } as const;

function Tile({ icon, tint, title, body, to, external }: { icon: ReactNode; tint: keyof typeof TINT; title: string; body: string; to: string; external?: boolean }) {
  const inner = (
    <>
      <span className={cx("grid size-11 shrink-0 place-items-center rounded-[14px] text-ink", TINT[tint])}>{icon}</span>
      <span className="min-w-0 md:mt-5">
        <span className="block text-16 font-medium tracking-[-0.02em] text-ink">{title}</span>
        <span className="mt-0.5 block text-13 leading-[1.45] text-ink-3">{body}</span>
      </span>
      <ArrowUpRight size={17} className="tile-arrow absolute right-5 top-5 text-ink-4 max-md:top-1/2 max-md:-translate-y-1/2" aria-hidden />
    </>
  );
  const cls = "surface hover-tile relative flex h-full items-center gap-4 rounded-card bg-card p-5 pe-12 text-start md:flex-col md:items-start md:gap-0";
  return external ? <a href={to} className={cls} target="_blank" rel="noreferrer">{inner}</a> : <Link to={to} className={cls}>{inner}</Link>;
}

/** the bots that ran last, across every workspace */
function Recent({ rows: all }: { rows: BotRow[] }) {
  const now = useNow();
  const rows = useMemo(() => all.filter((r) => r.bot.lastActiveAt).sort((a, b) => Number(b.bot.busy) - Number(a.bot.busy) || (b.bot.lastActiveAt ?? 0) - (a.bot.lastActiveAt ?? 0)).slice(0, 5), [all]);
  if (!rows.length) return <RecentEmpty />;
  return (
    <Card className="enter !p-3" style={{ ["--i" as string]: 7 }} aria-labelledby="recent-title">
      <h2 id="recent-title" className="px-3 pb-1 pt-2 text-16 font-medium tracking-[-0.02em] text-ink">who ran last</h2>
      <ul className="px-3">
        {rows.map(({ bot, where, mood }) => (
          <li key={`${where}-${bot.id}`} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-4 py-3 md:grid-cols-[minmax(0,1fr)_200px_130px]">
            <span className="flex min-w-0 items-center gap-3">
              <BotMascot bot={bot} mood={mood} size={30} />
              <span className="min-w-0">
                <span className="block truncate text-14 text-ink">{bot.name}<span className="text-ink-3"> on {where}</span></span>
                {bot.model && <span className="block truncate text-13 text-ink-4 md:hidden">{bot.model}</span>}
              </span>
            </span>
            <span className="t-id truncate text-ink-3 max-md:hidden">{bot.model ?? ""}</span>
            <span className="num text-end text-13 text-ink-3">{bot.busy ? <span className="text-good">working now</span> : ago(bot.lastActiveAt, now)}</span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

export function HomePage() {
  const { account, detail } = useSession();
  const { account: profile, clouds, connections, error, refresh } = useCloud();
  const { bots, sources, loading } = useAccountUsage();
  const now = useNow(60_000);
  const name = profile?.profile.name || account?.name || account?.email.split("@")[0] || "";
  const cloud = clouds?.[0] ?? null;
  const cloudDetail = useWorkspaceDetail(cloud?.workspaceId ?? null);
  useEffect(() => { if (bots.length) cheerOnce(account?.id, "first-bot", "your first bot is here. say hi in the app."); }, [bots.length > 0, account?.id]);
  useEffect(() => { if (cloud?.status === "running") cheerOnce(account?.id, "first-cloud", `${cloud.name} is up. your bots never sleep now.`, { confetti: true }); }, [cloud?.status, account?.id]);
  const stats = useMemo(() => homeStats(sources, bots, connections, now), [sources, bots, connections, now]);
  const crew = cloud ? null : bots.length ? <Crew rows={bots} /> : loading ? <Skeleton className="h-[200px] !rounded-card" /> : <CrewEmpty />;
  return (
    <div>
      {/* the greeting is for someone who bought madani cloud; everyone else starts on the offer */}
      {cloud ? <div className="enter mb-8 max-sm:mb-6">
        <h1 className="t-title">hi {name}.</h1>
        <p className="mt-2 text-15 text-ink-3">{dailyLine(now)}</p>
      </div> : <h1 className="sr-only">home</h1>}
      <div className="flex flex-col gap-4">
        {error && clouds === null ? <LoadError error={error} retry={refresh} /> : clouds === null ? <Skeleton className="h-[360px] !rounded-card" /> : cloud ? <CloudCard cloud={cloud} detail={cloudDetail} /> : <CloudHero />}
        {clouds !== null && <>
          {cloud && <MoveGuide cloud={cloud} rows={bots} cloudBots={cloudDetail?.report?.bots ?? null} />}
          {crew}
          {loading && !bots.length ? <Skeleton className="h-[176px] !rounded-card" /> : <>
            <StatTiles stats={stats} />
            <WeekStrip stats={stats} />
          </>}
          <div className="enter grid grid-cols-3 gap-4 max-md:grid-cols-1 max-sm:gap-3" style={{ ["--i" as string]: 5 }}>
            <Tile tint="sky" icon={<Download {...ICON} />} title="get the app" body="make bots and chat with them." to={DOWNLOAD_URL} external />
            <Tile tint="rose" icon={<Smartphone {...ICON} />} title="link your phone" body="text your bots from anywhere." to="/account#devices" />
            <Tile tint="lemon" icon={<LayoutGrid {...ICON} />} title="apps" body="gmail, slack, github and more." to="/connectors" />
          </div>
          {/* a year of empty squares says nothing to someone with no bots yet; it shows once there is anything to fill it */}
          {(detail?.report?.activity || bots.length > 0) && <Activity detail={detail?.report?.activity ? detail : null} now={now} className="enter" style={{ ["--i" as string]: 6 }} />}
          <Recent rows={bots} />
        </>}
      </div>
    </div>
  );
}
