import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlMadani, verificationServerEnvironment } from "../scripts/control-madani.ts";
import { waitForExit } from "./testing/cleanup.ts";

it("runs every routine in the bot's main chat as an ordinary turn, with no run conversation, line or card, and its approvals there", async () => {
  const fixture = await launchVerificationServer();
  const evidence: unknown[] = [{ fixture: fixture.info }];
  let broker: Socket | undefined;
  const api = async (method: string, path: string, body?: unknown, status = 200) => {
    const response = await fetch(`${fixture.info.url}${path}`, {
      method, headers: { "content-type": "application/json", origin: fixture.info.url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const value = await response.json() as any;
    expect(response.status, `${method} ${path}: ${JSON.stringify(value)}`).toBe(status);
    if (method !== "GET") evidence.push({ method, path, body, status: response.status, result: value });
    return value;
  };
  const control = (args: string[]) => runControlMadani([...args, "--url", fixture.info.url]);
  const runState = async (id: string) => (await api("GET", "/api/routines")).runs.find((run: any) => run.id === id);
  const messages = async (id: string) => (await api("GET", `/api/threads/${id}/messages?limit=100`)).messages as any[];
  const currentBot = async (id: string) => (await api("GET", "/api/bots")).bots.find((candidate: any) => candidate.id === id);
  try {
    expect((await control(["doctor"]) as any).ok).toBe(true);
    const { bot } = await control(["new-bot", "--name", "Results fixture"]) as any;
    // On Ask, so a run's permission request waits on its card.
    await api("PATCH", `/api/bots/${bot.id}`, { approvalMode: "ask" });
    const main = (await currentBot(bot.id)).threadId as string;
    const { routine } = await api("POST", "/api/routines", {
      name: "Persistent report", prompt: "Report this run's state.", botId: bot.id, enabled: false,
      schedule: { type: "interval", everyMinutes: 60, anchorAt: Date.now() + 3_600_000 },
    }, 201);
    for (let index = 0; index < 2; index++) {
      const { run } = await api("POST", `/api/routines/${routine.id}/run`, undefined, 201);
      await expect.poll(async () => (await runState(run.id))?.status, { timeout: 15_000 }).toBe("completed");
      expect(await runState(run.id)).toMatchObject({ resultsThreadId: main, threadId: main });
      evidence.push(await control(["wait", "--bot", bot.id, "--task", main]));
    }
    const lines = await messages(main);
    expect(lines.filter((message) => message.routineStart?.name === "Persistent report")).toHaveLength(2);
    expect(lines.filter((message) => message.role === "bot" && message.kind === "text" && message.text === "hello from fake claude")).toHaveLength(2);
    expect(lines.some((message) => message.automation || message.kind === "routine.run")).toBe(false);
    const saved = await currentBot(bot.id);
    expect(saved.tasks).toHaveLength(1);
    expect(saved.tasks[0]).toMatchObject({ threadId: main });
    expect(saved.tasks[0].routineRunId).toBeUndefined();
    expect(saved.tasks[0].title.startsWith("[")).toBe(false);

    const { task: chosenTask } = await api("POST", `/api/bots/${bot.id}/tasks`, { title: "Chosen reports" }, 201);
    const chosen = chosenTask.threadId as string;
    await api("PATCH", `/api/routines/${routine.id}`, { resultsThreadId: chosen });
    const gate = join(fixture.info.dataDir, "results-finish");
    const wrapper = join(fixture.info.dataDir, "results-slow.mjs");
    writeFileSync(wrapper, [
      "#!/usr/bin/env node",
      'process.env.FAKE_CLAUDE_MODE = "slow";',
      `process.env.FAKE_CLAUDE_SLOW_FINISH_GATE = ${JSON.stringify(gate)};`,
      `await import(${JSON.stringify(pathToFileURL(join(process.cwd(), "server/testing/fake-claude-cli.ts")).href)});`,
    ].join("\n"), { mode: 0o700 });
    await api("PATCH", "/api/instances/claude", { cli: wrapper });
    const { run: pending } = await api("POST", `/api/routines/${routine.id}/run`, undefined, 201);
    await expect.poll(async () => (await runState(pending.id))?.status, { timeout: 15_000 }).toBe("running");
    expect((await runState(pending.id)).threadId).toBe(chosen);
    await expect.poll(() => {
      if (!existsSync(fixture.fixtureDumpPath)) return false;
      return JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8")).mcpConfig?.mcpServers?.agents?.env?.MADANI_THREAD_ID === chosen;
    }, { timeout: 15_000 }).toBe(true);
    const launched = JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8"));
    broker = connect(launched.mcpConfig.mcpServers.madani.args.at(-1));
    broker.on("error", () => {});
    await new Promise<void>((resolve, reject) => { broker!.once("connect", resolve); broker!.once("error", reject); });
    broker.write(JSON.stringify({ t: "ask", id: "results-approval", kind: "permission", tool: "Bash", input: { command: "echo fixture-approval" } }) + "\n");
    await expect.poll(async () => (await runState(pending.id))?.status, { timeout: 15_000 }).toBe("waiting");
    const cards = (await messages(chosen)).filter((message) => message.card?.tool === "Bash");
    expect(cards).toHaveLength(1);
    expect(cards[0].automation).toBeUndefined();
    await api("POST", `/api/bots/${bot.id}/respond`, { threadId: chosen, requestId: cards[0].card.requestId, behavior: "deny" });
    writeFileSync(gate, "complete the turn");
    await expect.poll(async () => (await runState(pending.id))?.status, { timeout: 15_000 }).toBe("completed");
    const after = await currentBot(bot.id);
    expect(after.tasks.map((task: any) => task.threadId).sort()).toEqual([main, chosen].sort());
    expect(after.tasks.some((task: any) => task.routineRunId)).toBe(false);
    evidence.push({ final: await api("GET", "/api/routines"), bot: after });
  } finally {
    broker?.destroy();
    const evidencePath = `${fixture.info.logPath}.results.json`;
    writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));
    console.info(JSON.stringify({ logPath: fixture.info.logPath, evidencePath }));
    await fixture.close();
  }
}, 90_000);

it("runs a routine made in a chat in that chat, not the bot's first thread or a conversation of its own", async () => {
  const fixture = await launchVerificationServer(process.env, undefined, undefined, undefined, { scripted: true });
  const evidence: unknown[] = [{ fixture: fixture.info }];
  const planPath = join(fixture.info.dataDir, "room-plan.json");
  const api = async (method: string, path: string, body?: unknown, status = 200) => {
    const response = await fetch(`${fixture.info.url}${path}`, {
      method, headers: { "content-type": "application/json", origin: fixture.info.url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const value = await response.json() as any;
    expect(response.status, `${method} ${path}: ${JSON.stringify(value)}`).toBe(status);
    if (method !== "GET") evidence.push({ method, path, body, status: response.status, result: value });
    return value;
  };
  const cli = (...args: string[]) => runControlMadani([...args, "--url", fixture.info.url]) as Promise<any>;
  const messages = async (id: string) => (await api("GET", `/api/threads/${id}/messages?limit=100`)).messages as any[];
  try {
    const { bot } = await cli("new-bot", "--name", "Chat routine fixture");
    const first = bot.activeTaskId as string;
    const { task } = await api("POST", `/api/bots/${bot.id}/tasks`, { title: "Planning" }, 201);
    const chat = task.threadId as string;
    writeFileSync(planPath, JSON.stringify({ [bot.id]: { turns: [
      { steps: [{ tool: "create_trigger", arguments: { when: "schedule",
        name: "Chat report", instructions: "Report the fixture state; no external services.",
        schedule: { type: "cron", expression: "0 9 1 * *", timeZone: "UTC" },
      } }], reply: "The routine is scheduled." },
      { steps: [], reply: "Fresh chat report" },
    ] } }));
    await cli("send", "--bot", bot.id, "--task", chat, "--text", "Report the fixture state monthly.");
    await cli("wait", "--bot", bot.id, "--task", chat, "--timeout", "20");
    const card = (await messages(chat)).findLast((message) => message.card?.routineRequest)?.card;
    expect(card).toMatchObject({ answered: "allow", autoApplied: true });
    const routineId = card.routineRequest.resultId as string;
    const definition = (await api("GET", "/api/routines")).routines.find((routine: any) => routine.id === routineId);
    expect(definition.sourceThreadId).toBe(chat);

    const { run } = await api("POST", `/api/routines/${routineId}/run`, undefined, 201);
    expect(run.resultsThreadId).toBe(chat);
    await expect.poll(async () => (await api("GET", "/api/routines")).runs.find((candidate: any) => candidate.id === run.id)?.status, { timeout: 20_000 }).toBe("completed");
    const finished = (await api("GET", "/api/routines")).runs.find((candidate: any) => candidate.id === run.id);
    expect(finished.threadId).toBe(chat);
    // The chat that made it keeps its one trigger card, and the run answers there as any reply would.
    expect((await messages(chat)).some((message) => message.routineRun?.runId === run.id || message.automation)).toBe(false);
    await expect.poll(async () => (await messages(chat)).findLast((message) => message.role === "bot" && message.kind === "text")?.text, { timeout: 15_000 })
      .toBe("Fresh chat report");
    expect((await messages(chat)).filter((message) => message.card?.routineRequest?.resultId === routineId)).toHaveLength(1);
    expect((await messages(first)).some((message) => message.kind === "routine.run" || message.automation)).toBe(false);
    const saved = (await api("GET", "/api/bots")).bots.find((candidate: any) => candidate.id === bot.id);
    expect(saved.tasks.filter((candidate: any) => !candidate.routineRunId).map((candidate: any) => candidate.threadId).sort())
      .toEqual([first, chat].sort());
    expect(saved.tasks.some((candidate: any) => candidate.routineRunId)).toBe(false);
    evidence.push({ run: finished, bot: saved, main: await messages(chat) });
  } finally {
    const evidencePath = `${fixture.info.logPath}.chat-results.json`;
    writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));
    console.info(JSON.stringify({ logPath: fixture.info.logPath, evidencePath }));
    await fixture.close();
  }
}, 90_000);

async function resultsFixture() {
  const fixture = await launchVerificationServer();
  const { dataDir, url, logPath } = fixture.info;
  let server: ChildProcess | undefined;
  const api = async (method: string, path: string, body?: unknown, status = 200) => {
    const response = await fetch(`${url}${path}`, {
      method, headers: { "content-type": "application/json", origin: url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const value = await response.json() as any;
    expect(response.status, `${method} ${path}: ${JSON.stringify(value)}`).toBe(status);
    return value;
  };
  const control = (...args: string[]) => runControlMadani([...args, "--url", url]) as Promise<any>;
  const messages = async (id: string) => (await api("GET", `/api/threads/${id}/messages?limit=100`)).messages as any[];
  const savedBot = async (id: string) => (await api("GET", "/api/bots")).bots.find((candidate: any) => candidate.id === id);
  const destination = async (id: string) => (await api("GET", "/api/routines")).routines.find((candidate: any) => candidate.id === id).resultsThreadId;
  const routine = async (botId: string) => (await api("POST", "/api/routines", {
    name: "Morning report", prompt: "Report this run's state.", botId, enabled: false,
    schedule: { type: "interval", everyMinutes: 60, anchorAt: Date.now() + 3_600_000 },
  }, 201)).routine.id as string;
  const report = async (id: string) => {
    const { run } = await api("POST", `/api/routines/${id}/run`, undefined, 201);
    await expect.poll(async () => (await api("GET", "/api/routines")).runs.find((candidate: any) => candidate.id === run.id)?.status,
      { timeout: 20_000 }).toBe("completed");
    return run.resultsThreadId as string;
  };
  const restart = async (edit?: (file: any) => void, stopped?: (dataDir: string) => void) => {
    await waitForExit(server ?? fixture.child, { signal: "SIGTERM" });
    const path = join(dataDir, "routines.json");
    if (edit) {
      const file = JSON.parse(readFileSync(path, "utf8"));
      edit(file);
      writeFileSync(path, JSON.stringify(file));
    }
    stopped?.(dataDir);
    const log = openSync(logPath, "a", 0o600);
    server = spawn(process.execPath, ["--experimental-strip-types", fileURLToPath(new URL("./index.ts", import.meta.url))], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env: verificationServerEnvironment({}, dataDir, Number(new URL(url).port)), stdio: ["ignore", log, log],
    });
    closeSync(log);
    await expect.poll(async () => {
      try { return (await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1_000) })).ok; } catch { return false; }
    }, { timeout: 20_000 }).toBe(true);
  };
  const close = async () => {
    await waitForExit(server, { signal: "SIGTERM" });
    await fixture.close();
  };
  return { api, control, messages, savedBot, destination, routine, report, restart, close };
}

it("runs in the conversation the person is in, the one a bot with hidden threads opens, after they used threads", async () => {
  const f = await resultsFixture();
  try {
    const { bot } = await f.control("new-bot", "--name", "Hidden threads");
    const oldest = bot.activeTaskId as string;
    const { task } = await f.api("POST", `/api/bots/${bot.id}/tasks`, { title: "Later chat" }, 201);
    const live = task.threadId as string;
    const routine = await f.routine(bot.id);
    expect(await f.report(routine)).toBe(live);
    await f.control("send", "--bot", bot.id, "--task", live, "--text", "Good morning.");
    expect((await f.control("wait", "--bot", bot.id, "--task", live, "--timeout", "20")).status).toBe("settled");
    await f.api("POST", `/api/bots/${bot.id}/tasks/${oldest}?messages=0`);
    expect(await f.report(routine)).toBe(live);
    expect((await f.messages(live)).filter((message) => message.routineStart)).toHaveLength(2);
    expect((await f.messages(oldest)).some((message) => message.routineStart)).toBe(false);
    const saved = await f.savedBot(bot.id);
    expect(saved.threadId).toBe(oldest);
    expect(saved.mainThreadId).toBe(live);
    expect(await f.destination(routine)).toBeUndefined();
  } finally {
    await f.close();
  }
}, 90_000);

it("after the upgrade, reports into and opens the conversation the person last wrote in before it, not the one left selected", async () => {
  const f = await resultsFixture();
  try {
    const { bot } = await f.control("new-bot", "--name", "Upgraded");
    const oldest = bot.activeTaskId as string;
    const { task } = await f.api("POST", `/api/bots/${bot.id}/tasks`, { title: "Their chat" }, 201);
    const theirs = task.threadId as string;
    await f.api("POST", `/api/bots/${bot.id}/messages`, { threadId: theirs, text: "Good morning.", sendId: randomUUID() }, 202);
    expect((await f.control("wait", "--bot", bot.id, "--task", theirs, "--timeout", "20")).status).toBe("settled");
    await f.api("POST", `/api/bots/${bot.id}/tasks/${oldest}?messages=0`);
    const routine = await f.routine(bot.id);
    await f.restart((file) => {
      delete file.frozenResultsCleared;
      file.routines.find((candidate: any) => candidate.id === routine).resultsThreadId = oldest;
    }, (dataDir) => {
      const bots = JSON.parse(readFileSync(join(dataDir, "bots.json"), "utf8")) as any[];
      for (const saved of bots) for (const each of saved.tasks ?? []) delete each.askedAt;
      writeFileSync(join(dataDir, "bots.json"), JSON.stringify(bots));
      rmSync(join(dataDir, "asked-at-filled"), { force: true });
    });
    const saved = await f.savedBot(bot.id);
    expect(saved.threadId).toBe(oldest);
    expect(saved.mainThreadId).toBe(theirs);
    expect(await f.report(routine)).toBe(theirs);
  } finally {
    await f.close();
  }
}, 90_000);

it("clears the oldest thread v0.1.98 to v0.1.107 saved as a routine's destination, once, also one archived since", async () => {
  const f = await resultsFixture();
  try {
    const { bot } = await f.control("new-bot", "--name", "Frozen destination");
    const oldest = bot.activeTaskId as string;
    const { task } = await f.api("POST", `/api/bots/${bot.id}/tasks`, { title: "Later chat" }, 201);
    const routine = await f.routine(bot.id);
    const { bot: tidied } = await f.control("new-bot", "--name", "Archived destination");
    const archived = tidied.activeTaskId as string;
    const { task: kept } = await f.api("POST", `/api/bots/${tidied.id}/tasks`, { title: "Kept chat" }, 201);
    const tidiedRoutine = await f.routine(tidied.id);
    await f.api("PATCH", `/api/bots/${tidied.id}/tasks/${archived}`, { archivedAt: Date.now() });
    await f.restart((file) => {
      delete file.frozenResultsCleared;
      file.routines.find((candidate: any) => candidate.id === routine).resultsThreadId = oldest;
      file.routines.find((candidate: any) => candidate.id === tidiedRoutine).resultsThreadId = archived;
    });
    expect(await f.destination(routine)).toBeUndefined();
    expect(await f.report(routine)).toBe(task.threadId);
    expect(await f.destination(tidiedRoutine)).toBeUndefined();
    expect(await f.report(tidiedRoutine)).toBe(kept.threadId);
    expect((await f.api("PATCH", `/api/routines/${routine}`, { resultsThreadId: oldest })).routine.resultsThreadId).toBe(oldest);
    await f.restart();
    expect(await f.destination(routine)).toBe(oldest);
    expect(await f.report(routine)).toBe(oldest);
  } finally {
    await f.close();
  }
}, 90_000);
