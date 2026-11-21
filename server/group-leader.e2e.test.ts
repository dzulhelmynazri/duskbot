import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlMadani } from "../scripts/control-madani.ts";
import { handleToolCall, request } from "../scripts/mcp-server.ts";
import { LEADER_MAX_ROUNDS } from "./room-leader.ts";
import { readHandoffs } from "./testing/handoff-rows.ts";

// A led group, end to end on the real server with the scripted engine: the person's line reaches the leader alone, the
// leader hands two members work that runs side by side, results come back, and the leader wraps up inside its round cap.
it("runs a group like a department: person to leader, two members in parallel, results back, wrap-up, hop cap", async () => {
  const session = await launchVerificationServer(process.env, undefined, undefined, undefined, { scripted: true });
  const env = { MADANI_URL: session.info.url };
  const cli = (...args: string[]) => runControlMadani(args, { env }) as Promise<any>;
  const api = (path: string, body?: unknown, method = "POST") => request(path, body === undefined ? {} : { method, body: JSON.stringify(body) }, session.info.url) as Promise<any>;
  const tool = (name: string, args: Record<string, unknown>) => handleToolCall(name, args, (path, options) => request(path, options, session.info.url)) as Promise<any>;
  try {
    const nova = (await cli("new-bot", "--name", "Nova", "--section", "A")).bot;
    const quill = (await cli("new-bot", "--name", "Quill", "--section", "A")).bot;
    const ray = (await cli("new-bot", "--name", "Ray", "--section", "A")).bot;
    const room = (await tool("create_channel", { name: "Launch", member_ids: [nova.id, quill.id, ray.id] })).channel;
    const led = (await api(`/api/groups/${room.id}`, { defaultResponder: { kind: "member", botId: nova.id, leader: true } }, "PATCH"));
    expect((led.group ?? led).defaultResponder).toEqual({ kind: "member", botId: nova.id, leader: true });

    const file = (name: string) => join(session.info.dataDir, name);
    const planPath = file("room-plan.json");
    const hand = (botId: string, message: string, extra: Record<string, unknown> = {}) => ({ arguments: { bot_ids: [botId], message, ...extra } });
    writeFileSync(planPath, JSON.stringify({
      [nova.id]: { turns: [
        { steps: [hand(quill.id, "Draft the launch post"), hand(ray.id, "Design the launch banner")], reply: "Quill and Ray are on it.",
          expectContextIncludes: ["You lead this group", `Quill [id: ${quill.id}]`, `Ray [id: ${ray.id}]`] },
        { steps: [hand(quill.id, "Tighten the post to three lines", { rework: true })], reply: "Asked Quill to tighten it." },
        { steps: [hand(ray.id, "Make the banner square", { rework: true })], reply: "Asked Ray for a square banner." },
        { steps: [{ ...hand(quill.id, "One more pass on the post", { rework: true }), expectError: true }],
          reply: "Wrap-up: the launch post and a square banner are ready." },
      ] },
      [quill.id]: { turns: [
        { reply: "Post drafted.", gateFile: file("quill.gate"), readyFile: file("quill.ready"), expectContextIncludes: ["You are working for Nova"] },
        { reply: "Post tightened." },
      ] },
      [ray.id]: { turns: [
        { reply: "Banner designed.", gateFile: file("ray.gate"), readyFile: file("ray.ready"), expectContextIncludes: ["You are working for Nova"] },
        { reply: "Banner squared." },
      ] },
    }));

    // no @mention: the leader alone gets the person's line
    await cli("send-channel", "--channel", room.id, "--text", "Get the launch ready");
    await expect.poll(() => existsSync(file("quill.ready")) && existsSync(file("ray.ready")), { timeout: 45_000 }).toBe(true);
    const jobs = () => readHandoffs(session.info.dataDir).filter((n: any) => n.parentId);
    // both members are mid-task at the same moment, each in a thread of its own
    expect(jobs().filter((n: any) => n.status === "running").map((n: any) => n.botId).sort()).toEqual([quill.id, ray.id].sort());
    expect(jobs().every((n: any) => n.threadId !== room.activeTaskId)).toBe(true);
    writeFileSync(file("quill.gate"), "go");
    writeFileSync(file("ray.gate"), "go");

    const lines = () => readFileSync(`${planPath}.evidence.jsonl`, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    await expect.poll(() => lines().filter((turn: any) => turn.botId === nova.id).length, { timeout: 90_000, interval: 250 }).toBe(LEADER_MAX_ROUNDS + 1);
    expect((await cli("wait", "--channel", room.id, "--timeout", "60")).status).toBe("settled");

    const novaTurns = lines().filter((turn: any) => turn.botId === nova.id);
    // only the leader answered the person's line in the room: the members' turns all ran in their own threads
    expect(lines().filter((turn: any) => turn.threadId === room.activeTaskId).every((turn: any) => turn.botId === nova.id)).toBe(true);
    // the fourth round was refused, so nothing more went out
    const capped = novaTurns.at(-1).evidence.find((entry: any) => entry.step)?.response;
    expect(JSON.stringify(capped)).toContain(`in ${LEADER_MAX_ROUNDS} rounds for this message, the limit`);
    expect(jobs().length).toBe(4);
    expect(jobs().every((n: any) => n.status === "completed")).toBe(true);

    const messages = (await api(`/api/threads/${room.activeTaskId}/messages`, undefined, "GET")).messages;
    const sent = messages.filter((m: any) => m.handoff?.phase === "sent");
    expect(sent.map((m: any) => [m.handoff.from.name, m.handoff.to.name, m.handoff.text])).toEqual([
      ["Nova", "Quill", "Draft the launch post"],
      ["Nova", "Ray", "Design the launch banner"],
      ["Nova", "Quill", "Tighten the post to three lines"],
      ["Nova", "Ray", "Make the banner square"],
    ]);
    const results = messages.filter((m: any) => m.handoff?.phase === "result");
    expect(results.map((m: any) => `${m.handoff.from.name}->${m.handoff.to.name}:${m.tool?.output}`).sort()).toEqual([
      "Quill->Nova:Post drafted.", "Quill->Nova:Post tightened.", "Ray->Nova:Banner designed.", "Ray->Nova:Banner squared.",
    ]);
    const last = messages.filter((m: any) => m.kind === "text" && m.from?.botId === nova.id).at(-1);
    expect(last?.text).toContain("Wrap-up: the launch post and a square banner are ready.");
    console.info(JSON.stringify({ group: room.id, url: session.info.url, dataDir: session.info.dataDir, rows: messages.length }));
  } finally {
    await session.close();
  }
}, 180_000);

// Outside a group a bot leads the same way: it hands two of the person's other bots work, both show as hand-off rows in
// the one-to-one chat, run side by side in their own threads, report back, and the bot wraps up.
it("leads from a one-to-one chat too: hand-off rows, parallel work, results back, wrap-up", async () => {
  const session = await launchVerificationServer(process.env, undefined, undefined, undefined, { scripted: true });
  const env = { MADANI_URL: session.info.url };
  const cli = (...args: string[]) => runControlMadani(args, { env }) as Promise<any>;
  const api = (path: string) => request(path, {}, session.info.url) as Promise<any>;
  try {
    const nova = (await cli("new-bot", "--name", "Nova", "--section", "A")).bot;
    const quill = (await cli("new-bot", "--name", "Quill", "--section", "A")).bot;
    const ray = (await cli("new-bot", "--name", "Ray", "--section", "A")).bot;
    const file = (name: string) => join(session.info.dataDir, name);
    const planPath = file("room-plan.json");
    writeFileSync(planPath, JSON.stringify({
      [nova.id]: { turns: [
        { steps: [{ arguments: { bot_ids: [quill.id], message: "Draft the launch post" } }, { arguments: { bot_ids: [ray.id], message: "Design the banner" } }], reply: "Handed out." },
        { reply: "Wrap-up: post and banner are ready." },
      ] },
      [quill.id]: { reply: "Post drafted.", gateFile: file("quill.gate"), readyFile: file("quill.ready") },
      [ray.id]: { reply: "Banner designed.", gateFile: file("ray.gate"), readyFile: file("ray.ready") },
    }));
    await cli("send", "--bot", nova.id, "--text", "Get the launch ready");
    await expect.poll(() => existsSync(file("quill.ready")) && existsSync(file("ray.ready")), { timeout: 45_000 }).toBe(true);
    writeFileSync(file("quill.gate"), "go");
    writeFileSync(file("ray.gate"), "go");
    const evidence = () => readFileSync(`${planPath}.evidence.jsonl`, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    const chat = evidence().find((turn: any) => turn.botId === nova.id).threadId;
    await expect.poll(async () => (await api(`/api/threads/${chat}/messages`)).messages
      .some((m: any) => m.kind === "text" && m.text?.includes("Wrap-up: post and banner are ready.")), { timeout: 60_000, interval: 250 }).toBe(true);
    const messages = (await api(`/api/threads/${chat}/messages`)).messages;
    expect(messages.filter((m: any) => m.handoff?.phase === "sent").map((m: any) => `${m.handoff.to.name}:${m.handoff.text}`))
      .toEqual(["Quill:Draft the launch post", "Ray:Design the banner"]);
    expect(messages.filter((m: any) => m.handoff?.phase === "result").map((m: any) => `${m.handoff.from.name}->${m.handoff.to.name}`).sort())
      .toEqual(["Quill->Nova", "Ray->Nova"]);
    expect(evidence().filter((turn: any) => turn.botId === nova.id).length).toBe(2);
  } finally {
    await session.close();
  }
}, 120_000);
