export const WORKSPACE_CREDENTIALS = [
  { section: "xai", field: "key", name: "xaiApiKey", env: "XAI_API_KEY" },
  { section: "tts", field: "key", name: "ttsKey", env: "MADANI_TTS_KEY" },
  { section: "tts", field: "fishKey", name: "fishAudioKey", env: "MADANI_FISH_AUDIO_API_KEY" },
  { section: "tts", field: "geminiKey", name: "geminiTtsKey", env: "MADANI_GEMINI_API_KEY" },
  { section: "tts", field: "deepgramKey", name: "deepgramKey", env: "MADANI_DEEPGRAM_API_KEY" },
  { section: "tts", field: "cartesiaKey", name: "cartesiaKey", env: "MADANI_CARTESIA_API_KEY" },
  { section: "tts", field: "assemblyAiKey", name: "assemblyAiKey", env: "MADANI_ASSEMBLYAI_API_KEY" },
  { section: "decider", field: "key", name: "jevApiKey", env: "MADANI_JEV_API_KEY" },
  { section: "decider", field: "openrouterKey", name: "openrouterDeciderKey", env: "MADANI_OPENROUTER_DECIDER_KEY" },
  { section: "decider", field: "gatewayKey", name: "gatewayDeciderKey", env: "MADANI_GATEWAY_DECIDER_KEY" },
  { section: "decider", field: "workersAiToken", name: "workersAiToken", env: "MADANI_WORKERS_AI_TOKEN" },
  { section: "imageGen", field: "key", name: "openaiImageApiKey", env: "MADANI_OPENAI_IMAGE_KEY" },
  { section: "imageGen", field: "customApiKey", name: "customImageApiKey", env: "MADANI_CUSTOM_IMAGE_KEY" },
  { section: "live", field: "key", name: "openaiLiveKey", env: "MADANI_OPENAI_LIVE_KEY" },
  { section: "treg", field: "key", name: "tregApiKey", env: "MADANI_TREG_KEY" },
  { section: "opencodeGo", field: "apiKey", name: "opencodeGoApiKey", env: "OPENCODE_API_KEY" },
];

/** Moves plaintext secrets into the store and deletes the field. "" never drops a stored secret: every packaged
 * credential save writes an empty tombstone to config.json. The caller persists credentials before config. */
export function migrateWorkspaceCredentials(config, credentials) {
  const nextConfig = structuredClone(config ?? {});
  const nextCredentials = { ...credentials };
  let configChanged = false;
  let credentialsChanged = false;
  for (const { section, field, name } of WORKSPACE_CREDENTIALS) {
    const home = nextConfig?.[section];
    if (!home || typeof home !== "object" || Array.isArray(home)) continue;
    if (!Object.hasOwn(home, field)) continue;
    const value = home[field];
    if (typeof value !== "string") continue;
    const secret = value.trim();
    if (secret && nextCredentials[name] !== secret) {
      nextCredentials[name] = secret;
      credentialsChanged = true;
    }
    delete home[field];
    configChanged = true;
  }
  return { config: nextConfig, credentials: nextCredentials, configChanged, credentialsChanged };
}

export function workspaceCredentialEnv(credentials) {
  const env = {};
  for (const { name, env: envName } of WORKSPACE_CREDENTIALS) {
    const value = credentials?.[name];
    if (typeof value === "string" && value) env[envName] = value;
  }
  return env;
}
