// Every model provider the app can connect: one table for Settings > Models, the bot model picker and the server that
// saves the connection. A provider either signs in through one of the app's engines (Claude, ChatGPT, Gemini, Grok) or
// takes a key and becomes an OpenAI-compatible (or Anthropic-compatible) connection on the machine the bots run on.

/** Which API the connection speaks: OpenAI chat completions, or Anthropic messages (run by Claude Code). */
export type ProviderWire = "openai" | "anthropic";

/** "more" is every other provider models.dev lists with an OpenAI-compatible address. */
export type ProviderSection = "major" | "open" | "fast" | "router" | "enterprise" | "local" | "custom" | "more";

export const PROVIDER_SECTIONS: readonly ProviderSection[] = ["major", "open", "fast", "router", "enterprise", "local", "custom", "more"];

export type ProviderFieldId = "baseUrl" | "resource" | "region" | "project" | "location" | "model";

export interface ProviderField {
  id: ProviderFieldId;
  label: string;
  placeholder: string;
  optional?: true;
}

/** Where a bot runs, which is also where its connections live. */
export type Place = "computer" | "cloud" | "server";

export interface ModelProviderDef {
  id: string;
  label: string;
  section: ProviderSection;
  wire: ProviderWire;
  /** Base URL; `{resource}`, `{region}`, `{project}` and `{location}` come from the fields of the same name. */
  baseUrl: string;
  fields?: readonly ProviderField[];
  /** models.dev provider id, for the catalog's models, prices and limits. */
  catalogId?: string;
  keyUrl?: string;
  keyPlaceholder?: string;
  /** A server on this machine or its network that needs no key. */
  keyless?: true;
  /** Runs on the machine itself: offered only where it can be reached, never on madani cloud. */
  local?: { port: number };
  /** Engines that sign in with a subscription, by driver kind; their instances count as this provider connected. */
  signIn?: { label: string; driverKinds: readonly string[] };
  /** The app's own instances (by id or driver kind) that already connect this provider with a saved key. */
  instances?: readonly string[];
  driverKinds?: readonly string[];
  /** Added OpenAI-compatible connections whose address is on one of these hosts belong to this provider. */
  hosts?: readonly string[];
  /** How the server lists the provider's models once a key is set; "none" leaves it to the catalog. */
  listModels: "openai" | "anthropic" | "none";
  /** Extra search words. */
  words: readonly string[];
  /** One plain line under the name. */
  note?: string;
}

const BASE_URL: ProviderField = { id: "baseUrl", label: "Base URL", placeholder: "https://example.com/v1" };
const MODEL: ProviderField = { id: "model", label: "Model id", placeholder: "Optional, for example gpt-5", optional: true };

export const MODEL_PROVIDERS: readonly ModelProviderDef[] = [
  { id: "anthropic", label: "Anthropic", section: "major", wire: "anthropic", baseUrl: "https://api.anthropic.com", catalogId: "anthropic",
    keyUrl: "https://console.anthropic.com/settings/keys", keyPlaceholder: "sk-ant-…", listModels: "anthropic",
    signIn: { label: "Sign in with Claude", driverKinds: ["claudeAgent"] }, hosts: ["api.anthropic.com"], words: ["claude", "opus", "sonnet", "haiku"] },
  { id: "openai", label: "OpenAI", section: "major", wire: "openai", baseUrl: "https://api.openai.com/v1", catalogId: "openai",
    keyUrl: "https://platform.openai.com/api-keys", keyPlaceholder: "sk-…", listModels: "openai",
    signIn: { label: "Sign in with ChatGPT", driverKinds: ["codex"] }, instances: ["openai"], hosts: ["api.openai.com"], words: ["chatgpt", "gpt", "codex", "o3", "o4"] },
  { id: "google", label: "Google Gemini", section: "major", wire: "openai", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", catalogId: "google",
    keyUrl: "https://aistudio.google.com/apikey", keyPlaceholder: "AIza…", listModels: "openai",
    signIn: { label: "Sign in with Google", driverKinds: ["geminiAgent", "antigravityAgent"] }, hosts: ["generativelanguage.googleapis.com"], words: ["gemini", "google ai studio", "gemma"] },
  { id: "xai", label: "xAI Grok", section: "major", wire: "openai", baseUrl: "https://api.x.ai/v1", catalogId: "xai",
    keyUrl: "https://console.x.ai", keyPlaceholder: "xai-…", listModels: "openai",
    signIn: { label: "Sign in with Grok", driverKinds: ["grokAgent"] }, driverKinds: ["grok"], hosts: ["api.x.ai"], words: ["grok", "x"] },
  { id: "mistral", label: "Mistral", section: "major", wire: "openai", baseUrl: "https://api.mistral.ai/v1", catalogId: "mistral",
    keyUrl: "https://console.mistral.ai/api-keys", listModels: "openai", driverKinds: ["mistral"], hosts: ["api.mistral.ai", "codestral.mistral.ai"], words: ["codestral", "devstral", "magistral"] },
  { id: "deepseek", label: "DeepSeek", section: "major", wire: "openai", baseUrl: "https://api.deepseek.com/v1", catalogId: "deepseek",
    keyUrl: "https://platform.deepseek.com/api_keys", keyPlaceholder: "sk-…", listModels: "openai", driverKinds: ["deepseekAgent"], hosts: ["api.deepseek.com"], words: ["r1", "v3", "reasoner"] },
  { id: "meta", label: "Meta Llama", section: "major", wire: "openai", baseUrl: "https://api.meta.ai/v1", catalogId: "meta",
    keyUrl: "https://dev.meta.ai/docs", listModels: "openai", hosts: ["api.meta.ai"], words: ["llama", "llama api", "facebook"] },
  { id: "qwen", label: "Qwen", section: "open", wire: "openai", baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1", catalogId: "alibaba",
    keyUrl: "https://modelstudio.console.alibabacloud.com/", keyPlaceholder: "sk-…", listModels: "openai", driverKinds: ["qwenAgent"],
    hosts: ["dashscope-intl.aliyuncs.com", "dashscope.aliyuncs.com"], words: ["alibaba", "dashscope", "qwen3", "qwq", "model studio"] },
  { id: "moonshot", label: "Moonshot Kimi", section: "open", wire: "openai", baseUrl: "https://api.moonshot.ai/v1", catalogId: "moonshotai",
    keyUrl: "https://platform.moonshot.ai/console/api-keys", keyPlaceholder: "sk-…", listModels: "openai", driverKinds: ["kimiAgent"],
    hosts: ["api.moonshot.ai", "api.moonshot.cn"], words: ["kimi", "k2", "moonshotai"] },
  { id: "zhipu", label: "Zhipu GLM", section: "open", wire: "openai", baseUrl: "https://api.z.ai/api/paas/v4", catalogId: "zai",
    keyUrl: "https://z.ai/manage-apikey/apikey-list", listModels: "openai", hosts: ["api.z.ai", "open.bigmodel.cn"], words: ["glm", "z.ai", "zai", "zhipuai", "bigmodel"] },
  { id: "minimax", label: "MiniMax", section: "open", wire: "openai", baseUrl: "https://api.minimax.io/v1", catalogId: "minimax",
    keyUrl: "https://platform.minimax.io/docs/guides/quickstart", listModels: "none", hosts: ["api.minimax.io", "api.minimax.cn"], words: ["m2", "hailuo"] },
  { id: "stepfun", label: "StepFun", section: "open", wire: "openai", baseUrl: "https://api.stepfun.ai/v1", catalogId: "stepfun-ai",
    keyUrl: "https://platform.stepfun.ai/docs/en/overview/concept", listModels: "openai", hosts: ["api.stepfun.ai", "api.stepfun.com"], words: ["step"] },
  { id: "xiaomi", label: "Xiaomi MiMo", section: "open", wire: "openai", baseUrl: "https://api.xiaomimimo.com/v1", catalogId: "xiaomi",
    keyUrl: "https://platform.xiaomimimo.com/#/docs", listModels: "openai", hosts: ["api.xiaomimimo.com"], words: ["mimo"] },
  { id: "arcee", label: "Arcee", section: "open", wire: "openai", baseUrl: "https://api.arcee.ai/api/v1", catalogId: "arcee",
    keyUrl: "https://docs.arcee.ai/", listModels: "openai", hosts: ["api.arcee.ai"], words: ["trinity", "afm"] },
  { id: "ai21", label: "AI21 Labs", section: "open", wire: "openai", baseUrl: "https://api.ai21.com/studio/v1", catalogId: "ai21",
    keyUrl: "https://docs.ai21.com/docs/jamba-foundation-models", listModels: "none", hosts: ["api.ai21.com"], words: ["jamba"] },
  { id: "upstage", label: "Upstage Solar", section: "open", wire: "openai", baseUrl: "https://api.upstage.ai/v1/solar", catalogId: "upstage",
    keyUrl: "https://developers.upstage.ai/docs/apis/chat", listModels: "none", hosts: ["api.upstage.ai"], words: ["solar"] },
  { id: "groq", label: "Groq", section: "fast", wire: "openai", baseUrl: "https://api.groq.com/openai/v1", catalogId: "groq",
    keyUrl: "https://console.groq.com/keys", keyPlaceholder: "gsk_…", listModels: "openai", driverKinds: ["groq"], hosts: ["api.groq.com"], words: ["fast", "llama", "lpu"] },
  { id: "cerebras", label: "Cerebras", section: "fast", wire: "openai", baseUrl: "https://api.cerebras.ai/v1", catalogId: "cerebras",
    keyUrl: "https://cloud.cerebras.ai/", keyPlaceholder: "csk-…", listModels: "openai", driverKinds: ["cerebras"], hosts: ["api.cerebras.ai"], words: ["fast"] },
  { id: "together", label: "Together AI", section: "fast", wire: "openai", baseUrl: "https://api.together.xyz/v1", catalogId: "togetherai",
    keyUrl: "https://api.together.ai/settings/api-keys", listModels: "openai", hosts: ["api.together.xyz", "api.together.ai"], words: ["togetherai", "open models", "llama"] },
  { id: "fireworks", label: "Fireworks AI", section: "fast", wire: "openai", baseUrl: "https://api.fireworks.ai/inference/v1", catalogId: "fireworks-ai",
    keyUrl: "https://app.fireworks.ai/settings/users/api-keys", keyPlaceholder: "fw_…", listModels: "openai", hosts: ["api.fireworks.ai"], words: ["fireworks-ai", "open models"] },
  { id: "sambanova", label: "SambaNova", section: "fast", wire: "openai", baseUrl: "https://api.sambanova.ai/v1", catalogId: "sambanova",
    keyUrl: "https://docs.sambanova.ai/cloud/docs/get-started/supported-models", listModels: "openai", hosts: ["api.sambanova.ai"], words: ["fast", "rdu"] },
  { id: "deepinfra", label: "DeepInfra", section: "fast", wire: "openai", baseUrl: "https://api.deepinfra.com/v1/openai", catalogId: "deepinfra",
    keyUrl: "https://deepinfra.com/dash/api_keys", listModels: "openai", hosts: ["api.deepinfra.com"], words: ["deep infra", "open models", "cheap"] },
  { id: "nebius", label: "Nebius", section: "fast", wire: "openai", baseUrl: "https://api.tokenfactory.nebius.com/v1", catalogId: "nebius",
    keyUrl: "https://docs.tokenfactory.nebius.com/", listModels: "openai", hosts: ["api.tokenfactory.nebius.com"], words: ["token factory", "open models"] },
  { id: "novita", label: "Novita AI", section: "fast", wire: "openai", baseUrl: "https://api.novita.ai/openai", catalogId: "novita-ai",
    keyUrl: "https://novita.ai/docs/guides/introduction", listModels: "openai", hosts: ["api.novita.ai"], words: ["novita-ai", "open models"] },
  { id: "siliconflow", label: "SiliconFlow", section: "fast", wire: "openai", baseUrl: "https://api.siliconflow.com/v1", catalogId: "siliconflow",
    keyUrl: "https://cloud.siliconflow.com/models", listModels: "openai", hosts: ["api.siliconflow.com", "api.siliconflow.cn"], words: ["open models"] },
  { id: "baseten", label: "Baseten", section: "fast", wire: "openai", baseUrl: "https://inference.baseten.co/v1", catalogId: "baseten",
    keyUrl: "https://docs.baseten.co/inference/model-apis/overview", listModels: "openai", hosts: ["inference.baseten.co"], words: ["model apis"] },
  { id: "nvidia", label: "NVIDIA NIM", section: "fast", wire: "openai", baseUrl: "https://integrate.api.nvidia.com/v1", catalogId: "nvidia",
    keyUrl: "https://build.nvidia.com", keyPlaceholder: "nvapi-…", listModels: "openai", hosts: ["integrate.api.nvidia.com"], words: ["nim", "nemotron", "build.nvidia.com"] },
  { id: "chutes", label: "Chutes", section: "fast", wire: "openai", baseUrl: "https://llm.chutes.ai/v1", catalogId: "chutes",
    keyUrl: "https://chutes.ai", listModels: "openai", hosts: ["llm.chutes.ai"], words: ["open models", "bittensor"] },
  { id: "inception", label: "Inception Mercury", section: "fast", wire: "openai", baseUrl: "https://api.inceptionlabs.ai/v1", catalogId: "inception",
    keyUrl: "https://docs.inceptionlabs.ai/get-started/models", listModels: "openai", hosts: ["api.inceptionlabs.ai"], words: ["mercury", "diffusion", "fast"] },
  { id: "friendli", label: "Friendli", section: "fast", wire: "openai", baseUrl: "https://api.friendli.ai/serverless/v1", catalogId: "friendli",
    keyUrl: "https://friendli.ai/docs/guides/serverless_endpoints/introduction", listModels: "openai", hosts: ["api.friendli.ai"], words: ["friendliai"] },
  { id: "openrouter", label: "OpenRouter", section: "router", wire: "openai", baseUrl: "https://openrouter.ai/api/v1", catalogId: "openrouter",
    keyUrl: "https://openrouter.ai/keys", keyPlaceholder: "sk-or-v1-…", listModels: "openai", instances: ["openrouter"], hosts: ["openrouter.ai"],
    words: ["router", "every model", "free"], note: "One key for hundreds of models." },
  { id: "perplexity", label: "Perplexity", section: "major", wire: "openai", baseUrl: "https://api.perplexity.ai", catalogId: "perplexity-agent",
    keyUrl: "https://www.perplexity.ai/account/api/keys", keyPlaceholder: "pplx-…", listModels: "none", hosts: ["api.perplexity.ai"], words: ["sonar", "search"] },
  { id: "cohere", label: "Cohere", section: "router", wire: "openai", baseUrl: "https://api.cohere.ai/compatibility/v1", catalogId: "cohere",
    keyUrl: "https://dashboard.cohere.com/api-keys", listModels: "none", hosts: ["api.cohere.ai", "api.cohere.com"], words: ["command", "command-a"] },
  { id: "vercel", label: "Vercel AI Gateway", section: "router", wire: "openai", baseUrl: "https://ai-gateway.vercel.sh/v1", catalogId: "vercel",
    keyUrl: "https://vercel.com/docs/ai-gateway", listModels: "openai", hosts: ["ai-gateway.vercel.sh"], words: ["gateway", "router", "every model"] },
  { id: "requesty", label: "Requesty", section: "router", wire: "openai", baseUrl: "https://router.requesty.ai/v1", catalogId: "requesty",
    keyUrl: "https://requesty.ai/solution/llm-routing/models", listModels: "openai", hosts: ["router.requesty.ai"], words: ["router", "gateway"] },
  { id: "huggingface", label: "Hugging Face", section: "router", wire: "openai", baseUrl: "https://router.huggingface.co/v1", catalogId: "huggingface",
    keyUrl: "https://huggingface.co/settings/tokens", keyPlaceholder: "hf_…", listModels: "openai", hosts: ["router.huggingface.co"], words: ["hf", "inference providers", "open models"] },
  { id: "helicone", label: "Helicone", section: "router", wire: "openai", baseUrl: "https://ai-gateway.helicone.ai/v1", catalogId: "helicone",
    keyUrl: "https://helicone.ai/models", listModels: "openai", hosts: ["ai-gateway.helicone.ai"], words: ["gateway", "observability"] },
  { id: "poe", label: "Poe", section: "router", wire: "openai", baseUrl: "https://api.poe.com/v1", catalogId: "poe",
    keyUrl: "https://poe.com/api_key", listModels: "openai", hosts: ["api.poe.com"], words: ["quora", "every model"] },
  { id: "nanogpt", label: "NanoGPT", section: "router", wire: "openai", baseUrl: "https://nano-gpt.com/api/v1", catalogId: "nano-gpt",
    keyUrl: "https://docs.nano-gpt.com/", listModels: "openai", hosts: ["nano-gpt.com"], words: ["nano-gpt", "pay as you go", "every model"] },
  { id: "aimlapi", label: "AI/ML API", section: "router", wire: "openai", baseUrl: "https://api.aimlapi.com/v1", catalogId: "aimlapi",
    keyUrl: "https://docs.aimlapi.com/", listModels: "openai", hosts: ["api.aimlapi.com"], words: ["aimlapi", "every model"] },
  { id: "azure", label: "Azure OpenAI", section: "enterprise", wire: "openai", baseUrl: "https://{resource}.openai.azure.com/openai/v1", catalogId: "azure",
    fields: [{ id: "resource", label: "Resource name", placeholder: "my-resource" }], keyUrl: "https://portal.azure.com", listModels: "openai",
    hosts: [".openai.azure.com", ".services.ai.azure.com", ".cognitiveservices.azure.com"], words: ["microsoft", "foundry", "azure ai"],
    note: "Model ids are your deployment names." },
  { id: "bedrock", label: "AWS Bedrock", section: "enterprise", wire: "openai", baseUrl: "https://bedrock-runtime.{region}.amazonaws.com/openai/v1", catalogId: "amazon-bedrock",
    fields: [{ id: "region", label: "Region", placeholder: "us-east-1" }], keyUrl: "https://console.aws.amazon.com/bedrock/home#/api-keys", listModels: "none",
    hosts: [".amazonaws.com"], words: ["amazon", "aws", "nova", "titan"], note: "Uses a Bedrock API key." },
  { id: "vertex", label: "Google Vertex AI", section: "enterprise", wire: "openai",
    baseUrl: "https://aiplatform.googleapis.com/v1/projects/{project}/locations/{location}/endpoints/openapi", catalogId: "google-vertex",
    fields: [{ id: "project", label: "Project id", placeholder: "my-project" }, { id: "location", label: "Location", placeholder: "global" }],
    keyUrl: "https://cloud.google.com/vertex-ai/generative-ai/docs/migrate/openai/overview", keyPlaceholder: "Access token", listModels: "none",
    hosts: ["aiplatform.googleapis.com", "-aiplatform.googleapis.com"], words: ["gcp", "google cloud", "gemini"],
    note: "Paste an access token from gcloud auth print-access-token; it lasts an hour." },
  { id: "digitalocean", label: "DigitalOcean", section: "enterprise", wire: "openai", baseUrl: "https://inference.do-ai.run/v1", catalogId: "digitalocean",
    keyUrl: "https://docs.digitalocean.com/products/gradient-ai-platform/details/models/", listModels: "openai", hosts: ["inference.do-ai.run"], words: ["gradient", "do"] },
  { id: "scaleway", label: "Scaleway", section: "enterprise", wire: "openai", baseUrl: "https://api.scaleway.ai/v1", catalogId: "scaleway",
    keyUrl: "https://www.scaleway.com/en/docs/generative-apis/", listModels: "openai", hosts: ["api.scaleway.ai"], words: ["eu", "europe", "generative apis"] },
  { id: "ovhcloud", label: "OVHcloud", section: "enterprise", wire: "openai", baseUrl: "https://oai.endpoints.kepler.ai.cloud.ovh.net/v1", catalogId: "ovhcloud",
    keyUrl: "https://www.ovhcloud.com/en/public-cloud/ai-endpoints/", listModels: "openai", hosts: ["oai.endpoints.kepler.ai.cloud.ovh.net"], words: ["ovh", "eu", "ai endpoints"] },
  { id: "ollama", label: "Ollama", section: "local", wire: "openai", baseUrl: "http://127.0.0.1:11434/v1", keyless: true, local: { port: 11434 },
    listModels: "openai", hosts: ["127.0.0.1:11434", "localhost:11434"], words: ["local", "llama", "gemma", "offline"] },
  { id: "lmstudio", label: "LM Studio", section: "local", wire: "openai", baseUrl: "http://127.0.0.1:1234/v1", catalogId: "lmstudio", keyless: true, local: { port: 1234 },
    listModels: "openai", hosts: ["127.0.0.1:1234", "localhost:1234"], words: ["local", "lm studio", "offline"] },
  { id: "llamacpp", label: "llama.cpp", section: "local", wire: "openai", baseUrl: "http://127.0.0.1:8080/v1", keyless: true, local: { port: 8080 },
    fields: [{ ...BASE_URL, placeholder: "http://127.0.0.1:8080/v1", optional: true }], listModels: "openai",
    hosts: ["127.0.0.1:8080", "localhost:8080"], words: ["local", "llama-server", "gguf"] },
  { id: "vllm", label: "vLLM", section: "local", wire: "openai", baseUrl: "http://127.0.0.1:8000/v1", keyless: true, local: { port: 8000 },
    fields: [{ ...BASE_URL, placeholder: "http://127.0.0.1:8000/v1", optional: true }], listModels: "openai",
    hosts: ["127.0.0.1:8000", "localhost:8000"], words: ["local", "server", "gpu"] },
  { id: "jan", label: "Jan", section: "local", wire: "openai", baseUrl: "http://127.0.0.1:1337/v1", keyless: true, local: { port: 1337 },
    listModels: "openai", hosts: ["127.0.0.1:1337", "localhost:1337"], words: ["local", "offline", "jan.ai"] },
  { id: "cliproxyapi", label: "CLIProxyAPI", section: "local", wire: "openai", baseUrl: "http://127.0.0.1:8317/v1", local: { port: 8317 },
    fields: [{ ...BASE_URL, placeholder: "http://127.0.0.1:8317/v1", optional: true }], keyUrl: "https://github.com/router-for-me/CLIProxyAPI",
    listModels: "openai", hosts: ["127.0.0.1:8317", "localhost:8317"], words: ["gateway", "proxy", "cli proxy", "mchat", "subscriptions"],
    note: "A local gateway that serves your subscriptions as an API." },
  { id: "custom-openai", label: "OpenAI-compatible", section: "custom", wire: "openai", baseUrl: "", fields: [BASE_URL, MODEL], listModels: "openai",
    words: ["custom", "endpoint", "base url", "self-hosted", "proxy", "gateway", "litellm"], note: "Any server that speaks the OpenAI API." },
  { id: "custom-anthropic", label: "Anthropic-compatible", section: "custom", wire: "anthropic", baseUrl: "", fields: [{ ...BASE_URL, placeholder: "https://example.com" }, MODEL],
    listModels: "anthropic", words: ["custom", "endpoint", "claude code", "messages api", "proxy", "gateway"],
    note: "Any server that speaks the Anthropic API, run through Claude Code." },
];

const BY_ID = new Map(MODEL_PROVIDERS.map((provider) => [provider.id, provider]));

export function modelProvider(id: string): ModelProviderDef | undefined {
  return BY_ID.get(id);
}

/** The base URL a connection uses, with its fields filled in; null while a needed field is missing or unsafe. */
export function providerBaseUrl(def: ModelProviderDef, fields: Partial<Record<ProviderFieldId, string>> = {}): string | null {
  const own = fields.baseUrl?.trim();
  if (own) return own.replace(/\/+$/u, "");
  if (!def.baseUrl) return null;
  let missing = false;
  const url = def.baseUrl.replace(/\{(\w+)\}/gu, (_, name: string) => {
    const value = fields[name as ProviderFieldId]?.trim() ?? "";
    // a field lands inside a host name or path segment: letters, digits, dots, dashes and underscores only
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/u.test(value)) missing = true;
    return value;
  });
  return missing ? null : url;
}

/** The fields a person must fill in before the connection can be saved. */
export function requiredFields(def: Pick<ModelProviderDef, "fields">): ProviderField[] {
  return (def.fields ?? []).filter((field) => !field.optional);
}

export interface ProviderOffer {
  offered: boolean;
  /** Why not, or why it is marked: a local server madani cloud cannot reach, or one this machine does not run. */
  reason?: "cloud" | "not-running";
}

/** Whether a provider is offered where the bots run. A local server is offered on a computer (marked when it is not
 * running), on a server only when that server runs it, and never on madani cloud, which reaches no one's local models. */
export function providerOffer(def: ModelProviderDef, place: Place, running: ReadonlySet<string>): ProviderOffer {
  if (!def.local) return { offered: true };
  if (place === "cloud") return { offered: false, reason: "cloud" };
  if (running.has(def.id)) return { offered: true };
  return place === "computer" ? { offered: true, reason: "not-running" } : { offered: false, reason: "not-running" };
}

/** The place a server runs as, from its environment. */
export function placeFromEnv(env: Record<string, string | undefined>): Place {
  if (env.MADANI_CLOUD_ROLE === "home" || env.MADANI_CLOUD_ROLE === "team") return "cloud";
  // a source checkout's `pnpm dev:app` runs the harness as the desktop app's own child too (MADANI_DEV_OWN_SERVER)
  return env.MADANI_DESKTOP_PARENT === "1" || env.MADANI_DEV_OWN_SERVER === "1" ? "computer" : "server";
}

export interface ConnectableInstance {
  instanceId: string;
  driverKind: string;
  /** An added connection's base URL. */
  url?: string;
  enabled?: boolean;
  access?: string;
  snapshot?: { state?: string; authenticated?: boolean; freeFallback?: boolean };
}

function hostOf(url: string): string | undefined {
  try { return new URL(url).host.toLowerCase(); } catch { return undefined; }
}

function onHost(host: string, pattern: string): boolean {
  return pattern.startsWith(".") || pattern.startsWith("-") ? host.endsWith(pattern) : host === pattern || host.split(":")[0] === pattern;
}

/** The provider an instance connects, if any. */
export function providerOfInstance(instance: ConnectableInstance): ModelProviderDef | undefined {
  const host = instance.url ? hostOf(instance.url) : undefined;
  if (host) {
    const byHost = MODEL_PROVIDERS.find((def) => def.hosts?.some((pattern) => onHost(host, pattern)));
    if (byHost) return byHost;
  }
  return MODEL_PROVIDERS.find((def) => def.instances?.includes(instance.instanceId))
    ?? MODEL_PROVIDERS.find((def) => def.driverKinds?.includes(instance.driverKind) || def.signIn?.driverKinds.includes(instance.driverKind));
}

/** Ready to answer: on, available, and signed in unless it brings its own credential. */
export function instanceReady(instance: ConnectableInstance): boolean {
  return instance.enabled !== false && instance.snapshot?.state === "available"
    && !(instance.snapshot.authenticated === false && instance.access !== "custom");
}

/** Each provider's ready instances, keyed by provider id. OpenCode's free backup is no one's connection. */
export function connectedProviders(instances: readonly ConnectableInstance[]): Map<string, ConnectableInstance[]> {
  const out = new Map<string, ConnectableInstance[]>();
  for (const instance of instances) {
    if (!instanceReady(instance) || instance.snapshot?.freeFallback) continue;
    const def = providerOfInstance(instance);
    if (!def) continue;
    out.set(def.id, [...(out.get(def.id) ?? []), instance]);
  }
  return out;
}
