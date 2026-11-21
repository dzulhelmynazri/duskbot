import { existsSync, readFileSync, rmSync } from "node:fs";
import { expect, it } from "vitest";
import { launchVerificationServer } from "../scripts/control-madani.ts";
import { callTool, toolCallContextFromEnv } from "./drivers/agents-call.ts";

it("installs and updates a shared skill through bot tools, retaining readable prompt paths and refusing stale revisions", async () => {
  const fixture = await launchVerificationServer({ FAKE_CLAUDE_MODE: "hang" });
  const { url } = fixture.info;
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(url + path, { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const result = await response.json() as any;
    expect(response.status, JSON.stringify(result)).toBeLessThan(300);
    return result;
  };
  const skill = (version: string) => `---\nname: invoice-review\ndescription: Reviews invoices before payment.\n---\n\nRead every invoice line. ${version}\n`;
  try {
    await api("PATCH", "/api/config", { features: { skillsLibrary: true, shareLearnedSkills: "auto" } });
    const author = (await api("POST", "/api/bots", { name: "Library author", section: "Finance fixture" })).bot;
    const mate = (await api("POST", "/api/bots", { name: "Library reader", section: "Finance fixture" })).bot;
    for (const bot of [author, mate]) await api("PATCH", `/api/bots/${bot.id}`, { computer: "off", browser: false });
    const start = async (bot: typeof author) => {
      rmSync(fixture.fixtureDumpPath, { force: true });
      await api("POST", `/api/bots/${bot.id}/messages`, { text: "Review the invoice." });
      await expect.poll(() => existsSync(fixture.fixtureDumpPath), { timeout: 15_000 }).toBe(true);
      const dump = JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8"));
      return { dump, context: toolCallContextFromEnv(dump.mcpConfig.mcpServers.agents.env) };
    };
    const stop = async (bot: typeof author) => {
      await api("POST", `/api/bots/${bot.id}/interrupt`, {});
      await expect.poll(async () => (await api("GET", "/api/bots?messages=0")).bots.find((row: typeof author) => row.id === bot.id)?.busy).toBe(false);
    };
    const first = await start(author);
    const installed = await callTool("skill_manage", { action: "create", source: "conversation", skill_md: skill("Version one.") }, first.context);
    expect(installed.isError, installed.text).not.toBe(true);
    expect(installed.text).toContain("enabled");
    const listing = await callTool("skills_list", {}, first.context);
    const revision = /invoice-review[^\n]*revision ([a-f0-9]+)/.exec(listing.text)?.[1];
    expect(revision, listing.text).toBeTruthy();
    await stop(author);
    const reader = await start(mate);
    const path = /invoice-review[^\n]*Read "([^"]+SKILL\.md)"/.exec(reader.dump.systemPrompt + (typeof reader.dump.prompt.message.content === "string" ? reader.dump.prompt.message.content : reader.dump.prompt.message.content.map((part: { text?: string }) => part.text ?? "").join("\n")))?.[1];
    expect(path, reader.dump.systemPrompt).toBeTruthy();
    expect(readFileSync(path!, "utf8")).toContain("Version one.");
    expect((await api("GET", `/api/bots/${mate.id}/skills`)).skills).toContainEqual(expect.objectContaining({ name: "invoice-review", origin: "library", enabled: true }));
    const updated = await callTool("skill_manage", { action: "update", skill_name: "invoice-review", source: "conversation", base_revision: revision, skill_md: skill("Version two.") }, reader.context);
    expect(updated.isError, updated.text).not.toBe(true);
    expect(readFileSync(path!, "utf8")).toContain("Version two.");
    await expect(callTool("skill_manage", { action: "update", skill_name: "invoice-review", source: "conversation", base_revision: revision, skill_md: skill("Stale overwrite.") }, reader.context)).rejects.toThrow("changed since");
    expect(readFileSync(path!, "utf8")).toContain("Version two.");
    await stop(mate);
    const next = await start(author);
    const nextPath = /invoice-review:[^\n]*Read "([^"]+SKILL\.md)"/.exec(next.dump.systemPrompt)?.[1];
    expect(readFileSync(nextPath!, "utf8")).toContain("Version two.");
    await stop(author);
  } finally {
    await fixture.close();
  }
}, 60_000);
