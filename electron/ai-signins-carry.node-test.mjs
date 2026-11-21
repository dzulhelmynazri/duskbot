import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CARRIED_DRIVERS, carriedEngines, localAiSignIns } from "./ai-signins-carry.mjs";
import { carryAiKeys } from "./cloud-welcome-carry.mjs";
import * as shared from "../shared/ai-signins.ts";

test("the kinds and engines are the ones the Admin and the Cloud take", () => {
  assert.deepEqual(CARRIED_DRIVERS, shared.AI_SIGNIN_DRIVERS);
});

test("reads each CLI login kept in a file, and nothing that isn't one", async () => {
  const home = mkdtempSync(join(tmpdir(), "madani-carry-"));
  try {
    assert.deepEqual(await localAiSignIns({ env: {}, home }), []);
    const put = (path, text) => { mkdirSync(join(home, ...path.slice(0, -1)), { recursive: true }); writeFileSync(join(home, ...path), text); };
    put([".codex", "auth.json"], JSON.stringify({ tokens: { access_token: "a" } }));
    put([".grok", "auth.json"], "not json");
    put([".gemini", "oauth_creds.json"], JSON.stringify({ access_token: "g", refresh_token: "r" }));
    put([".kimi-code", "credentials", "kimi-code.json"], JSON.stringify({ access_token: "", refresh_token: "" }));
    put([".kimi-code", "credentials", "kimi-code-env-ab12.json"], JSON.stringify({ access_token: "k", refresh_token: "r" }));
    put([".kimi-code", "credentials", "notes.json"], JSON.stringify({ access_token: "x" }));
    const items = await localAiSignIns({ env: {}, home });
    assert.deepEqual(items.map(({ kind, file }) => (file ? `${kind} ${file}` : kind)), ["codex-auth", "gemini-oauth", "kimi-auth kimi-code-env-ab12.json"]);
    assert.ok(shared.parseAiSignInList(items), "what is read is what the Admin takes");
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("names the engines whose sign-in goes along: a carried login's, or a key's", () => {
  const instances = [
    { instanceId: "codex", driverKind: "codex" }, { instanceId: "claude", driverKind: "claudeAgent" }, { instanceId: "grok", driverKind: "grokAgent" },
    { instanceId: "openrouter", driverKind: "openaiChat" }, { instanceId: "cursor", driverKind: "cursorAgent" },
  ];
  assert.deepEqual(carriedEngines(instances, ["codex-auth"], ["openrouter"]), ["codex", "openrouter"]);
  assert.deepEqual(carriedEngines(null, ["codex-auth"]), []);
});

test("the keys the cloud lacks go sealed, one at a time; a key it has stays its own", async () => {
  const calls = [], asked = [];
  const call = async (method, route, body) => {
    calls.push(`${method} ${route}`);
    if (route === "/api/cloud-connections") return { ok: true, status: 200, body: { connections: [{ id: "key:xai", kind: "key", label: "xAI" }] } };
    if (route === "/api/seal-key") return { ok: false, status: 404, body: null };
    return { ok: true, status: 200, body: { saved: body } };
  };
  const localJson = async () => ({ connections: [
    { id: "key:openrouter", kind: "key", label: "OpenRouter" }, { id: "key:xai", kind: "key", label: "xAI" }, { id: "mcp:files", kind: "mcp", label: "files" },
  ] });
  const handoff = async (what) => { asked.push(what.id); return { connection: { config: { openrouter: {} } } }; };
  const lines = [];
  assert.deepEqual(await carryAiKeys({ call, localJson, handoff, log: (line) => lines.push(line) }), ["OpenRouter"]);
  assert.deepEqual(asked, ["key:openrouter"]);
  assert.deepEqual(calls, ["GET /api/cloud-connections", "PATCH /api/config"]);
  assert.deepEqual(await carryAiKeys({ call: async () => ({ ok: false, status: 401, body: null }), localJson, handoff }), [], "a cloud that didn't answer gets nothing");
});
