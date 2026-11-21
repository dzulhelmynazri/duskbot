import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, message } from "./backup-alert.mjs";

const HOUR = 3_600_000;

test("mails once when a set starts failing, never again while it keeps failing", () => {
  let step = decide({}, false, 0);
  assert.equal(step.mail, "failed");
  for (let day = 1; day <= 5; day++) {
    step = decide(step.state, false, day * 24 * HOUR);
    assert.equal(step.mail, null);
  }
  assert.equal(step.state.failingSince, 0);
});

test("mails once when it works again, then stays quiet", () => {
  const failing = decide({}, false, 0).state;
  const back = decide(failing, true, 50 * HOUR);
  assert.equal(back.mail, "recovered");
  assert.equal(back.downFor, 50 * HOUR);
  assert.deepEqual(back.state, {});
  assert.equal(decide(back.state, true, 60 * HOUR).mail, null);
});

test("the emails name the set and the way to the logs", () => {
  const failed = message("failed", "make", { log: "upload to r2 failed" });
  assert.match(failed.subject, /backup failed: make/);
  assert.match(failed.text, /journalctl -u madani-backup@make/);
  assert.match(failed.text, /upload to r2 failed/);
  assert.match(message("recovered", "madani", { downFor: 72 * HOUR }).text, /after 3 days/);
});

test("with the shared layout, the failed email keeps the command and log in the html and the text", async () => {
  const { render } = await import(new URL("../../apps/dashboard/server/email/layout.ts", import.meta.url).href);
  const failed = message("failed", "madani", { log: "restic: Fatal: 403 Forbidden", render });
  assert.match(failed.html, /uh oh, a backup failed/);
  assert.match(failed.html, /journalctl -u madani-backup@madani -n 50/);
  assert.match(failed.text, /restic: Fatal: 403 Forbidden/);
  assert.doesNotMatch(failed.html + failed.text, /—/);
});
