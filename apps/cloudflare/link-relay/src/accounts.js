import { DurableObject } from "cloudflare:workers";

import { DEFAULT_LIMITS, accountReport, dayOf, monthOf, tunnelAnswer } from "./fair-use.js";
import { KEEP_DAYS, LEASE_MS, LIVE_MS, ROLLUP_MS, admitTunnel, applyLimits, costCents, globalShareOf, isBusy, normalizeLimits, projected } from "./ops.js";

const opsOf = (env) => env.OPS.get(env.OPS.idFromName("ops"));

/** one madani account's relay month: bytes, its active tunnels and the rate they share */
export class AccountUsage extends DurableObject {
  async load() {
    if (this.state === undefined) this.state = (await this.ctx.storage.get("usage")) ?? null;
    return this.state;
  }

  async report({ acct, tunnel, bytes, bytesOut = 0, bytesIn = 0, awakeMs = 0, messages = 0 }) {
    const t = Date.now();
    const { state, answer } = accountReport(await this.load(), { tunnel, bytes, bytesOut, bytesIn, awakeMs, messages, t }, this.policy ?? {});
    this.state = state;
    await this.ctx.storage.put("usage", state);
    const slowed = answer.accountRate < (this.policy?.limits ?? DEFAULT_LIMITS).accountBytesPerSec;
    if (!this.policy || !this.rolledAt || t - this.rolledAt >= ROLLUP_MS || (slowed && !this.rolledSlow)) {
      this.rolledAt = t;
      this.rolledSlow = slowed;
      try {
        this.policy = await opsOf(this.env).upsert({ acct, month: state.month, bytes: state.bytes, bytesOut: state.bytesOut, bytesIn: state.bytesIn, awakeMs: state.awakeMs,
          messages: state.messages, rate: answer.accountRate, tunnels: answer.active, slowedAt: state.slowedAt, t });
        return tunnelAnswer(state, { tunnel, t }, this.policy);
      } catch { this.rolledAt = 0; }
    }
    return answer;
  }

  async usage() {
    const state = await this.load();
    const month = monthOf(Date.now());
    return state && state.month === month ? state : { month, bytes: 0, tunnels: {}, slowedAt: null };
  }
}

/** every account's month in one table, the tunnels on the relay, and the owner's limits, for the admin ops page */
export class OpsUsage extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    const sql = ctx.storage.sql;
    sql.exec(`CREATE TABLE IF NOT EXISTS usage (acct TEXT NOT NULL, month TEXT NOT NULL, bytes INTEGER NOT NULL, rate INTEGER NOT NULL,
      tunnels INTEGER NOT NULL, slowed_at INTEGER, updated_at INTEGER NOT NULL, PRIMARY KEY (acct, month))`);
    sql.exec("CREATE INDEX IF NOT EXISTS usage_month_bytes ON usage (month, bytes DESC)");
    // columns added after the first deploy; adding one that is there already throws, which is fine
    for (const column of ["bytes_out", "bytes_in", "awake_ms", "messages"]) {
      try { sql.exec(`ALTER TABLE usage ADD COLUMN ${column} INTEGER NOT NULL DEFAULT 0`); } catch { /* there already */ }
    }
    sql.exec("CREATE TABLE IF NOT EXISTS tunnels (id TEXT PRIMARY KEY, acct TEXT NOT NULL, connected_at INTEGER NOT NULL, seen_at INTEGER NOT NULL)");
    sql.exec("CREATE INDEX IF NOT EXISTS tunnels_seen ON tunnels (seen_at)");
    sql.exec("CREATE TABLE IF NOT EXISTS days (day TEXT PRIMARY KEY, bytes_out INTEGER NOT NULL, bytes_in INTEGER NOT NULL)");
    sql.exec("CREATE TABLE IF NOT EXISTS acct_days (day TEXT NOT NULL, acct TEXT NOT NULL, bytes INTEGER NOT NULL, PRIMARY KEY (day, acct))");
    sql.exec("CREATE INDEX IF NOT EXISTS acct_days_bytes ON acct_days (day, bytes DESC)");
    /** acct -> { out, in, tunnels, at }: speeds from the last roll-ups, lost on a restart and rebuilt within seconds */
    this.live = new Map();
  }

  async limits() {
    if (!this.current) this.current = normalizeLimits(await this.ctx.storage.get("limits"));
    return this.current;
  }

  async setLimits(patch) {
    const done = applyLimits(await this.limits(), patch);
    if (!done.ok) return done;
    await this.ctx.storage.put("limits", done.limits);
    this.current = done.limits;
    return done;
  }

  liveTunnels(t) {
    const since = t - LEASE_MS;
    const [row] = this.ctx.storage.sql.exec("SELECT COUNT(*) AS tunnels, COUNT(DISTINCT acct) AS accounts FROM tunnels WHERE seen_at > ?", since).toArray();
    return row;
  }

  /** a linked server's standing socket asks to get on */
  async admit({ id, acct }) {
    const t = Date.now(), since = t - LEASE_MS, sql = this.ctx.storage.sql;
    const limits = await this.limits();
    const known = sql.exec("SELECT 1 FROM tunnels WHERE id = ? AND seen_at > ?", id, since).toArray().length > 0;
    const [{ total }] = sql.exec("SELECT COUNT(*) AS total FROM tunnels WHERE seen_at > ? AND id != ?", since, id).toArray();
    const [{ forAccount }] = sql.exec("SELECT COUNT(*) AS forAccount FROM tunnels WHERE seen_at > ? AND acct = ? AND id != ?", since, acct, id).toArray();
    const refused = admitTunnel(limits, { known, total, forAccount });
    if (refused) return { ok: false, ...refused };
    sql.exec(`INSERT INTO tunnels (id, acct, connected_at, seen_at) VALUES (?, ?, ?, ?)
      ON CONFLICT (id) DO UPDATE SET acct = excluded.acct, seen_at = excluded.seen_at, connected_at = CASE WHEN tunnels.seen_at > ? THEN tunnels.connected_at ELSE excluded.connected_at END`, id, acct, t, t, since);
    return { ok: true };
  }

  seen({ id, acct }) {
    const t = Date.now();
    this.ctx.storage.sql.exec("INSERT INTO tunnels (id, acct, connected_at, seen_at) VALUES (?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET seen_at = excluded.seen_at", id, acct, t, t);
  }

  drop({ id }) {
    this.ctx.storage.sql.exec("DELETE FROM tunnels WHERE id = ?", id);
  }

  /** an account's month so far (cumulative figures); answers the limits and this tunnel's part of the global ceiling */
  async upsert({ acct, month, bytes, bytesOut = 0, bytesIn = 0, awakeMs = 0, messages = 0, rate, tunnels, slowedAt, t }) {
    const sql = this.ctx.storage.sql;
    const [before] = sql.exec("SELECT bytes_out AS bytesOut, bytes_in AS bytesIn, updated_at AS updatedAt FROM usage WHERE acct = ? AND month = ?", acct, month).toArray();
    const dOut = Math.max(0, bytesOut - (before?.bytesOut ?? 0)), dIn = Math.max(0, bytesIn - (before?.bytesIn ?? 0));
    sql.exec(`INSERT INTO usage (acct, month, bytes, rate, tunnels, slowed_at, updated_at, bytes_out, bytes_in, awake_ms, messages) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (acct, month) DO UPDATE SET bytes = excluded.bytes, rate = excluded.rate, tunnels = excluded.tunnels, slowed_at = excluded.slowed_at, updated_at = excluded.updated_at,
        bytes_out = excluded.bytes_out, bytes_in = excluded.bytes_in, awake_ms = excluded.awake_ms, messages = excluded.messages`,
    acct, month, bytes, rate, tunnels, slowedAt ?? null, t, bytesOut, bytesIn, awakeMs, messages);
    const day = dayOf(t);
    if (dOut || dIn) {
      sql.exec("INSERT INTO days (day, bytes_out, bytes_in) VALUES (?, ?, ?) ON CONFLICT (day) DO UPDATE SET bytes_out = bytes_out + excluded.bytes_out, bytes_in = bytes_in + excluded.bytes_in", day, dOut, dIn);
      sql.exec("INSERT INTO acct_days (day, acct, bytes) VALUES (?, ?, ?) ON CONFLICT (day, acct) DO UPDATE SET bytes = bytes + excluded.bytes", day, acct, dOut + dIn);
    }
    // the gap since the last roll-up, but an idle stretch before it does not dilute the speed
    const seconds = Math.min(15, Math.max(1, (t - (before?.updatedAt ?? t - ROLLUP_MS)) / 1000));
    this.live.set(acct, { out: dOut / seconds, in: dIn / seconds, tunnels, at: t });
    let active = 0;
    for (const [key, one] of this.live) { if (t - one.at > LIVE_MS) this.live.delete(key); else active += one.tunnels; }
    const limits = await this.limits();
    return { limits, globalShare: globalShareOf(limits, active) };
  }

  async top({ month, limit }) {
    const accounts = this.ctx.storage.sql.exec("SELECT acct, bytes, rate, tunnels, slowed_at AS slowedAt, updated_at AS updatedAt FROM usage WHERE month = ? ORDER BY bytes DESC LIMIT ?", month, limit).toArray();
    const cap = (await this.limits()).accountBytesPerSec;
    const [totals] = this.ctx.storage.sql.exec("SELECT COUNT(*) AS accounts, COALESCE(SUM(bytes), 0) AS bytes, COALESCE(SUM(CASE WHEN rate < ? THEN 1 ELSE 0 END), 0) AS slowed FROM usage WHERE month = ?", cap, month).toArray();
    return { month, totals, accounts };
  }

  /** GET /ops/relay/stats */
  async stats() {
    const t = Date.now(), sql = this.ctx.storage.sql, month = monthOf(t), day = dayOf(t);
    const limits = await this.limits();
    sql.exec("DELETE FROM tunnels WHERE seen_at < ?", t - 24 * 3_600_000);
    sql.exec("DELETE FROM acct_days WHERE day < ?", dayOf(t - KEEP_DAYS * 86_400_000));
    sql.exec("DELETE FROM days WHERE day < ?", dayOf(t - 40 * 86_400_000));
    const { tunnels, accounts } = this.liveTunnels(t);
    let out = 0, inbound = 0;
    for (const one of this.live.values()) if (t - one.at <= LIVE_MS) { out += one.out; inbound += one.in; }
    const [today] = sql.exec("SELECT bytes_out AS bytesOut, bytes_in AS bytesIn FROM days WHERE day = ?", day).toArray();
    const [m] = sql.exec("SELECT COALESCE(SUM(bytes_out), 0) AS bytesOut, COALESCE(SUM(bytes_in), 0) AS bytesIn, COALESCE(SUM(awake_ms), 0) AS awakeMs, COALESCE(SUM(messages), 0) AS messages FROM usage WHERE month = ?", month).toArray();
    const perAccount = new Map(sql.exec("SELECT acct, COUNT(*) AS n FROM tunnels WHERE seen_at > ? GROUP BY acct", t - LEASE_MS).toArray().map((row) => [row.acct, row.n]));
    const top = sql.exec("SELECT acct, bytes FROM acct_days WHERE day = ? ORDER BY bytes DESC LIMIT 10", day).toArray()
      .map((row) => ({ account: row.acct, tunnels: perAccount.get(row.acct) ?? 0, bytesToday: row.bytes }));
    const monthCents = costCents(m);
    return {
      relay: "cloudflare",
      now: { tunnels, accounts, bytesPerSecOut: Math.round(out), bytesPerSecIn: Math.round(inbound), cpu: null, rssMb: null },
      today: { bytesOut: today?.bytesOut ?? 0, bytesIn: today?.bytesIn ?? 0 },
      month: { bytesOut: m.bytesOut, bytesIn: m.bytesIn, projectedBytesOut: projected(m.bytesOut, t), allowanceBytes: null },
      limits,
      top,
      busy: isBusy(limits, tunnels),
      cost: { estimated: true, monthCents: Math.round(monthCents * 100) / 100, projectedCents: projected(monthCents * 100, t) / 100,
        awakeHours: Math.round((m.awakeMs / 3_600_000) * 10) / 10, messages: m.messages },
      at: t,
    };
  }
}
