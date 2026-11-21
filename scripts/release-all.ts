// publish once, everything updates (docs/releases-auto-update.md). Run on the Mac from a clean checkout of the release
// tag after Release published v<version>: it stages the desktop rollout, puts the desktop build on madani.bot, builds and
// signs the madani cloud home package and offers it to the canary clouds, watches them and the desktops' error rate, then
// widens to every cloud and desktop, publishes the own-server build to the link service and ships a changed link agent.
// Each step is recorded in release/auto/<version>.json, so a rerun goes on where it stopped; --dry-run changes nothing.
//
//   node scripts/release-all.ts 0.2.26 [--dry-run] [--now] [--canary <cloud id,...>] [--desktop-steps 10,50,100] [--watch 30] [--skip-build]
//   node scripts/release-all.ts status [--canary <cloud id,...>]
//   node scripts/release-all.ts pause | resume | block <version> [--dry-run]
//
// env (names only, never printed): MADANI_RELEASE_SIGNING_KEY (release key), MADANI_OPS_TOKEN (the account service's fleet
// view), RELEASE_ACCOUNT_URL (https://madani.bot), RELEASE_SSH (contabo), RELEASE_HOME_DIR (/var/lib/madani-account-prod/home),
// RELEASE_LINK_PACKAGES (/root/omb-link-data/packages), RELEASE_LINK_URL (https://link.madani.bot), MADANI_RELEASE_CANARY_CLOUDS.
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { compareVersions, NO_POLICY, parsePolicy, type UpdatePolicy } from "../shared/update-guard.ts";
import { parseReleaseKeys, PINNED_RELEASE_KEYS, signRelease } from "../apps/cloud-service/src/release-signing.ts";
import { signPolicy, verifyPolicy } from "../apps/cloud-service/src/update-policy.ts";
import type { FleetAnswer } from "../apps/dashboard/server/admin/ops/fleet.ts";

const SEMVER = /^\d+\.\d+\.\d+$/;
export interface Config {
  account: string; ssh: string; homeDir: string; linkPackages: string; linkUrl: string;
  /** the account service's MADANI_UPDATE_POLICY_FILE and MADANI_MANAGED_HOME_RELEASE_FILE */
  policyFile: string; releaseFile: string;
}
export function configOf(env: Record<string, string | undefined>): Config {
  const homeDir = env.RELEASE_HOME_DIR || "/var/lib/madani-account-prod/home";
  return { account: (env.RELEASE_ACCOUNT_URL || "https://madani.bot").replace(/\/$/, ""), ssh: env.RELEASE_SSH || "contabo", homeDir,
    linkPackages: env.RELEASE_LINK_PACKAGES || "/root/omb-link-data/packages", linkUrl: (env.RELEASE_LINK_URL || "https://link.madani.bot").replace(/\/$/, ""),
    policyFile: `${homeDir}/update-policy.json`, releaseFile: `${homeDir}/release.json` };
}

/** the shares a desktop rollout goes through, each a whole percent, ending at 100 */
export function rolloutSteps(value: string | undefined, now: boolean): number[] {
  if (now) return [100];
  const steps = (value ?? "10,50,100").split(",").map(Number);
  if (!steps.every(n => Number.isInteger(n) && n > 0 && n <= 100) || steps.some((n, i) => i > 0 && n <= steps[i - 1]!) || steps.at(-1) !== 100) throw new Error("--desktop-steps must grow and end at 100, like 10,50,100");
  return steps;
}

/** the next policy: a serial past both the one served and any this tool signed, and `change` applied */
export function nextPolicy(current: UpdatePolicy, lastSerial: number, change: { rollout?: [string, number | null]; paused?: boolean; block?: string }): UpdatePolicy {
  const rollout = { ...current.rollout };
  if (change.rollout) { const [version, share] = change.rollout; if (share === null || share >= 100) delete rollout[version]; else rollout[version] = share; }
  for (const version of Object.keys(rollout)) if (current.floor && compareVersions(version, current.floor) < 0) delete rollout[version];
  const paused = change.paused ?? current.paused ?? false;
  return parsePolicy({ serial: Math.max(current.serial, lastSerial) + 1, floor: current.floor, blocked: change.block ? [...new Set([...current.blocked, change.block])] : current.blocked,
    ...(paused ? { paused: true } : {}), ...(Object.keys(rollout).length ? { rollout } : {}) });
}

export interface Judgement { verdict: "healthy" | "wait" | "halt" | "timeout"; why: string }
/**
 * the canary's health: halt at the first canary cloud that rolled `version` back or got stuck, or when desktops on
 * `version` send errors at `errorRatio` times the rate of the version before (once `minInstalls` run it); healthy once
 * `watchMs` went by with at least one canary cloud through its self-test on it (or no canary clouds), else a timeout
 * after `maxWaitMs`
 */
export function judge(fleet: Pick<FleetAnswer, "desktops" | "clouds">, o: { version: string; canary: readonly string[]; startedAt: number; now: number; watchMs: number; maxWaitMs: number; minInstalls?: number; errorRatio?: number }): Judgement {
  const bad = fleet.clouds.canary.find(c => c.rolledBack === o.version || c.stuck);
  if (bad) return { verdict: "halt", why: `canary cloud ${bad.id} ${bad.stuck ? "is stuck" : `rolled ${o.version} back`}` };
  const rows = fleet.desktops.versions, mine = rows.find(r => r.version === o.version);
  const before = rows.filter(r => compareVersions(r.version, o.version) < 0 && r.installs > 0).sort((a, b) => compareVersions(b.version, a.version))[0];
  const rate = (r: { installs: number; errors: number }) => r.errors / Math.max(1, r.installs);
  if (mine && mine.installs >= (o.minInstalls ?? 20) && rate(mine) > (o.errorRatio ?? 3) * Math.max(before ? rate(before) : 0, 0.05)) {
    return { verdict: "halt", why: `desktops on ${o.version} send ${rate(mine).toFixed(2)} errors per install${before ? ` against ${rate(before).toFixed(2)} on ${before.version}` : ""}` };
  }
  const through = fleet.clouds.canary.filter(c => c.version === o.version && c.trial !== "pending").length;
  const waited = o.now - o.startedAt;
  if (waited < o.watchMs) return { verdict: "wait", why: `watching (${Math.round(waited / 60_000)} of ${Math.round(o.watchMs / 60_000)} minutes)` };
  if (o.canary.length && through === 0) return waited < o.maxWaitMs ? { verdict: "wait", why: "no canary cloud is through its self-test yet" } : { verdict: "timeout", why: `no canary cloud took ${o.version}` };
  return { verdict: "healthy", why: `${through} canary cloud(s) on ${o.version}, desktops ${mine ? `${mine.installs} installs, ${mine.errors} errors` : "not seen yet"}` };
}

interface State { version: string; done: Record<string, number>; serial: number; watch: Record<string, number>; halted: string | null; cloud?: { sha256: string; signature: string; file: string } }
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export function createRelease(o: { cfg: Config; env: Record<string, string | undefined>; dryRun: boolean; fetchImpl?: typeof fetch; now?: () => number; sleep?: (ms: number) => Promise<void>;
  sh?: (cmd: string, args: string[], input?: string) => string; log?: (line: string) => void; stateDir?: string; siteDir?: string }) {
  const { cfg, env, dryRun } = o, log = o.log ?? (line => console.log(line)), now = o.now ?? Date.now, fetchImpl = o.fetchImpl ?? fetch;
  const sleep = o.sleep ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const realSh = (cmd: string, args: string[], input?: string) => execFileSync(cmd, args, { cwd: ROOT, encoding: "utf8", stdio: [input === undefined ? "inherit" : "pipe", "pipe", "inherit"], ...(input === undefined ? {} : { input }) }).trim();
  const sh = o.sh ?? realSh;
  /** a command that changes something: only told in a dry run */
  const act = (cmd: string, args: string[], input?: string) => { if (dryRun) { log(`  would run: ${cmd} ${args.join(" ")}`); return ""; } return sh(cmd, args, input); };
  const keys = [...PINNED_RELEASE_KEYS, ...parseReleaseKeys(env.MADANI_RELEASE_PUBLIC_KEYS)];
  const signingKey = () => env.MADANI_RELEASE_SIGNING_KEY || (dryRun ? null : (() => { throw new Error("MADANI_RELEASE_SIGNING_KEY is not set"); })());

  /** a file put on the host by rename, so the service never reads half of it */
  function place(remote: string, text: string) {
    const part = `${remote}.part-${randomBytes(4).toString("hex")}`;
    act("ssh", ["-o", "BatchMode=yes", cfg.ssh, `umask 077 && cat > '${part}' && mv -f '${part}' '${remote}'`], text);
  }

  /** the policy in force: the account service's, or (it down, so a pause still works) the file it reads, read over ssh */
  async function currentPolicy(): Promise<UpdatePolicy> {
    const answer = await fetchImpl(`${cfg.account}/v1/updates/policy`, { signal: AbortSignal.timeout(20_000), cache: "no-store" }).catch(() => null);
    if (answer?.status === 404) return { ...NO_POLICY, blocked: [] };
    if (answer?.ok) return verifyPolicy(await answer.json(), keys);
    log(`  ${cfg.account}/v1/updates/policy answered ${answer?.status ?? "nothing"}; reading ${cfg.policyFile} instead`);
    let text = "";
    try { text = sh("ssh", ["-o", "BatchMode=yes", cfg.ssh, `cat '${cfg.policyFile}' 2>/dev/null || true`]); } catch (error) { if (!dryRun) throw error; }
    if (text) return verifyPolicy(JSON.parse(text), keys);
    if (!dryRun) throw new Error(`no policy could be read from ${cfg.account} or ${cfg.ssh}:${cfg.policyFile}`);
    log("  (dry run) going on from no policy");
    return { ...NO_POLICY, blocked: [] };
  }

  /** signs the next policy and puts it where every kind of install reads it: the account service, the link service, madani.bot */
  async function publishPolicy(state: Pick<State, "serial">, change: Parameters<typeof nextPolicy>[2]) {
    const policy = nextPolicy(await currentPolicy(), state.serial, change);
    const key = signingKey();
    const text = `${JSON.stringify(key ? signPolicy(policy, key) : { body: JSON.stringify(policy), signature: "(dry run)" })}\n`;
    log(`policy ${policy.serial}: floor ${policy.floor ?? "none"}, blocked ${policy.blocked.join(",") || "none"}${policy.paused ? ", paused" : ""}${policy.rollout ? `, rollout ${JSON.stringify(policy.rollout)}` : ""}`);
    place(cfg.policyFile, text);
    place(`${cfg.linkPackages}/update-policy.json`, text);
    const site = o.siteDir ?? join(ROOT, "apps", "site", "public", "landing", "releases");
    if (!dryRun) { mkdirSync(site, { recursive: true }); writeFileSync(join(site, "update-policy.json"), text); }
    act("sh", ["-c", "cd apps/site && ./deploy.sh landing"]);
    state.serial = policy.serial;
  }

  async function fleet(canary: readonly string[]): Promise<FleetAnswer> {
    const token = env.MADANI_OPS_TOKEN;
    if (!token) throw new Error("MADANI_OPS_TOKEN is not set: the fleet view needs it");
    const answer = await fetchImpl(`${cfg.account}/v1/ops/fleet?days=14${canary.length ? `&canary=${canary.map(encodeURIComponent).join(",")}` : ""}`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000) });
    if (!answer.ok) throw new Error(`the fleet view answered ${answer.status}`);
    return await answer.json() as FleetAnswer;
  }

  return { cfg, place, currentPolicy, publishPolicy, fleet, act, sh, log, now, sleep, keys, signingKey, fetchImpl,
    stateFile: (version: string) => join(o.stateDir ?? join(ROOT, "release", "auto"), `${version}.json`) };
}
type Release = ReturnType<typeof createRelease>;

function loadState(r: Release, version: string, dryRun: boolean): State {
  const file = r.stateFile(version);
  const fresh: State = { version, done: {}, serial: 0, watch: {}, halted: null };
  if (!existsSync(file)) return fresh;
  const state = JSON.parse(readFileSync(file, "utf8")) as State;
  if (!dryRun) r.log(`resuming ${version}: ${Object.keys(state.done).join(", ") || "nothing"} done`);
  return { ...fresh, ...state };
}
function saveState(r: Release, state: State, dryRun: boolean) {
  if (dryRun) return;
  mkdirSync(dirname(r.stateFile(state.version)), { recursive: true });
  writeFileSync(r.stateFile(state.version), `${JSON.stringify(state, null, 2)}\n`);
}

export interface ReleaseOptions { version: string; now: boolean; canary: string[]; steps: number[]; watchMs: number; maxWaitMs: number; skipBuild: boolean; dryRun: boolean; pollMs?: number }

/** the whole release, step by step; returns "done", or "halted" / "waiting" when it stopped on purpose */
export async function release(r: Release, opt: ReleaseOptions): Promise<"done" | "halted" | "waiting"> {
  const { version, dryRun } = opt, V = `v${version}`;
  if (!SEMVER.test(version)) throw new Error(`not a release version: ${version}`);
  const state = loadState(r, version, dryRun);
  if (state.halted) { r.log(`${version} was halted (${state.halted}); fix it and release a new version`); return "halted"; }
  const step = async (name: string, fn: () => Promise<void> | void) => {
    if (state.done[name]) { r.log(`- ${name}: done before`); return; }
    r.log(`- ${name}`);
    await fn();
    state.done[name] = r.now();
    saveState(r, state, dryRun);
  };
  const halt = async (why: string) => {
    r.log(`HALT ${version}: ${why}; blocking it everywhere`);
    await r.publishPolicy(state, { block: version, rollout: [version, null] });
    state.halted = why;
    saveState(r, state, dryRun);
    return "halted" as const;
  };
  /** watches the canary; true when healthy, else it halted or must be resumed later */
  const watch = async (name: string, canary: readonly string[]): Promise<"healthy" | "halted" | "waiting"> => {
    if (state.done[name]) return "healthy";
    state.watch[name] ??= r.now();
    saveState(r, state, dryRun);
    for (;;) {
      const verdict = dryRun ? { verdict: "healthy", why: "dry run" } as Judgement
        : judge(await r.fleet(canary), { version, canary, startedAt: state.watch[name]!, now: r.now(), watchMs: opt.watchMs, maxWaitMs: opt.maxWaitMs });
      r.log(`  ${name}: ${verdict.verdict} (${verdict.why})`);
      if (verdict.verdict === "halt") return halt(verdict.why);
      if (verdict.verdict === "timeout") { r.log(`  ${name} timed out; rerun to keep waiting, or pass --now`); return "waiting"; }
      if (verdict.verdict === "healthy") { state.done[name] = r.now(); saveState(r, state, dryRun); return "healthy"; }
      await r.sleep(opt.pollMs ?? 60_000);
    }
  };

  await step("preflight", () => {
    const head = r.sh("git", ["rev-parse", "HEAD"]), tag = r.sh("git", ["rev-parse", `${V}^{commit}`]), dirty = r.sh("git", ["status", "--porcelain", "--untracked-files=no"]);
    if (head !== tag || dirty) {
      const why = head !== tag ? `HEAD is not ${V}` : "the checkout has changes";
      if (!dryRun) throw new Error(`${why}: check out ${V} cleanly first`);
      r.log(`  (dry run) ${why}`);
    }
    if (!r.signingKey()) r.log("  (dry run) MADANI_RELEASE_SIGNING_KEY is not set");
  });
  const first = opt.steps[0]!;
  if (first < 100) await step("desktop-rollout", () => r.publishPolicy(state, { rollout: [version, first] }));
  await step("desktop", async () => {
    const live = await (await r.fetchImpl("https://madani.bot/releases/latest.json", { cache: "no-store" })).json().catch(() => null) as { version?: string } | null;
    if (live?.version === version) { r.log(`  madani.bot already announces ${version}`); return; }
    r.act("scripts/publish-downloads.sh", [V]);
  });
  if (!opt.skipBuild) await step("build", () => { r.act("pnpm", ["build:server"]); r.act("pnpm", ["exec", "vite", "build"]); });
  const canary = opt.now ? [] : opt.canary;
  await step("cloud-package", () => {
    r.act("node", ["apps/cloud-service/scripts/build-home-package.mjs", "--skip-build"]);
    const local = join(ROOT, "release", "home", "omb-home.tgz");
    const sha256 = dryRun && !existsSync(local) ? "0".repeat(64) : createHash("sha256").update(readFileSync(local)).digest("hex");
    const key = r.signingKey();
    const signature = key ? signRelease({ kind: "home-package", name: "omb-home", version, sha256, signedAt: r.now() }, key) : "(dry run)";
    const file = `${r.cfg.homeDir}/omb-home-${version}.tgz`;
    r.act("scp", ["-q", local, `${r.cfg.ssh}:${file}.part`]);
    r.act("ssh", ["-o", "BatchMode=yes", r.cfg.ssh, `test "$(sha256sum '${file}.part' | cut -c1-64)" = '${sha256}' && mv -f '${file}.part' '${file}'`]);
    r.place(r.cfg.releaseFile, `${JSON.stringify({ sha256, signature, file, version, ...(canary.length ? { clouds: canary } : {}) })}\n`);
    state.cloud = { sha256, signature, file };
  });
  if (!opt.now && (await watch("canary", canary)) !== "healthy") return state.halted ? "halted" : "waiting";
  await step("cloud-widen", () => {
    const cloud = state.cloud;
    if (!cloud && !dryRun) throw new Error("no cloud package recorded; rerun from a fresh state");
    if (canary.length) r.place(r.cfg.releaseFile, `${JSON.stringify({ ...cloud, version })}\n`);
  });
  for (const share of opt.steps.slice(1)) {
    await step(`desktop-${share}`, () => r.publishPolicy(state, { rollout: [version, share] }));
    if (share < 100 && (await watch(`desktop-${share}-watch`, [])) !== "healthy") return state.halted ? "halted" : "waiting";
  }
  await step("vps-package", () => {
    r.act("node", ["scripts/build-vps-package.mjs", "--skip-build"]);
    const manifest = dryRun ? null : JSON.parse(readFileSync(join(ROOT, "release", "vps", "manifest.json"), "utf8")) as { sha256: string; version: string; commit: string; builtAt: string; file: string; signature?: string; desktop: { sha256: string; image: string; file: string } };
    if (manifest && (!manifest.signature || manifest.version !== version)) throw new Error("the server build is not signed for this version");
    for (const [name, sha] of manifest ? [[manifest.file, manifest.sha256], [manifest.desktop.file, manifest.desktop.sha256]] : [["<build>.tgz", "<sha256>"]]) {
      const remote = `${r.cfg.linkPackages}/${sha}.tgz`;
      r.act("scp", ["-q", join(ROOT, "release", "vps", name!), `${r.cfg.ssh}:${remote}.part`]);
      r.act("ssh", ["-o", "BatchMode=yes", r.cfg.ssh, `test "$(sha256sum '${remote}.part' | cut -c1-64)" = '${sha}' && mv -f '${remote}.part' '${remote}'`]);
    }
    if (manifest) r.place(`${r.cfg.linkPackages}/current.json`, `${JSON.stringify({ sha256: manifest.sha256, version, commit: manifest.commit, builtAt: manifest.builtAt, signature: manifest.signature, desktop: { sha256: manifest.desktop.sha256, image: manifest.desktop.image } })}\n`);
    else r.log("  would write current.json");
  });
  await step("link-agent", async () => {
    const agentVersion = (ref: string) => /^export const AGENT_VERSION = "(\d+\.\d+\.\d+)";$/m.exec(r.sh("git", ["show", `${ref}:apps/link-service/agent.mjs`]))?.[1] ?? null;
    const want = agentVersion(V);
    const served = (await (await r.fetchImpl(`${r.cfg.linkUrl}/v1/release`, { cache: "no-store" })).json().catch(() => null) as { agent?: { version?: string } } | null)?.agent ?? null;
    if (!want || (served?.version && compareVersions(served.version, want) >= 0)) { r.log(`  the link service serves agent ${served?.version ?? "?"}; nothing to ship`); return; }
    // ci re-signs agent.mjs on main (link-agent-sign.yml); the deploy waits for that signature, then ships main's link service
    for (let tries = 0; ; tries += 1) {
      r.sh("git", ["fetch", "-q", "origin", "main"]);
      const agentAt = r.sh("git", ["log", "-1", "--format=%H", "origin/main", "--", "apps/link-service/agent.mjs"]);
      const sigAt = r.sh("git", ["log", "-1", "--format=%H", "origin/main", "--", "apps/link-service/agent.mjs.sig"]);
      const onMain = agentVersion("origin/main"), reached = onMain !== null && compareVersions(onMain, want) >= 0;
      let signed = false;
      try { r.sh("git", ["merge-base", "--is-ancestor", agentAt, sigAt]); signed = true; } catch { /* not yet */ }
      r.log(`  agent ${want} wanted, main has ${onMain ?? "?"}${signed ? " (signed)" : ""}, the link service serves ${served?.version ?? "?"}`);
      if (reached && signed) break;
      if (!reached) { if (dryRun) break; throw new Error(`origin/main's agent is older than ${V}'s: merge the release into main first`); }
      if (dryRun || tries >= 30) { r.log(`  agent.mjs.sig on main is not re-signed yet${dryRun ? "" : "; rerun once link-agent-sign.yml passed"}`); if (!dryRun) throw new Error("agent not signed yet"); break; }
      await r.sleep(30_000);
    }
    const tree = mkdtempSync(join(tmpdir(), "madani-link-main-"));
    rmSync(tree, { recursive: true, force: true });
    r.act("git", ["worktree", "add", "--detach", tree, "origin/main"]);
    try { r.act(join(tree, "apps", "link-service", "deploy", "deploy.sh"), []); } finally { r.act("git", ["worktree", "remove", "--force", tree]); }
  });
  r.log(`${version} is out everywhere`);
  return "done";
}

export function printFleet(f: FleetAnswer, log: (line: string) => void) {
  log(`desktops (opted-in installs, last ${f.desktops.days} days):`);
  for (const row of f.desktops.versions) log(`  ${row.version.padEnd(10)} ${String(row.installs).padStart(6)} installs ${String(row.errors).padStart(6)} errors`);
  log("madani clouds:");
  for (const row of f.clouds.versions) log(`  ${row.version.padEnd(10)} ${String(row.clouds).padStart(6)} clouds${row.onTrial ? `, ${row.onTrial} on trial` : ""}`);
  for (const c of f.clouds.canary) log(`  canary ${c.id}: ${c.version ?? "?"}${c.trial ? `, self-test ${c.trial}` : ""}${c.rolledBack ? `, rolled back ${c.rolledBack}` : ""}${c.refused ? `, refused (${c.refused})` : ""}${c.stuck ? ", STUCK" : ""}`);
  log(f.servers ? `own servers (last ${Math.round(f.servers.windowMs / 3_600_000)} h):` : "own servers: the link service could not be read");
  for (const row of f.servers?.servers ?? []) log(`  ${row.version.padEnd(10)} ${String(row.count).padStart(6)} servers`);
  for (const row of f.servers?.agents ?? []) log(`  agent ${row.version.padEnd(10)} ${String(row.count).padStart(6)}`);
}

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    "dry-run": { type: "boolean" }, now: { type: "boolean" }, canary: { type: "string" }, "desktop-steps": { type: "string" }, watch: { type: "string" }, "skip-build": { type: "boolean" } } });
  const [command, arg] = positionals, dryRun = values["dry-run"] === true;
  const r = createRelease({ cfg: configOf(process.env), env: process.env, dryRun });
  const canary = (values.canary ?? process.env.MADANI_RELEASE_CANARY_CLOUDS ?? "").split(",").map(s => s.trim()).filter(Boolean);
  const holder = { serial: 0 };
  if (command === "status") return printFleet(await r.fleet(canary), r.log);
  if (command === "pause") return r.publishPolicy(holder, { paused: true });
  if (command === "resume") return r.publishPolicy(holder, { paused: false });
  if (command === "block" && arg && SEMVER.test(arg)) return r.publishPolicy(holder, { block: arg, rollout: [arg, null] });
  if (!command || !SEMVER.test(command)) {
    console.error("usage: release-all.ts <x.y.z> [--dry-run] [--now] [--canary ids] [--desktop-steps 10,50,100] [--watch 30] [--skip-build] | status | pause | resume | block <x.y.z>");
    process.exit(2);
  }
  const watchMs = Number(values.watch ?? 30) * 60_000;
  const result = await release(r, { version: command, now: values.now === true, canary, steps: rolloutSteps(values["desktop-steps"], values.now === true), watchMs, maxWaitMs: watchMs * 4, skipBuild: values["skip-build"] === true, dryRun });
  process.exit(result === "done" ? 0 : result === "halted" ? 1 : 3);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
