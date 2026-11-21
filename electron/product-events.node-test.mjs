import assert from "node:assert/strict";
import test from "node:test";

import { BATCH, FLUSH_MS, MAX_BACKOFF_MS, MAX_QUEUE, analyticsAllowed, cleanAppEvent, createProductEvents } from "./product-events.mjs";

const INSTALL = "AbCdEfGhIjKlMnOpQrStUv", SESSION = "ZyXwVuTsRqPoNmLkJiHgFe", TOKEN = `omc_${"a".repeat(43)}`;
const NOW = 1_800_000_000_000;

function harness({ token = () => null, statuses = [], enabled } = {}) {
  const calls = [], timers = [];
  const fetch = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    const next = statuses.length ? statuses.shift() : 204;
    if (next === "offline") throw new TypeError("fetch failed");
    return new Response(null, { status: next });
  };
  const events = createProductEvents({ origin: "https://preview.madani.bot", token, platform: "darwin", version: "1.2.3", fetch, now: () => NOW,
    setTimer: (fn, ms) => { const timer = { fn, ms }; timers.push(timer); return timer; }, clearTimer: timer => { const at = timers.indexOf(timer); if (at >= 0) timers.splice(at, 1); }, random: () => 1,
    ...(enabled === undefined ? {} : { enabled }) });
  return { events, calls, timers };
}
const event = (name = "app_feature", props = { feature: "bot_created" }) => ({ name, at: NOW - 1000, props });

test("posts to the configured account origin with the account token when signed in, the install id either way", async () => {
  let signedIn = null;
  const { events, calls, timers } = harness({ token: () => signedIn });
  events.send({ install: INSTALL, session: SESSION, events: [event()] });
  assert.equal(timers[0].ms, FLUSH_MS);
  await events.flush();
  signedIn = TOKEN;
  events.send({ install: INSTALL, session: SESSION, events: [event("app_screen", { screen: "/settings" })] });
  await events.flush();
  assert.equal(calls[0].url, "https://preview.madani.bot/v1/app/events");
  assert.equal(calls[0].init.headers.authorization, undefined);
  assert.equal(calls[1].init.headers.authorization, `Bearer ${TOKEN}`);
  assert.deepEqual(calls[0].body, { install: INSTALL, session: SESSION, platform: "darwin", version: "1.2.3", events: [{ name: "app_feature", at: NOW - 1000, props: { feature: "bot_created" } }] });
  assert.equal(calls[1].body.install, INSTALL);
  assert.equal(calls[0].init.redirect, "error");
  assert.equal(events.size(), 0);
});

test("never sends content: unknown events, unknown props and free text are dropped", () => {
  assert.equal(cleanAppEvent({ name: "chat_message", at: NOW, props: { text: "hi" } }, NOW), null);
  assert.equal(cleanAppEvent({ name: "app_feature", at: NOW, props: { feature: "bot_created", message: "x" } }, NOW), null);
  assert.equal(cleanAppEvent({ name: "app_error", at: NOW, props: { kind: "window", code: "please book my flight" } }, NOW), null);
  assert.equal(cleanAppEvent({ name: "app_messages", at: NOW, props: { sent: -1, replies: 1, latencyMs: 2 } }, NOW), null);
  assert.equal(cleanAppEvent({ name: "app_screen", at: NOW, props: { screen: { nested: true } } }, NOW), null);
  assert.deepEqual(cleanAppEvent({ name: "app_close", at: 5, props: { ms: 10 } }, NOW), { name: "app_close", at: NOW, props: { ms: 10 } });
  const { events } = harness();
  assert.equal(events.send({ install: "short", events: [event()] }), false);
  assert.equal(events.send({ install: INSTALL, events: "nope" }), false);
  events.send({ install: INSTALL, events: [event("chat_message", { text: "secret words" }), event()] });
  assert.equal(events.size(), 1);
});

test("actions require a word name and keep at most eight valid word, count or boolean extras", () => {
  const props = { name: "reply_reaction", "bad-key": "yes", text: "private words", url: "https://private.example", upper: "UPPER",
    emoji: "yes", on: true, off: false, count: 0, limit: 1e12 - 1, code: "word_123", kind: "reply", ms: 12, ninth: "dropped" };
  assert.deepEqual(cleanAppEvent(event("app_action", props), NOW)?.props,
    { name: "reply_reaction", emoji: "yes", on: true, off: false, count: 0, limit: 1e12 - 1, code: "word_123", kind: "reply", ms: 12 });
  assert.deepEqual(cleanAppEvent(event("app_action", { name: "counts", negative: -1, decimal: 1.5, infinite: Infinity, nan: NaN,
    unsafe: Number.MAX_SAFE_INTEGER + 1, huge: 1e12 + 1, nested: {}, list: [], nil: null, "key1": "bad", ["k".repeat(21)]: "bad",
    ["k".repeat(20)]: "a".repeat(40), long: "a".repeat(41) }), NOW)?.props, { name: "counts", ["k".repeat(20)]: "a".repeat(40) });
  for (const name of [undefined, true, 3, "", "UPPER", "private words", "https://private.example", "a".repeat(41)]) {
    assert.equal(cleanAppEvent(event("app_action", { name }), NOW), null);
  }
  assert.equal(cleanAppEvent(event("app_close", { ms: true }), NOW), null);
});

test("feedback requires an integer score from one to five and a word moment", () => {
  for (const score of [1, 2, 3, 4, 5]) {
    assert.deepEqual(cleanAppEvent(event("app_feedback", { score, moment: "after_reply" }), NOW)?.props, { score, moment: "after_reply" });
  }
  for (const score of [undefined, "5", true, 0, 6, -1, 2.5, NaN, Infinity]) {
    assert.equal(cleanAppEvent(event("app_feedback", { score, moment: "after_reply" }), NOW), null);
  }
  for (const moment of [undefined, true, "", "UPPER", "private words", "https://private.example", "a".repeat(41)]) {
    assert.equal(cleanAppEvent(event("app_feedback", { score: 3, moment }), NOW), null);
  }
});

test("retries network failures and server errors with growing backoff, drops what the service rejects", async () => {
  const { events, calls, timers } = harness({ statuses: ["offline", 503, 400, 204] });
  events.send({ install: INSTALL, events: [event()] });
  assert.equal(await events.flush(), false);
  assert.equal(events.size(), 1);
  const first = timers.at(-1).ms;
  assert.equal(first, FLUSH_MS * 2);
  assert.equal(await events.flush(), false);
  assert.equal(timers.at(-1).ms, FLUSH_MS * 4);
  assert.equal(await events.flush(), true);
  assert.equal(events.size(), 0);
  assert.equal(calls.length, 3);
  events.send({ install: INSTALL, events: [event()] });
  assert.equal(timers.at(-1).ms, FLUSH_MS);
});

test("caps backoff and the offline queue, and batches per install and session", async () => {
  const { events, calls, timers } = harness({ statuses: Array(30).fill("offline") });
  for (let n = 0; n < 12; n++) events.send({ install: INSTALL, events: Array.from({ length: 50 }, () => event()) });
  assert.equal(events.size(), MAX_QUEUE);
  for (let n = 0; n < 25; n++) await events.flush();
  assert.equal(timers.at(-1).ms, MAX_BACKOFF_MS);
  assert.equal(calls[0].body.events.length, BATCH);
  const fresh = harness();
  fresh.events.send({ install: INSTALL, session: SESSION, events: [event()] });
  fresh.events.send({ install: "OtherInstallId_00000000", events: [event()] });
  fresh.events.send({ install: INSTALL, session: SESSION, events: [event()] });
  await fresh.events.flush();
  assert.deepEqual(fresh.calls.map(call => [call.body.install, call.body.events.length]), [[INSTALL, 2], ["OtherInstallId_00000000", 1]]);
});

test("clear drops the queue, and close makes one last try then takes nothing more", async () => {
  const { events, calls } = harness();
  events.send({ install: INSTALL, events: [event()] });
  events.clear();
  await events.flush();
  assert.equal(calls.length, 0);
  events.send({ install: INSTALL, events: [event()] });
  await events.close();
  assert.equal(calls.length, 1);
  assert.equal(events.send({ install: INSTALL, events: [event()] }), false);
});

test("main's own events ride with the page's install and session, wait for the page's first batch, and stop once analytics are switched off", async () => {
  const { events, calls } = harness();
  assert.equal(events.action("cloud_move", { step: "started", from: "prompt" }), true);
  assert.equal(events.action("cloud_move", { step: "has spaces" }), true, "a value that is not a word is left out, the event goes");
  assert.equal(events.size(), 0, "nothing goes before the page sent its own");
  events.send({ install: INSTALL, session: SESSION, events: [event()] });
  await events.flush();
  assert.deepEqual(calls[0].body.events.filter((sent) => sent.name === "app_action"), [
    { name: "app_action", at: NOW, props: { name: "cloud_move", step: "started", from: "prompt" } },
    { name: "app_action", at: NOW, props: { name: "cloud_move" } },
  ]);
  events.action("cloud_move", { step: "succeeded", bots: 12 });
  await events.flush();
  assert.deepEqual(calls[1].body.events, [{ name: "app_action", at: NOW, props: { name: "cloud_move", step: "succeeded", bots: 12 } }]);
  events.clear();
  events.action("cloud_move", { step: "failed", reason: "unanswered" });
  await events.flush();
  assert.equal(calls.length, 2, "after the person switched analytics off, main's events wait for a page that sends again");
});

test("the last batch drops the queue, posts once without retry, and nothing rides after it", async () => {
  const { events, calls, timers } = harness({ statuses: ["offline"] });
  events.send({ install: INSTALL, session: SESSION, events: [event()] });
  events.action("cloud_move_offer", { step: "shown" });
  const off = event("app_action", { name: "usage_sharing", on: false, where: "settings" });
  assert.equal(await events.last({ install: INSTALL, session: SESSION, events: [off] }), false);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].body.events, [off]);
  assert.equal(events.size(), 0);
  assert.equal(timers.length, 0);
  events.action("cloud_move_offer", { step: "shown" });
  await events.flush();
  assert.equal(calls.length, 1, "main's own events wait for the page, which sends nothing now");
});

test("only a packaged app outside CI reports: dev, worktree, CI and flagged smoke runs do not", () => {
  assert.equal(analyticsAllowed({ packaged: true, env: {} }), true, "the owner's installed app");
  assert.equal(analyticsAllowed({ packaged: true, env: { CI: "false" } }), true);
  assert.equal(analyticsAllowed({ packaged: false, env: {} }), false, "dev and worktree builds");
  assert.equal(analyticsAllowed({ packaged: true, env: { MADANI_ANALYTICS: "0" } }), false, "smoke and e2e launches");
  assert.equal(analyticsAllowed({ packaged: true, env: { CI: "true" } }), false, "CI runners");
  assert.equal(analyticsAllowed({ packaged: true, env: { CI: "1" } }), false);
  assert.equal(analyticsAllowed({ packaged: false, env: { MADANI_ANALYTICS: "1" }, custom: true }), true, "a verification run against preview");
  assert.equal(analyticsAllowed({ packaged: false, env: { MADANI_ANALYTICS: "1" } }), false, "never a dev build toward madani.bot");
});

test("an app with analytics off posts nothing: no page batch, no main action, no last batch, no install for notes", async () => {
  for (const env of [{ packaged: false, env: {} }, { packaged: true, env: { MADANI_ANALYTICS: "0" } }]) {
    const { events, calls, timers } = harness({ enabled: analyticsAllowed(env) });
    assert.equal(events.send({ install: INSTALL, session: SESSION, events: [event()] }), false);
    assert.equal(events.action("account_sign_in", { step: "shown" }), false);
    assert.equal(await events.last({ install: INSTALL, events: [event()] }), false);
    await events.flush();
    await events.close();
    assert.equal(events.install(), null);
    assert.equal(events.size(), 0);
    assert.equal(timers.length, 0);
    assert.equal(calls.length, 0);
  }
  const on = harness({ enabled: analyticsAllowed({ packaged: true, env: {} }) });
  assert.equal(on.events.send({ install: INSTALL, session: SESSION, events: [event()] }), true);
  await on.events.flush();
  assert.equal(on.calls.length, 1, "the packaged app's batch is posted");
  assert.equal(on.calls[0].url, "https://preview.madani.bot/v1/app/events");
});
