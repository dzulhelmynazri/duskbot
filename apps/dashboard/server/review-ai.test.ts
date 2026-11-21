import { expect, it } from "vitest";
import { MISSING_REVIEW_AI, pickReviewAi, wireDemoAi } from "../scripts/review-ai.mjs";

function fakeHome() {
  const instances: Array<{ instanceId: string; displayName: string; url?: string }> = [{ instanceId: "opencodeGo", displayName: "OpenCode" }];
  const bot = { id: "b1", modelSelection: { instanceId: "opencodeGo", model: "opencode/big-pickle" } as { instanceId: string; model: string } };
  const sent: Array<{ path: string; method: string; body?: Record<string, unknown> }> = [];
  let n = 0;
  async function call(path: string, init: { method?: string; body?: Record<string, unknown> } = {}) {
    const method = init.method ?? "GET";
    sent.push({ path, method, ...(init.body ? { body: init.body } : {}) });
    if (path === "/api/instances" && method === "GET") return { ok: true, status: 200, data: { instances } };
    if (path === "/api/instances/openai-compat" && method === "POST") {
      const instanceId = `openai-compat:${++n}`;
      instances.push({ instanceId, displayName: String(init.body!.displayName), url: String(init.body!.url) });
      return { ok: true, status: 201, data: { instanceId } };
    }
    if (path.startsWith("/api/bots?")) return { ok: true, status: 200, data: { bots: [bot] } };
    if (path === "/api/bots/b1" && method === "PATCH") { bot.modelSelection = init.body!.modelSelection as typeof bot.modelSelection; return { ok: true, status: 200, data: { bot } }; }
    return { ok: false, status: 404, data: { error: "no route" } };
  }
  return { call, sent, bot };
}

it("picks the paid OpenRouter key over Groq, Groq alone when that is all there is, and nothing without either", () => {
  expect(pickReviewAi({ MADANI_REVIEW_AI_OPENROUTER_KEY: "sk-or", MADANI_REVIEW_AI_GROQ_KEY: "gsk" })).toMatchObject({ provider: "openrouter", url: "https://openrouter.ai/api/v1", model: "deepseek/deepseek-v4.1-flash-1017", key: "sk-or" });
  expect(pickReviewAi({ MADANI_REVIEW_AI_OPENROUTER_KEY: "sk-or", MADANI_REVIEW_AI_MODEL: "x/cheap" })).toMatchObject({ provider: "openrouter", model: "x/cheap" });
  expect(pickReviewAi({ MADANI_REVIEW_AI_GROQ_KEY: "gsk", MADANI_REVIEW_AI_MODEL: "x/cheap" })).toMatchObject({ provider: "groq", model: "openai/gpt-oss-120b" });
  expect(pickReviewAi({ MADANI_REVIEW_AI_OPENROUTER_KEY: "  ", MADANI_REVIEW_AI_GROQ_KEY: "gsk" })).toMatchObject({ provider: "groq", url: "https://api.groq.com/openai/v1", model: "openai/gpt-oss-120b", key: "gsk" });
  expect(pickReviewAi({ MADANI_REVIEW_AI_OPENROUTER_KEY: null, MADANI_REVIEW_AI_GROQ_KEY: "" })).toBeNull();
  expect(MISSING_REVIEW_AI).toContain("MADANI_REVIEW_AI_OPENROUTER_KEY and MADANI_REVIEW_AI_GROQ_KEY");
});

it("says both keys are missing and changes nothing without one", async () => {
  const home = fakeHome();
  expect(await wireDemoAi(home.call, { botId: "b1", ai: null })).toEqual({ wired: false, reason: MISSING_REVIEW_AI });
  expect(home.sent).toEqual([]);
});

it("adds the chosen engine once as Demo AI and points the demo bot at its model, idempotently", async () => {
  const home = fakeHome(), ai = pickReviewAi({ MADANI_REVIEW_AI_GROQ_KEY: "gsk-fake" });
  expect(await wireDemoAi(home.call, { botId: "b1", ai })).toMatchObject({ wired: true, added: true, pointed: true, provider: "groq", model: "openai/gpt-oss-120b" });
  expect(home.sent.find(item => item.method === "POST")?.body).toEqual({ displayName: "Demo AI", url: "https://api.groq.com/openai/v1", key: "gsk-fake", models: ["openai/gpt-oss-120b"] });
  expect(home.bot.modelSelection).toEqual({ instanceId: "openai-compat:1", model: "openai/gpt-oss-120b" });
  const again = home.sent.length;
  expect(await wireDemoAi(home.call, { botId: "b1", ai })).toMatchObject({ wired: true, added: false, pointed: false });
  expect(home.sent.slice(again).filter(item => item.method !== "GET")).toEqual([]);
  // the paid key arriving later adds its own Demo AI engine and moves the bot to it
  expect(await wireDemoAi(home.call, { botId: "b1", ai: pickReviewAi({ MADANI_REVIEW_AI_OPENROUTER_KEY: "sk-or", MADANI_REVIEW_AI_GROQ_KEY: "gsk-fake" }) }))
    .toMatchObject({ added: true, pointed: true, provider: "openrouter" });
  expect(home.bot.modelSelection).toEqual({ instanceId: "openai-compat:2", model: "deepseek/deepseek-v4.1-flash-1017" });
});
