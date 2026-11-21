// The review cloud's demo bot answers through a madani-owned key, not the cloud's free model, whose shared free quota runs
// out. The paid OpenRouter key wins when both are set; Groq's free tier is the fallback. A key's own limit at its
// provider is the spend cap. MADANI_REVIEW_AI_MODEL (madani.env or the environment) swaps the OpenRouter model.
export const REVIEW_AI_OPENROUTER_MODEL = "deepseek/deepseek-v4.1-flash-1017";
export const REVIEW_AI_NAME = "Demo AI";
export const REVIEW_AI_PROVIDERS = [
  { env: "MADANI_REVIEW_AI_OPENROUTER_KEY", provider: "openrouter", url: "https://openrouter.ai/api/v1", model: REVIEW_AI_OPENROUTER_MODEL, override: "MADANI_REVIEW_AI_MODEL" },
  { env: "MADANI_REVIEW_AI_GROQ_KEY", provider: "groq", url: "https://api.groq.com/openai/v1", model: "openai/gpt-oss-120b" },
];
export const MISSING_REVIEW_AI = `missing ${REVIEW_AI_PROVIDERS.map((item) => item.env).join(" and ")}: the demo bot stays on the cloud's own AI`;

/** the first provider whose key is set, in REVIEW_AI_PROVIDERS order; `keys` maps env names (and the model override) to values */
export function pickReviewAi(keys) {
  for (const item of REVIEW_AI_PROVIDERS) {
    const key = typeof keys[item.env] === "string" ? keys[item.env].trim() : "";
    const model = (item.override && typeof keys[item.override] === "string" && keys[item.override].trim()) || item.model;
    if (key) return { env: item.env, provider: item.provider, url: item.url, model, key };
  }
  return null;
}

/**
 * Adds the chosen key to the home as an OpenAI-compatible engine once (found again by its name and base URL) and points
 * the demo bot at it. `call(path, init)` reaches the home with a paired session. Returns what changed, for the log.
 */
export async function wireDemoAi(call, { botId, ai }) {
  if (!ai) return { wired: false, reason: MISSING_REVIEW_AI };
  const listed = await call("/api/instances");
  if (!listed.ok) throw new Error(`the home's engines answered ${listed.status}`);
  const host = new URL(ai.url).host;
  let instance = (listed.data?.instances ?? []).find((item) => item.displayName === REVIEW_AI_NAME && (!item.url || item.url.includes(host)));
  let added = false;
  if (!instance) {
    const made = await call("/api/instances/openai-compat", { method: "POST", body: { displayName: REVIEW_AI_NAME, url: ai.url, key: ai.key, models: [ai.model] } });
    if (!made.ok) throw new Error(`adding the demo AI answered ${made.status} (${made.data?.error ?? "no detail"})`);
    instance = { instanceId: made.data.instanceId };
    added = true;
  }
  const bots = await call("/api/bots?messages=0");
  const bot = (bots.data?.bots ?? []).find((item) => item.id === botId);
  if (!bot) throw new Error("the demo bot is gone");
  const pointed = bot.modelSelection?.instanceId === instance.instanceId && bot.modelSelection?.model === ai.model;
  if (!pointed) {
    const patched = await call(`/api/bots/${botId}`, { method: "PATCH", body: { modelSelection: { instanceId: instance.instanceId, model: ai.model } } });
    if (!patched.ok) throw new Error(`pointing the demo bot at the demo AI answered ${patched.status} (${patched.data?.error ?? "no detail"})`);
  }
  return { wired: true, added, pointed: !pointed, instanceId: instance.instanceId, provider: ai.provider, model: ai.model };
}
