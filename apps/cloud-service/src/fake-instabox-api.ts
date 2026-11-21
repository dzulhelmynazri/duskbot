// A loopback stand-in for InstaBox's API v1, for tests: machines with labels and unique names, operations, suspend that
// keeps memory (or boots fresh when told to), public ports, exec through a scripted handler that plays the machine,
// file upload and download, activity leases, snapshots, usage and deletions with confirmation. Each machine's /data is a
// map of tar paths ("data/..."); its memory is a set of strings a test can check survives a pause.
import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { makeTar, tarEntries } from "./backups.ts";
import { INSTABOX_RESTORE_FILE, INSTABOX_SETUP_STATUS, INSTABOX_SNAPSHOT_FILE } from "./home.ts";

export interface FakeMachine {
  id: string; name: string; state: string; ready: boolean; metadata: Record<string, string>; vcpus: number; memMiB: number; template: string | null; snapshotId: string | null;
  autoSuspendAfterSeconds: number | null; createdAt: number; updatedAt: number; files: Map<string, Buffer>; volume: Map<string, Buffer>; memory: Set<string>;
  ports: Map<number, string>; leases: Map<string, number>; processesPreserved: boolean | null; runningMs: number; runningSince: number | null; setupPolls: number;
  /** /data in GiB: 20 at create, grown or shrunk with a PATCH of persistentDiskGiB */
  diskGiB: number;
}
export interface FakeExec { machine: FakeMachine; cmd: string }

export async function startFakeInstaboxApi(options: { now?: () => number; key?: string; setupPolls?: number } = {}) {
  const now = options.now ?? Date.now, key = options.key ?? `ibk_${"t".repeat(52)}`;
  const machines = new Map<string, FakeMachine>(), operations = new Map<string, Record<string, unknown>>(), snapshots = new Map<string, { id: string; name: string; status: string; createdAt: number; source: string; volume: Map<string, Buffer>; files: Map<string, Buffer>; diskGiB: number }>();
  const egress = new Map<string, number>(), saved = new Set<string>();
  const requests: Array<{ method: string; path: string; body: unknown; headers: Record<string, string | string[] | undefined> }> = [];
  const idem = new Map<string, unknown>();
  const queued = new Map<string, () => void>();
  let queueStarts = false;
  let failNext = 0, limitNext = 0, busyNext = 0, startsBlockedUntil = 0, coldResume = false, refuseResume: string | null = null, growNeedsStop = false, usedGiB = 0, snapshotListReads = 0;
  const unlisted = new Map<string, { reads: number; operationId: string }>();
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  const ident = (prefix: string) => `${prefix}_${Array.from(randomBytes(26), b => alphabet[b % alphabet.length]).join("")}`;
  const iso = (t: number) => new Date(t).toISOString();
  const view = (m: FakeMachine) => ({ id: m.id, name: m.name, state: m.state, desiredState: m.state, operationId: null, template: m.template ? { id: m.template, version: "fake" } : null,
    spec: { vcpus: m.vcpus, memMiB: m.memMiB, persistentDiskGiB: m.diskGiB, rootDiskGiB: 16 }, storage: { sizeGiB: m.diskGiB, mountPath: "/data", persistent: true, synced: true },
    runtime: { ready: m.ready, ...(m.processesPreserved === null ? {} : { processesPreserved: m.processesPreserved }) }, autoSuspendAfterSeconds: m.autoSuspendAfterSeconds,
    metadata: m.metadata, guestUser: "user", createdAt: iso(m.createdAt), updatedAt: iso(m.updatedAt) });
  function operation(m: FakeMachine, type: string) { const op = { id: ident("op"), machineId: m.id, type, state: "succeeded", error: null, createdAt: iso(now()), updatedAt: iso(now()) }; operations.set(op.id, op); return op; }
  const settle = (m: FakeMachine) => { if (m.runningSince !== null) { m.runningMs += now() - m.runningSince; m.runningSince = null; } };
  const run = (m: FakeMachine) => { m.state = "running"; m.ready = true; m.runningSince = now(); m.updatedAt = now(); };

  let handler: (input: FakeExec) => { exitCode: number; stdout: string } | null = () => null;
  function machineExec({ machine, cmd }: FakeExec): { exitCode: number; stdout: string } {
    const custom = handler({ machine, cmd });
    if (custom) return custom;
    if (cmd.includes("setsid nohup bash -c")) { machine.setupPolls = 0; return { exitCode: 0, stdout: "launched\n" }; }
    if (cmd === "sync") return { exitCode: 0, stdout: "" };
    if (cmd.includes("omb-home install")) return { exitCode: 0, stdout: "installed\n" };
    if (cmd.includes("omb-home start")) { machine.memory.add("home"); return { exitCode: 0, stdout: "started\n" }; }
    if (cmd.includes("omb-home snapshot-done")) { machine.files.delete(INSTABOX_SNAPSHOT_FILE); return { exitCode: 0, stdout: "removed\n" }; }
    if (cmd.includes("omb-home snapshot")) {
      const tar = makeTar([...machine.volume].map(([name, data]) => ({ name, data })));
      machine.files.set(INSTABOX_SNAPSHOT_FILE, tar);
      return { exitCode: 0, stdout: `snapshot ${tar.length}\n` };
    }
    if (cmd.includes("omb-home restore")) {
      const tar = machine.files.get(INSTABOX_RESTORE_FILE);
      if (!tar) return { exitCode: 2, stdout: "not a home backup\n" };
      const entries = tarEntries(tar).filter(e => e.type === "0");
      if (!entries.some(e => e.name.endsWith(".omb-cloud-home.json"))) return { exitCode: 2, stdout: "not a home backup\n" };
      machine.volume = new Map(entries.map(e => [e.name.replace(/^(?:\.\/)?/, ""), e.data]));
      machine.files.delete(INSTABOX_RESTORE_FILE);
      return { exitCode: 0, stdout: "restored\n" };
    }
    if (cmd.includes("sha256sum -c")) {
      const manifest = [...machine.files].find(([path]) => path.endsWith(".sha256"))?.[1]?.toString("utf8") ?? "";
      const bad = manifest.split("\n").filter(Boolean).filter(line => {
        const [hash, path] = [line.slice(0, 64), line.slice(66)];
        const data = machine.volume.get(path.replace(/^\//, ""));
        return !data || sha256(data) !== hash;
      }).map(line => `${line.slice(66)}: FAILED`);
      for (const [path] of [...machine.files].filter(([path]) => path.endsWith(".sha256"))) machine.files.delete(path);
      return { exitCode: 0, stdout: `${bad.join("\n")}\nmismatched ${bad.length}\n` };
    }
    return { exitCode: 0, stdout: "" };
  }

  function send(res: ServerResponse, status: number, body: unknown) { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); }
  const error = (res: ServerResponse, status: number, code: string, extra: Record<string, unknown> = {}) => send(res, status, { error: { code, message: code, retryable: status >= 500 || status === 429, ...extra } });
  async function read(req: IncomingMessage) { const chunks: Buffer[] = []; for await (const c of req) chunks.push(c as Buffer); return Buffer.concat(chunks); }
  const lookup = (idOrName: string) => machines.get(idOrName) ?? [...machines.values()].find(m => m.name === idOrName);

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://fake"), method = req.method ?? "GET", raw = await read(req), path = url.pathname;
    if (req.headers["x-api-key"] !== key) return error(res, 401, "invalid_key");
    const isFile = path.endsWith("/files") && method === "PUT";
    let body: any = null;
    if (!isFile) { try { body = raw.length ? JSON.parse(raw.toString("utf8")) : null; } catch { return error(res, 400, "bad_request"); } }
    requests.push({ method, path: `${path}${url.search}`, body: isFile ? `<${raw.length} bytes>` : body, headers: req.headers });
    if (failNext > 0) { failNext--; return error(res, 503, "host_unavailable"); }
    if (limitNext > 0) { limitNext--; res.writeHead(429, { "content-type": "application/json", "retry-after": "40" }); res.end(JSON.stringify({ error: { code: "rate_limited", retryable: true, retryAfterSeconds: 40 } })); return; }
    // the workspace's start limit: every start (create, start, resume) is refused until then, with the seconds left
    if (method === "POST" && startsBlockedUntil > now() && (path === "/v1/machines" || /\/(start|resume)$/.test(path))) {
      const seconds = Math.ceil((startsBlockedUntil - now()) / 1000);
      res.writeHead(429, { "content-type": "application/json", "retry-after": String(seconds) }); res.end(JSON.stringify({ error: { code: "rate_limited", retryable: true, retryAfterSeconds: seconds } })); return;
    }
    if (busyNext > 0 && method === "POST" && /\/(start|resume|suspend|stop)$/.test(path)) { busyNext--; return error(res, 409, "operation_conflict"); }
    const needsKey = method !== "GET" && /\/(machines|suspend|resume|start|stop|snapshots)$/.test(path) || (method === "DELETE" && /^\/v1\/(machines|snapshots)\/[^/]+$/.test(path)) || (method === "PATCH");
    const idemKey = req.headers["idempotency-key"];
    if (needsKey && !idemKey) return error(res, 400, "bad_request", { message: "Idempotency-Key required" });
    if (path === "/v1/usage" && method === "GET") return send(res, 200, { machines: machines.size, limits: { maxMachines: 500 } });
    const op = /^\/v1\/operations\/(op_[a-z2-7]{26})$/.exec(path);
    if (op) { const found = operations.get(op[1]!); return found ? send(res, 200, found) : error(res, 404, "not_found"); }
    const snapView = (s: { id: string; name: string; status: string; createdAt: number; source: string }) => ({ id: s.id, name: s.name, status: s.status, createdAt: iso(s.createdAt), sourceMachineId: s.source });
    if (path === "/v1/snapshots" && method === "GET") {
      for (const [id, wait] of unlisted) if (--wait.reads <= 0) { unlisted.delete(id); Object.assign(operations.get(wait.operationId)!, { state: "succeeded", updatedAt: iso(now()) }); }
      return send(res, 200, { snapshots: [...snapshots.values()].filter(x => !unlisted.has(x.id)).map(snapView) });
    }
    const snap = /^\/v1\/snapshots\/(sn_[a-z2-7]{26})$/.exec(path);
    if (snap && method === "GET") { const found = unlisted.has(snap[1]!) ? undefined : snapshots.get(snap[1]!); return found ? send(res, 200, snapView(found)) : error(res, 404, "not_found"); }
    if (snap && method === "DELETE") { if (req.headers["x-confirm-delete"] !== snap[1]) return error(res, 409, "delete_confirmation_required"); snapshots.delete(snap[1]!); res.writeHead(204); res.end(); return; }
    if (path === "/v1/machines" && method === "POST") {
      const prior = idem.get(String(idemKey));
      if (prior) return send(res, 202, prior);
      const known = new Set(["name", "templateId", "snapshotId", "vcpus", "memMiB", "autoSuspendAfterSeconds", "vault", "secrets", "metadata", "envSecrets", "desiredState", "maxRunMinutes", "archiveSeconds", "deleteAfterSeconds"]);
      const unknown = Object.keys(body ?? {}).find(k => !known.has(k));
      if (unknown) return error(res, 400, "unknown_field", { message: unknown });
      if (body?.name && [...machines.values()].some(m => m.name === body.name)) return error(res, 409, "name_taken");
      const m: FakeMachine = { id: ident("m"), name: body?.name ?? `box-${randomBytes(4).toString("hex")}`, state: "running", ready: true, metadata: body?.metadata ?? {}, vcpus: body?.vcpus ?? 4, memMiB: body?.memMiB ?? 8192,
        template: body?.snapshotId ? null : body?.templateId ?? "agent-browser", snapshotId: body?.snapshotId ?? null, autoSuspendAfterSeconds: body?.autoSuspendAfterSeconds ?? 1800,
        createdAt: now(), updatedAt: now(), files: new Map(), volume: new Map(), memory: new Set(), ports: new Map(), leases: new Map(), processesPreserved: null, runningMs: 0, runningSince: now(), setupPolls: 0, diskGiB: 20 };
      if (body?.snapshotId) {
        const from = snapshots.get(body.snapshotId);
        if (!from) return error(res, 404, "not_found");
        m.volume = new Map(from.volume); m.files = new Map(from.files); m.diskGiB = from.diskGiB;
      }
      machines.set(m.id, m);
      const answer = operation(m, "create");
      idem.set(String(idemKey), answer);
      return send(res, 202, answer);
    }
    if (path === "/v1/machines" && method === "GET") {
      const filters = url.searchParams.getAll("metadata").map(f => f.split(":"));
      const all = [...machines.values()].filter(m => filters.every(([k, v]) => m.metadata[k!] === v));
      const limit = Number(url.searchParams.get("limit") ?? 100), start = Number(url.searchParams.get("cursor") ?? 0), page = all.slice(start, start + limit);
      return send(res, 200, { machines: page.map(view), nextCursor: start + limit < all.length ? String(start + limit) : null });
    }
    const match = /^\/v1\/machines\/([^/]+)(?:\/(.+))?$/.exec(path);
    const m = match ? lookup(decodeURIComponent(match[1]!)) : undefined;
    if (!match || !m) return error(res, 404, "not_found");
    const action = match[2] ?? "";
    if (!action && method === "GET") return send(res, 200, view(m));
    if (!action && method === "PATCH") {
      if (body?.metadata) m.metadata = body.metadata;
      if (typeof body?.autoSuspendAfterSeconds === "number") m.autoSuspendAfterSeconds = body.autoSuspendAfterSeconds || null;
      if (body?.vcpus !== undefined) { if (m.state !== "stopped") return error(res, 409, "operation_conflict"); m.vcpus = body.vcpus; m.memMiB = body.memMiB; }
      if (body?.persistentDiskGiB) {
        // grows online (rarely it needs a stop); a shrink needs a stopped machine whose data plus 10% fits; 200 GiB is the pro plan's limit
        const size = Number(body.persistentDiskGiB);
        if (!Number.isInteger(size) || size < 1 || size > 1024) return error(res, 400, "invalid_request");
        if (size > 200) return error(res, 429, "quota_exceeded");
        if (size > m.diskGiB && growNeedsStop && m.state === "running") return error(res, 409, "grow_needs_stop");
        if (size < m.diskGiB && m.state !== "stopped") return error(res, 409, "operation_conflict");
        if (size < m.diskGiB && size < Math.max(usedGiB * 1.1, usedGiB + 1)) return error(res, 409, "disk_too_small");
        m.diskGiB = size;
      }
      return send(res, 200, view(m));
    }
    if (!action && method === "DELETE") {
      if (req.headers["x-confirm-delete"] !== m.id && req.headers["x-confirm-delete"] !== m.name) return error(res, 409, "delete_confirmation_required");
      settle(m); machines.delete(m.id); m.state = "deleted";
      return send(res, 202, operation(m, "delete"));
    }
    const lifecycle = (type: string, allowed: string[], next: () => void) => {
      if (!allowed.includes(m.state)) return error(res, 409, "operation_conflict");
      // accepted, but the machine still reads as it was until the operation runs (finishStarts)
      if (queueStarts && (type === "start" || type === "resume")) { if (!queued.has(m.id)) queued.set(m.id, () => { next(); m.updatedAt = now(); }); return send(res, 202, operation(m, type)); }
      next(); m.updatedAt = now();
      return send(res, 202, operation(m, type));
    };
    if (action === "suspend" && method === "POST") return lifecycle("suspend", ["running"], () => { settle(m); m.state = "suspended"; m.ready = false; m.leases.clear(); });
    if (action === "resume" && method === "POST") {
      if (refuseResume === m.id) return error(res, 409, "machine_cooldown", { retryAfterSeconds: 300 });
      return lifecycle("resume", ["suspended"], () => { run(m); m.processesPreserved = !coldResume; if (coldResume) m.memory.clear(); m.leases.clear(); });
    }
    if (action === "start" && method === "POST") return lifecycle("start", ["stopped", "suspended", "error"], () => { const fresh = m.state !== "suspended" || coldResume; run(m); m.processesPreserved = !fresh; if (fresh) m.memory.clear(); });
    if (action === "stop" && method === "POST") return lifecycle("stop", ["running"], () => { settle(m); m.state = "stopped"; m.ready = false; m.memory.clear(); });
    if (action === "ports" && method === "GET") return send(res, 200, { enabled: true, ports: [...m.ports].map(([port, u]) => ({ port, url: u, machineId: m.id })) });
    if (action === "ports" && method === "POST") {
      const u = m.ports.get(body.port) ?? `https://${body.port}-${m.id.slice(2)}.instabox.tech`;
      const created = !m.ports.has(body.port); m.ports.set(body.port, u);
      return send(res, created ? 201 : 200, { port: body.port, url: u, machineId: m.id });
    }
    if (action === "exec" && method === "POST") {
      if (m.state !== "running") return error(res, 409, "machine_not_running");
      if (typeof body?.cmd === "string" && body.cmd.includes("madani-setup") && body.cmd.includes("setsid")) m.setupPolls = 0;
      const result = machineExec({ machine: m, cmd: String(body?.cmd ?? "") });
      return send(res, 200, { stdout: result.stdout, stderr: "", exitCode: result.exitCode, timedOut: false, truncated: false });
    }
    if (action === "files" && method === "PUT") {
      if (m.state !== "running") return error(res, 409, "machine_not_running");
      const target = url.searchParams.get("path")!;
      const existed = m.files.has(target); m.files.set(target, raw);
      return send(res, existed ? 200 : 201, { path: target, size: raw.length, created: !existed });
    }
    if (action === "files/content" && method === "GET") {
      if (m.state !== "running") return error(res, 409, "machine_not_running");
      const target = url.searchParams.get("path")!;
      if (target === INSTABOX_SETUP_STATUS && m.files.has("/data/home/.omb-setup.sh") && !m.files.has(target) && ++m.setupPolls >= (options.setupPolls ?? 1)) m.files.set(target, Buffer.from("0\n"));
      const data = m.files.get(target);
      if (!data) return error(res, 404, "not_found");
      res.writeHead(200, { "content-type": "application/octet-stream", "content-length": String(data.length) }); res.end(data); return;
    }
    const lease = /^activity-leases\/([A-Za-z0-9_.-]+)$/.exec(action);
    if (lease && method === "PUT") { if (m.state !== "running") return error(res, 409, "machine_not_running"); m.leases.set(lease[1]!, now() + body.ttlSeconds * 1000); return send(res, 200, { id: lease[1], machineId: m.id, expiresAt: iso(now() + body.ttlSeconds * 1000) }); }
    if (lease && method === "DELETE") { m.leases.delete(lease[1]!); res.writeHead(204); res.end(); return; }
    if (action === "snapshots" && method === "POST") {
      if ([...snapshots.values()].some(s => s.name === body?.name)) return error(res, 409, "name_taken");
      if (m.state === "suspended") return error(res, 409, "operation_conflict");
      const s = { id: ident("sn"), name: body.name, status: "ready", createdAt: now(), source: m.id, volume: new Map(m.volume), files: new Map(m.files), diskGiB: m.diskGiB }; snapshots.set(s.id, s); saved.add(m.id);
      if (snapshotListReads > 0) {
        const op = { ...operation(m, "snapshot"), state: "running" }; operations.set(op.id, op);
        unlisted.set(s.id, { reads: snapshotListReads, operationId: op.id });
        return send(res, 202, op);
      }
      return send(res, 201, snapView(s));
    }
    if (action === "usage" && method === "GET") {
      const ms = m.runningMs + (m.runningSince !== null ? now() - m.runningSince : 0);
      return send(res, 200, { from: iso(0), to: iso(now()), runningSeconds: Math.round(ms / 1000), vcpuSeconds: Math.round(ms / 1000) * m.vcpus, memGiBSeconds: ms / 1000 * m.memMiB / 1024, diskGiBSeconds: 0, egressBytes: egress.get(m.id) ?? 0 });
    }
    return error(res, 404, "not_found");
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return {
    baseUrl: `http://127.0.0.1:${port}`, key, machines, requests, snapshots,
    failNext(count: number) { failNext = count; },
    limitNext(count: number) { limitNext = count; },
    /** every start is refused for the workspace's start limit until this time */
    limitStartsUntil(at: number) { startsBlockedUntil = at; },
    /** the next power changes find another operation running on the machine */
    busyNext(count: number) { busyNext = count; },
    /** starts and resumes are accepted (202) but the machine keeps reading as stopped until finishStarts() */
    queueStarts(on = true) { queueStarts = on; },
    finishStarts() { for (const run of queued.values()) run(); queued.clear(); },
    /** resumes cannot restore memory: the machine boots fresh (`processesPreserved: false`) */
    coldResume(on = true) { coldResume = on; },
    /** this machine's resumes are refused with a cooldown */
    refuseResume(machineId: string | null) { refuseResume = machineId; },
    /** a running machine's disk grow answers grow_needs_stop */
    growNeedsStop(on = true) { growNeedsStop = on; },
    /** a snapshot save answers 202 with a running operation, and the snapshot stays out of every read for this many list reads */
    slowSnapshots(listReads: number) { snapshotListReads = listReads; },
    /** GiB of data on every machine's /data, for shrinks */
    diskUsed(gib: number) { usedGiB = gib; },
    onExec(fn: typeof handler) { handler = fn; },
    /** what the machine has uploaded this month, as the meter reads it */
    egress(machineId: string, bytes: number) { egress.set(machineId, bytes); },
    /** the machine is lost without anyone deleting it through the API */
    lose(machineId: string) { machines.delete(machineId); },
    /** the machine paused itself (idle, or our lease lapsed) */
    autoPause(machineId: string) { const x = machines.get(machineId); if (x && x.state === "running") { settle(x); x.state = "suspended"; x.ready = false; } },
    /** deletes that lose data: a machine never saved as a snapshot, or a snapshot */
    deletes: () => requests.filter(r => r.method === "DELETE" && (r.path.startsWith("/v1/snapshots/") || r.path.startsWith("/v1/machines/") && !saved.has(r.path.split("/")[3]!))),
    /** every machine delete, saved first or not */
    machineDeletes: () => requests.filter(r => r.method === "DELETE" && r.path.startsWith("/v1/machines/")),
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
  };
}
export type FakeInstaboxApi = Awaited<ReturnType<typeof startFakeInstaboxApi>>;

const sha256 = (data: Buffer) => createHash("sha256").update(data).digest("hex");
