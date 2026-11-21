// The move offer end to end: this computer's server and a Cloud home (scripts/testing/cloud-send-fixture.ts, each its own
// data directory and port), with main's own wiring and its first move waiting for the person's yes. Disposable homes; no
// network.
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { CloudSendNotice } from "../electron/cloud-send.mjs";
import { launchCloudSendFixture, type CloudSendFixture } from "../scripts/testing/cloud-send-fixture.ts";
import { hostTimeout } from "./testing/host-timeout.ts";

const TOKEN = `ops_fake-move-offer-${randomBytes(8).toString("hex")}`;
let fx: CloudSendFixture;

beforeAll(async () => {
  fx = await launchCloudSendFixture({ onePasswordToken: TOKEN, offer: true, env: { MADANI_ENVIRONMENT_LABEL: "MacBook Air" } });
}, hostTimeout(90_000));
afterAll(async () => { await fx?.close(); });

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const journal = () => (existsSync(fx.journalFile) ? JSON.parse(readFileSync(fx.journalFile, "utf8")) as { phase: string; counts?: { bots: number } } | null : null);
const names = async (side: CloudSendFixture["local"]) => ((await side("GET", "/api/bots")).body.bots as Array<{ name: string }>).map((bot) => bot.name);

it("bots on this computer wait for the person's yes; the yes moves them, checked, onto the other harness, and Open madani cloud opens it", async () => {
  const { local, onCloud } = fx;
  for (const name of ["Nova", "Quill", "Rivet"]) {
    const bot = (await local("POST", "/api/bots", { name, modelSelection: { instanceId: "claude", model: "claude-sonnet-5" } })).body.bot as { id: string; threadId: string };
    expect((await local("PATCH", `/api/bots/${bot.id}`, { soul: `You are ${name}.` })).status).toBe(200);
    // the move asks first only for bots the person talked with here
    if (name === "Nova") expect((await local("POST", `/api/bots/${bot.id}/messages`, { text: "Hello Nova.", threadId: bot.threadId })).status).toBe(202);
  }
  await expect.poll(async () => ((await local("GET", "/api/bots")).body.bots as Array<{ activity?: string; busy?: boolean }>)
    .every((bot) => bot.activity !== "working" && !bot.busy), { timeout: 60_000, interval: 100 }).toBe(true);
  expect(await names(onCloud)).not.toContain("Nova");

  // The Cloud is ready (as at the launch after it appeared): main asks, and moves nothing yet.
  fx.account.state = { ...fx.account.state, machine: { ...fx.account.state.machine, moves: true } };
  await fx.oneHome.kick();
  await fx.offer()!.refresh({ force: true });
  for (let round = 0; round < 3; round++) { await fx.oneHome.kick(); await sleep(200); }
  expect(journal()).toBeNull();
  const asked = await fx.call<CloudSendNotice>("cloud-send:notice", "local");
  expect(asked.offer).toEqual({ stage: "prompt", bots: 3 });
  expect((await fx.call<CloudSendNotice>("cloud-send:notice", "cloud")).offer).toEqual({ stage: "prompt", bots: 3 });

  // Not now, then the line's Move now.
  expect((await fx.call<CloudSendNotice>("cloud-send:move-offer-dismiss", "local", "prompt")).offer?.stage).toBe("banner");
  await fx.call("cloud-send:move-offer-accept", "local", "banner");
  expect(journal()?.phase).toBeTruthy();

  for (let round = 0; round < 240 && journal()?.phase !== "done"; round++) {
    await fx.oneHome.kick();
    if (journal()?.phase !== "done") await sleep(500);
  }
  expect(journal()?.phase, fx.logs().split("\n").filter((line) => line.startsWith("[main]")).join("\n")).toBe("done");
  expect(journal()?.counts?.bots).toBe(3);
  expect(await names(onCloud)).toEqual(expect.arrayContaining(["Nova", "Quill", "Rivet"]));
  expect(await names(local)).toEqual(expect.arrayContaining(["Nova", "Quill", "Rivet"]));
  expect(fx.spies.opened, "the window waits for Open madani cloud").not.toContain("cloud");
  const done = await fx.call<CloudSendNotice>("cloud-send:notice", "local");
  expect(done.offer).toBeUndefined();
  expect(done.move).toMatchObject({ phase: "done", counts: { bots: 3 } });
  const opened = await fx.call<CloudSendNotice>("cloud-send:move-open", "local");
  expect(fx.spies.opened).toEqual(["cloud"]);
  expect(opened.move, "All moved is said once").toBeUndefined();
  const steps = fx.tracked.filter(([name]) => name === "cloud_move").map(([, props]) => props.step);
  expect(fx.tracked.slice(0, 2)).toEqual([["cloud_move_prompt", { action: "dismissed" }], ["cloud_move_banner", { action: "accepted" }]]);
  expect(steps[0]).toBe("started");
  expect(steps.at(-1)).toBe("succeeded");
  expect(fx.tracked.find(([name, props]) => name === "cloud_move" && props.step === "succeeded")?.[1]).toMatchObject({ bots: 3 });
}, hostTimeout(240_000));
