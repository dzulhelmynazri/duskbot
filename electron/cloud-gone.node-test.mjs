import assert from "node:assert/strict";
import test from "node:test";

import { createCloudGone } from "./cloud-gone.mjs";

const GONE = "https://d0123456789abcdef0123.madani.bot";
const LIVE = "https://dfedcba9876543210fedc.madani.bot";
const goneAnswer = () => new Response("This madani bot was deleted.", { status: 410, headers: { "x-madani-cloud-power": "gone" } });

test("an origin the edge says was deleted is never called again: its fetch answers gone at once, and the syncers' lists leave it out", async () => {
  const calls = [];
  const heard = [];
  const gone = createCloudGone();
  gone.onCloudGone((origin) => heard.push(origin));
  const fetch = gone.wrap(async (url) => { calls.push(String(url)); return String(url).startsWith(GONE) ? goneAnswer() : new Response("{}"); });

  assert.equal((await fetch(`${GONE}/api/settings-sync`)).status, 410);
  assert.deepEqual(heard, [GONE]);
  for (const path of ["/api/settings-sync", "/api/sync/changes?cursor=1&waitMs=25000", "/api/connector-sync", "/api/inbox/count", "/api/cloud-send/x"]) {
    const answer = await fetch(new Request(`${GONE}${path}`));
    assert.equal(answer.status, 410, path);
    assert.equal(answer.headers.get("x-madani-cloud-power"), "gone", path);
  }
  assert.equal(calls.filter((url) => url.startsWith(GONE)).length, 1, "the network was asked once");
  assert.equal((await fetch(`${LIVE}/api/settings-sync`)).status, 200, "other clouds are untouched");

  assert.equal(gone.live(GONE), null);
  assert.equal(gone.live(LIVE), LIVE);
  assert.deepEqual(gone.keep([{ id: "a", origin: GONE }, { id: "b", origin: LIVE }, { id: "local" }]).map((entry) => entry.id), ["b", "local"]);
  gone.note(`${GONE}/other`);
  assert.deepEqual(heard, [GONE], "said once");
});

test("a 410 without the edge's word, or a plain 404, is not gone", async () => {
  const gone = createCloudGone();
  const fetch = gone.wrap(async () => new Response("nope", { status: 410 }));
  await fetch(`${GONE}/api/health`);
  const missing = gone.wrap(async () => new Response("Not found", { status: 404 }));
  await missing(`${LIVE}/api/health`);
  assert.equal(gone.isGone(GONE), false);
  assert.equal(gone.isGone(LIVE), false);
});
