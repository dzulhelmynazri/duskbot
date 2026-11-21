// A throwaway InstaBox machine for the own-server flow: made, used over the exec API, always deleted. The key is the
// preview one from the madani env file (INSTABOX_API_KEY_PREVIEW, never printed). Cost: the smallest size, minutes long.
import { envValue } from "../account.mjs";
import { until } from "../app.mjs";

const API = "https://api.instabox.sh";
async function call(method, path, body, headers = {}) {
  const key = envValue("INSTABOX_API_KEY_PREVIEW") ?? envValue("INSTABOX_API_KEY");
  if (!key) throw new Error("INSTABOX_API_KEY_PREVIEW is not set (madani env file)");
  const response = await fetch(`${API}${path}`, { method, headers: { authorization: `Bearer ${key}`, "content-type": "application/json", ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(700_000) });
  const text = await response.text();
  if (!response.ok && !(method === "DELETE" && response.status === 404)) throw new Error(`instabox ${method} ${path.split("?")[0]}: ${response.status} ${text.slice(0, 200)}`);
  try { return JSON.parse(text); } catch { return null; }
}

export async function createVm(name, { vcpus = 2, memMiB = 4096 } = {}) {
  await call("POST", "/v1/machines", { name, templateId: "universal", vcpus, memMiB, autoSuspendAfterSeconds: 1800, vault: false, secrets: [], metadata: { "madani.smoke": "own-server-flow" } }, { "idempotency-key": `create-${name}` });
  const machine = await until(async () => { const m = await call("GET", `/v1/machines/${encodeURIComponent(name)}`); return m?.state === "running" && m?.runtime?.ready && !m?.operationId ? m : false; }, { timeout: 300_000, every: 3_000, what: `InstaBox machine ${name}` });
  const vm = {
    id: machine.id, name,
    /** runs a shell command; returns { exitCode, stdout, stderr } */
    async exec(cmd, timeoutSeconds = 120) { const r = await call("POST", `/v1/machines/${machine.id}/exec`, { cmd, timeoutSeconds }, { "idempotency-key": `exec-${Date.now()}-${Math.random().toString(36).slice(2)}` }); return { exitCode: r?.exitCode ?? r?.exit_code, stdout: r?.stdout ?? "", stderr: r?.stderr ?? "" }; },
    async remove() { await call("DELETE", `/v1/machines/${machine.id}`, undefined, { "x-confirm-delete": machine.id, "idempotency-key": `delete-${machine.id}` }); },
  };
  return vm;
}

/** every machine this harness made that is still there (by its metadata), for a cleanup pass */
export async function leftoverVms() {
  const list = await call("GET", "/v1/machines?limit=100");
  return (list?.machines ?? []).filter((m) => m.metadata?.["madani.smoke"] === "own-server-flow");
}
export async function removeVm(id) { await call("DELETE", `/v1/machines/${id}`, undefined, { "x-confirm-delete": id, "idempotency-key": `delete-${id}` }); }
