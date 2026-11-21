// Memory eval: plays the scenario against a sandbox server with a real model, then scores what was kept and what the
// bots recall in fresh threads.
//   node --experimental-strip-types scripts/memory-eval/run.ts [--repo <checkout>] [--label before] [--model gpt-6.1-terra] [--keep]
//   node --experimental-strip-types scripts/memory-eval/run.ts --rescore scripts/memory-eval/results/before.json --label before
// --rescore judges a saved run again (its memory and its replies) without replaying it.
// The gateway is MADANI_EVAL_URL/MADANI_EVAL_KEY, else ~/Desktop/code/mchat/.env. Results go to scripts/memory-eval/results/<label>.json.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { client } from "./client.ts";
import { gatewayFromEnv, launchSandbox, type Gateway } from "./sandbox.ts";
import { FAKE_TOKEN, IMPORTED, PROBES, STORE_CHECKS, WEEKS, type StoreCheck } from "./scenario.ts";
import { activeEntries, activeText, duplicateFacts } from "./entries.ts";

const here = dirname(fileURLToPath(import.meta.url));
const { values } = parseArgs({ options: {
  repo: { type: "string", default: resolve(here, "..", "..") },
  label: { type: "string", default: "run" },
  model: { type: "string", default: process.env.MADANI_EVAL_MODEL ?? "gpt-6.1-terra" },
  judge: { type: "string", default: process.env.MADANI_EVAL_JUDGE ?? "gpt-6.1-terra" },
  keep: { type: "boolean", default: false },
  rescore: { type: "string" },
} });

const saved = values.rescore ? JSON.parse(readFileSync(values.rescore, "utf8").split("«fixture token»").join(FAKE_TOKEN)) : null;
const gateway = gatewayFromEnv(saved?.model ?? values.model!);
const judgeGateway: Gateway = { ...gateway, model: values.judge! };
const log = (...parts: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...parts);

async function judge(system: string, user: string): Promise<{ answer: boolean; why: string }> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(`${judgeGateway.url}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${judgeGateway.key}` },
      body: JSON.stringify({ model: judgeGateway.model, temperature: 0, messages: [{ role: "system", content: system }, { role: "user", content: user }] }),
    }).catch(() => null);
    const body = res?.ok ? await res.json().catch(() => null) as any : null;
    const text: string = body?.choices?.[0]?.message?.content ?? "";
    const m = /\{[\s\S]*\}/.exec(text);
    if (m) {
      try {
        const parsed = JSON.parse(m[0]);
        if (typeof parsed.answer === "boolean") return { answer: parsed.answer, why: String(parsed.why ?? "") };
      } catch {}
    }
  }
  throw new Error("judge gave no usable answer");
}

const STORE_JUDGE = "You audit an assistant's long-term memory. You get the memory's text and one yes/no question about it. Lines struck through with ~~ or marked superseded/replaced/old are history, not current facts. Answer strictly from the text. Reply with JSON only: {\"answer\": true|false, \"why\": \"one short sentence\"}.";
const PROBE_JUDGE = "You grade one reply from an assistant against a pass condition. Reply with JSON only: {\"answer\": true|false, \"why\": \"one short sentence\"}, where answer is true when the reply meets the pass condition.";
const ENTRY_JUDGE = "You audit one line from an assistant's long-term memory about its user. A line is WORTH KEEPING when it is a durable, useful fact: a preference, a fact about the person or the people in their life, a contact, a recurring fact, a decision, or an ongoing project's detail. It is JUNK when it is small talk, a one-off task or question, transient data (a code, today's weather), a secret, a restatement of another line, or a bot's own chatter. Reply with JSON only: {\"answer\": true|false, \"why\": \"...\"} where answer is true when the line is WORTH KEEPING.";

async function score(result: any, t0: number): Promise<void> {
  const aboutMe: string = result.memory.shared;
  const notes = { Scout: result.memory.Scout as Record<string, string>, Forge: result.memory.Forge as Record<string, string> };
  const tierText = (tier: StoreCheck["tier"]): string => {
    const shared = `## General memory (About me, read by every bot)\n${aboutMe.trim() || "(empty)"}`;
    if (tier === "shared") return shared;
    if (tier === "Scout" || tier === "Forge") return `## ${tier}'s own notes\n${activeText(notes[tier]) || "(empty)"}`;
    return [shared, `## Scout's own notes\n${activeText(notes.Scout) || "(empty)"}`, `## Forge's own notes\n${activeText(notes.Forge) || "(empty)"}`].join("\n\n");
  };
  result.checks = [];
  for (const check of STORE_CHECKS) {
    const verdict = await judge(STORE_JUDGE, `Memory:\n${tierText(check.tier)}\n\nQuestion: ${check.question}`);
    const pass = verdict.answer === check.expect;
    result.checks.push({ ...check, got: verdict.answer, pass, why: verdict.why });
    log(`${pass ? "PASS" : "FAIL"} store ${check.id}: ${verdict.why}`);
  }
  // entry precision: every line that loads or is recalled, judged on its own
  const lines = [
    ...activeEntries(aboutMe, "shared"),
    ...Object.entries(notes).flatMap(([name, files]) => Object.entries(files).filter(([path]) => path !== "memory/archive.md").flatMap(([path, text]) => activeEntries(text, `${name}:${path}`))),
  ];
  result.entries = [];
  for (const entry of lines) {
    const verdict = await judge(ENTRY_JUDGE, entry.text);
    result.entries.push({ ...entry, keep: verdict.answer, why: verdict.why });
  }
  for (const probe of result.probes) {
    const spec = PROBES.find((p) => p.id === probe.id) ?? probe;
    const verdict = await judge(PROBE_JUDGE, `Reply:\n${probe.reply || "(no reply)"}\n\nPass condition: ${spec.pass}`);
    Object.assign(probe, { pass: spec.pass, ok: verdict.answer, why: verdict.why });
    log(`${verdict.answer ? "PASS" : "FAIL"} probe ${probe.id}: ${verdict.why}`);
  }
  const recallItems = [...result.checks.filter((c: any) => c.kind === "recall").map((c: any) => c.pass), ...result.probes.filter((p: any) => p.kind === "recall").map((p: any) => p.ok)];
  const precisionItems = [...result.checks.filter((c: any) => c.kind === "precision").map((c: any) => c.pass), ...result.probes.filter((p: any) => p.kind === "precision").map((p: any) => p.ok)];
  const kept = result.entries.filter((e: any) => e.keep).length;
  result.score = {
    recall: `${recallItems.filter(Boolean).length}/${recallItems.length}`,
    precisionChecks: `${precisionItems.filter(Boolean).length}/${precisionItems.length}`,
    entryPrecision: `${kept}/${lines.length}`,
    duplicates: duplicateFacts(lines),
    activeEntries: lines.length,
    sharedBytes: aboutMe.length,
    notesBytes: Object.values(notes).reduce((sum, files) => sum + activeText(files).length, 0),
    ...(t0 ? { minutes: Math.round((Date.now() - t0) / 6_000) / 10 } : { minutes: result.score?.minutes }),
  };
  log("SCORE", JSON.stringify(result.score));
}

function write(result: any): void {
  const out = join(here, "results", `${values.label}.json`);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(result, null, 2).split(FAKE_TOKEN).join("«fixture token»")}\n`);
  log(`wrote ${out}`);
}

async function main() {
  const t0 = Date.now();
  log(`sandbox from ${values.repo}, bot model ${gateway.model}, judge ${judgeGateway.model}`);
  const box = await launchSandbox(values.repo!, gateway, { captureQuietMs: 1_000 });
  const api = client(box.url);
  const result: any = { label: values.label, repo: values.repo, model: gateway.model, judge: judgeGateway.model, started: new Date().toISOString(), turns: [], checks: [], probes: [], entries: [] };
  try {
    const bots = { Scout: await api.createBot("Scout", gateway.model), Forge: await api.createBot("Forge", gateway.model) };
    const night = async () => {
      for (const [name, bot] of Object.entries(bots)) {
        const report = await api.tidy(bot.id).catch((error) => ({ error: (error as Error).message }));
        log(`tidy ${name}: ${JSON.stringify(report).slice(0, 200)}`);
      }
      const general = await api.consolidateGeneral().catch((error) => ({ error: (error as Error).message }));
      if (general) log(`general memory: ${JSON.stringify(general).slice(0, 300)}`);
    };
    // the import, as the app does it: the checkout's own aboutMeWithNotes, saved through the profile route
    const notes = await import(pathToFileURL(join(values.repo!, "shared", "assistant-notes.ts")).href);
    const imported = notes.aboutMeWithNotes(await api.aboutMe(), { from: { name: IMPORTED.from, key: "chatgpt" }, aboutMe: IMPORTED.aboutMe, instructions: "" });
    if (imported) await api.call("PUT", "/api/config", { profile: { aboutMe: imported.text } });
    log(`imported ${IMPORTED.aboutMe.length} facts from ${IMPORTED.from}`);
    for (const week of WEEKS) {
      log(`== ${week.name}`);
      for (const step of week.sessions) {
        const bot = bots[step.bot];
        const threadId = await api.newThread(bot.id);
        for (const text of step.say) {
          const { reply, state } = await api.say(bot.id, threadId, text);
          result.turns.push({ week: week.name, bot: step.bot, text, reply, state });
          log(`${step.bot} [${state}] > ${text.slice(0, 60)}\n         < ${reply.replace(/\s+/g, " ").slice(0, 140)}`);
        }
        const since = Date.now();
        const captured = await api.waitCapture(bot.id, since - 1_000, 150_000);
        if (!captured) log(`(no capture recorded for ${step.bot} within the wait)`);
      }
      await night();
    }

    result.memory = { shared: await api.aboutMe(), Scout: await api.botMemory(bots.Scout.id), Forge: await api.botMemory(bots.Forge.id) };

    // a week later, in fresh threads
    for (const probe of PROBES) {
      const bot = bots[probe.bot];
      const threadId = await api.newThread(bot.id);
      const { reply, state } = await api.say(bot.id, threadId, probe.ask);
      result.probes.push({ ...probe, reply, state });
      log(`probe ${probe.id}: ${reply.replace(/\s+/g, " ").slice(0, 120)}`);
    }
    await score(result, t0);

  } finally {
    result.serverLog = box.logPath;
    write(result);
    await box.close(values.keep);
  }
}

if (saved) {
  saved.label = values.label;
  await score(saved, 0);
  write(saved);
} else {
  await main();
}
