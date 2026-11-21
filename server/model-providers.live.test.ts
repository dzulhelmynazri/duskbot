// Against a real CLIProxyAPI gateway (or any OpenAI- and Anthropic-compatible server). Skipped unless
// MADANI_LIVE_GATEWAY_URL and MADANI_LIVE_GATEWAY_KEY are set: it sends one short message through the gateway's accounts
// (MADANI_LIVE_GATEWAY_MODEL picks the model).
//   MADANI_LIVE_GATEWAY_URL=http://127.0.0.1:8317/v1 MADANI_LIVE_GATEWAY_KEY=… pnpm exec vitest run server/model-providers.live.test.ts
import { afterAll, describe, expect, it } from "vitest";

import { modelProvider } from "../shared/model-providers.ts";
import type { ProviderInstance, RuntimeEvent } from "./contracts.ts";
import { OpenAICompatDriver } from "./drivers/openai-compat.ts";
import { buildConnection, listProviderModels } from "./model-providers.ts";

const url = process.env.MADANI_LIVE_GATEWAY_URL;
const key = process.env.MADANI_LIVE_GATEWAY_KEY;
const live = Boolean(url && key);
const PREFERRED = [/^gpt-[\d.]+-mini$/u, /^gpt-[\d.]+(-\w+)?$/u, /^gemini-.*flash/u, /^claude-haiku/u];

describe.skipIf(!live)("custom endpoint on a real gateway (live)", () => {
  const instances: ProviderInstance[] = [];
  afterAll(async () => { await Promise.all(instances.map((instance) => instance.dispose())); });

  it("lists the gateway's models with the CLIProxyAPI preset and answers a message as a saved connection would", async () => {
    const def = modelProvider("cliproxyapi")!;
    const listed = await listProviderModels({ def, baseUrl: url!, key: key! });
    expect(listed.ok).toBe(true);
    const models = listed.ok ? listed.models : [];
    expect(models.length).toBeGreaterThan(0);
    const model = process.env.MADANI_LIVE_GATEWAY_MODEL ?? PREFERRED.map((pattern) => models.find((id) => pattern.test(id))).find(Boolean) ?? models[0]!;

    const built = buildConnection(def, { key: key!, fields: { baseUrl: url! } }, "computer");
    if ("error" in built) throw new Error(built.error);
    const instance = await OpenAICompatDriver.create({
      instanceId: built.instanceId, displayName: built.entry.displayName!, enabled: true, environment: {},
      config: OpenAICompatDriver.decodeConfig(built.entry.config),
    });
    instances.push(instance);
    await instance.refreshModels?.();
    expect(instance.models.options.map((option) => option.id)).toContain(model);

    const events: RuntimeEvent[] = [];
    const done = new Promise<RuntimeEvent>((resolve) => {
      const stop = instance.adapter.onEvent((event) => {
        events.push(event);
        if (event.type === "turn.completed") { stop(); resolve(event); }
      });
    });
    await instance.adapter.sendTurn({ threadId: "live-gateway", text: "Reply with exactly the two words: madani ok", model });
    const completed = await done;
    const errors = events.filter((event) => event.type === "runtime.error").map((event) => (event as { message?: string }).message);
    expect({ ok: (completed as { ok?: boolean }).ok, errors, model }).toMatchObject({ ok: true, errors: [] });
    const text = events.filter((event) => event.type === "item.completed" && event.itemType === "assistant_text")
      .map((event) => (event as { text: string }).text).join(" ");
    expect(text.toLowerCase()).toContain("madani ok");
    console.info(`answered on ${model} (${models.length} models listed)`);
  }, 120_000);

  it("lists the same gateway as an Anthropic-compatible endpoint", async () => {
    const listed = await listProviderModels({ def: modelProvider("custom-anthropic")!, baseUrl: url!.replace(/\/v1\/?$/u, ""), key: key! });
    expect(listed.ok).toBe(true);
    expect(listed.ok && listed.models.some((id) => id.startsWith("claude"))).toBe(true);
  }, 30_000);
});
