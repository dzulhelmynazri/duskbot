import assert from "node:assert/strict";
import test from "node:test";
import { CLOUD_FROM_COMPUTER, CLOUD_WELCOME_DONE, COMPUTER_AI_HINT, carryWelcomeToCloud, computerAis, profileForCloud, welcomeForCloud } from "./cloud-welcome-carry.mjs";
import * as shared from "../shared/cloud-hints.ts";

test("the hints are the ones the cloud's page reads", () => {
  assert.equal(CLOUD_WELCOME_DONE, shared.CLOUD_WELCOME_DONE);
  assert.equal(CLOUD_FROM_COMPUTER, shared.CLOUD_FROM_COMPUTER);
  assert.equal(COMPUTER_AI_HINT, shared.COMPUTER_AI_HINT);
});

test("a new cloud gets its own welcome replaced by the first run, the AIs used here, and this computer's hints, never a finished first run", () => {
  const patch = welcomeForCloud({ completedAt: "2026-11-01T00:00:00.000Z", hintsSeen: ["spotlight-a", "met-chief-v1"] }, { hintsSeen: ["cloud-welcome-shown"] }, ["claude"]);
  assert.equal(patch.completedAt, undefined);
  assert.deepEqual(patch.hintsSeen, [CLOUD_WELCOME_DONE, CLOUD_FROM_COMPUTER, "computer-ai:claude", "cloud-welcome-shown", "spotlight-a"]);
});

test("a cloud whose welcome ended is left alone", () => {
  assert.equal(welcomeForCloud({}, { hintsSeen: [CLOUD_WELCOME_DONE] }), null);
  assert.equal(welcomeForCloud({}, { hintsSeen: ["cloud-setup-hidden"] }), null);
});

test("only AIs that work here are named, never the free backup", () => {
  const ai = (instanceId, snapshot, extra = {}) => ({ instanceId, driverKind: "x", snapshot: { state: "available", ...snapshot }, ...extra });
  assert.deepEqual(computerAis([
    ai("claude", { authenticated: true }), ai("codex", { authenticated: false }), ai("opencodeGo", { freeFallback: true }),
    ai("grok", { state: "unavailable" }), ai("openaiCompat", { authenticated: false }, { access: "custom" }),
  ]), ["claude", "openaiCompat"]);
  assert.deepEqual(computerAis(null), []);
});

test("the profile fills only what the cloud lacks", () => {
  assert.deepEqual(profileForCloud({ name: " Ada  Lovelace ", aboutMe: "Likes maths" }, {}), { name: "Ada Lovelace", aboutMe: "Likes maths" });
  assert.deepEqual(profileForCloud({ name: "Ada", aboutMe: "x" }, { name: "Countess", aboutMe: "y" }), {});
  assert.deepEqual(profileForCloud(undefined, undefined), {});
});

test("carries the profile and picture first, then the record, over the window's session", async () => {
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push([init.method ?? "GET", url, init.body ?? null]);
    if (url.endsWith("/api/attachments")) return new Response(JSON.stringify({ path: "/data/attachments/abc-1.png" }), { status: 201 });
    return new Response(JSON.stringify({ onboarding: {}, profile: {} }), { status: 200 });
  };
  const localRequest = async (route) => {
    if (route === "/api/config") return Response.json({ onboarding: {}, profile: { name: "Ada", avatarUrl: "/api/attachments/me.png" } });
    if (route === "/api/instances") return Response.json({ instances: [{ instanceId: "claude", driverKind: "claudeAgent", snapshot: { state: "available", authenticated: true } }] });
    return new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "content-type": "image/png", "content-length": "3" } });
  };
  assert.equal(await carryWelcomeToCloud({ origin: "https://c1.madani.test", fetch, localRequest }), true);
  assert.deepEqual(calls.map(([method, url]) => `${method} ${url.replace("https://c1.madani.test", "")}`), ["GET /api/config", "POST /api/attachments", "PUT /api/config", "PUT /api/config"]);
  assert.deepEqual(JSON.parse(calls[2][2]), { profile: { name: "Ada", avatarUrl: "/api/attachments/abc-1.png" } });
  assert.ok(JSON.parse(calls[3][2]).onboarding.hintsSeen.includes("computer-ai:claude"));
  assert.equal(await carryWelcomeToCloud({ origin: "https://c1.madani.test", fetch: async () => new Response("", { status: 401 }), localRequest }), false);
});
