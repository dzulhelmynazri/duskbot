// A cloud desktop's side of the Slack wake edge (apps/dashboard/server/slack-edge). Only on a Cloud home with a dashboard
// link, and only after the owner turned "Wake for Slack" on in the dashboard: then it gives the edge its bots'
// app-level tokens (Socket Mode only: they cannot read history or post) and a public key, takes the edge's sealed
// events back on every sync, opens them here and feeds them to the bridge, which drops any it already handled.
// The bot tokens, the private key and every message's text stay on this machine.
import { createHash, createPrivateKey, randomUUID, sign } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SIGNATURE_HEADERS, signedPayload } from "../../shared/dashboard-protocol.ts";
import { SLACK_EDGE_SYNC_MS, SLACK_EDGE_SYNC_PATH, SLACK_EDGE_TOKENS_PATH, SLACK_EDGE_VERSION, appTokenHash, openSealed, slackEdgeKeys } from "../../shared/slack-edge.ts";
import type { SlackEdgeSyncAnswer } from "../../shared/slack-edge.ts";

export interface SlackHandoverBot { botId: string; appId: string; botUserId: string; appToken: string }
export interface SlackHandoverDeps {
  dataDir: string;
  env: NodeJS.ProcessEnv;
  bots(): SlackHandoverBot[];
  deliver(botId: string, payload: Record<string, unknown>): Promise<void>;
  fetch?: typeof fetch;
  now?: () => number;
  log?: (line: string) => void;
  syncMs?: number;
}
interface Link { url: string; workspaceId: string; privateKey: string }
interface KeyFile { v: 1; publicKey: string; privateKey: string; enabled?: boolean }

function readJson(file: string): unknown { try { return JSON.parse(readFileSync(file, "utf8")); } catch { return null; } }
function writePrivate(dir: string, file: string, value: unknown) {
  mkdirSync(dir, { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try { writeFileSync(temporary, JSON.stringify(value), { mode: 0o600, flag: "wx" }); renameSync(temporary, file); } finally { try { unlinkSync(temporary); } catch {} }
}

export function createSlackHandover(deps: SlackHandoverDeps) {
  const fetcher = deps.fetch ?? fetch, now = deps.now ?? Date.now, log = deps.log ?? (() => {});
  const keyFile = join(deps.dataDir, "slack-edge-key.json");
  const active = deps.env.MADANI_CLOUD_ROLE === "home" && deps.env.MADANI_SLACK_EDGE !== "0";
  let timer: ReturnType<typeof setTimeout> | null = null, running = false, syncing: Promise<void> | null = null;
  let acks: string[] = [];

  function link(): Link | null {
    const value = readJson(join(deps.dataDir, "dashboard-link.json")) as Partial<Link> | null;
    return value && typeof value.url === "string" && typeof value.workspaceId === "string" && typeof value.privateKey === "string" ? { url: value.url, workspaceId: value.workspaceId, privateKey: value.privateKey } : null;
  }
  function keys(): KeyFile {
    const saved = readJson(keyFile) as KeyFile | null;
    if (saved?.v === 1 && typeof saved.publicKey === "string" && typeof saved.privateKey === "string") { try { chmodSync(keyFile, 0o600); } catch {} return saved; }
    const fresh: KeyFile = { v: 1, ...slackEdgeKeys() };
    writePrivate(deps.dataDir, keyFile, fresh);
    return fresh;
  }
  async function post<T>(target: Link, path: string, body: unknown): Promise<T> {
    const bytes = JSON.stringify(body), time = now(), url = new URL(`${target.url.replace(/\/$/, "")}${path}`);
    const signature = sign(null, Buffer.from(signedPayload("POST", url.pathname, time, createHash("sha256").update(bytes).digest("hex"))),
      createPrivateKey({ key: Buffer.from(target.privateKey, "base64"), type: "pkcs8", format: "der" })).toString("base64");
    const response = await fetcher(url.toString(), { method: "POST", redirect: "error", signal: AbortSignal.timeout(20_000), body: bytes,
      headers: { "content-type": "application/json", [SIGNATURE_HEADERS.workspace]: target.workspaceId, [SIGNATURE_HEADERS.time]: String(time), [SIGNATURE_HEADERS.signature]: signature } });
    if (!response.ok) throw new Error(`Slack edge request failed (${response.status}).`);
    return await response.json() as T;
  }

  async function syncOnce(): Promise<boolean> {
    const target = link();
    if (!target) return false;
    const key = keys();
    const bots = key.enabled ? deps.bots() : [];
    const sentAcks = acks;
    const answer = await post<SlackEdgeSyncAnswer>(target, SLACK_EDGE_SYNC_PATH, { v: SLACK_EDGE_VERSION, publicKey: key.publicKey,
      bots: bots.map(({ botId, appId, botUserId, appToken }) => ({ botId, appId, botUserId, tokenHash: appTokenHash(appToken) })), ack: sentAcks });
    acks = acks.filter(id => !sentAcks.includes(id));
    let again = false;
    if (Boolean(answer.enabled) !== Boolean(key.enabled)) { writePrivate(deps.dataDir, keyFile, { ...key, enabled: answer.enabled }); again = true; }
    for (const event of answer.events ?? []) {
      let payload: Record<string, unknown> | null = null;
      try { payload = JSON.parse(openSealed(key.privateKey, event.botId, event.sealed)) as Record<string, unknown>; }
      catch { log("A sealed Slack event could not be opened; it is dropped."); }
      if (payload) {
        try { await deps.deliver(event.botId, payload); }
        catch { log("A Slack event from the edge could not be handled."); continue; }
      }
      acks.push(event.id);
    }
    if (acks.length) again = true;
    const wanted = answer.enabled ? bots.filter(bot => answer.needTokens?.includes(bot.botId)) : [];
    if (wanted.length) await post(target, SLACK_EDGE_TOKENS_PATH, { v: SLACK_EDGE_VERSION, tokens: wanted.map(({ botId, appToken }) => ({ botId, appToken })) });
    return again;
  }

  async function sync(): Promise<void> {
    if (syncing) return syncing;
    syncing = (async () => {
      try { for (let round = 0; round < 5 && running; round++) if (!(await syncOnce())) break; }
      catch { log("Slack edge sync failed; it is tried again."); }
    })().finally(() => { syncing = null; });
    return syncing;
  }
  function schedule() {
    if (!running) return;
    timer = setTimeout(() => { void sync().finally(schedule); }, deps.syncMs ?? SLACK_EDGE_SYNC_MS);
    timer.unref?.();
  }

  return {
    active,
    start() {
      if (!active || running) return;
      running = true;
      void sync().finally(schedule);
    },
    /** a sync now, for instance after a bot's tokens changed */
    sync: () => (running ? sync() : Promise.resolve()),
    stop() { running = false; if (timer) clearTimeout(timer); timer = null; },
  };
}
