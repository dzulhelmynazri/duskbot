// The key the server seals the Vault's saved card secrets with. It lives in credentials.bin, which the OS keychain
// protects (safeStorage), and reaches the server only over the utility process's private port: never argv, env, logs or
// the renderer. With no usable keychain the server is told so and keeps its own 0600 key file instead.
import { randomBytes } from "node:crypto";

export const SAVED_SECRETS_CREDENTIAL_KEY = "savedSecretsKey";
export const SAVED_SECRETS_KEY_MESSAGE = "madanibot:saved-secrets-key";
const HEX_KEY = /^[0-9a-f]{64}$/;

export function readSavedSecretsKey(credentials) {
  const key = credentials?.[SAVED_SECRETS_CREDENTIAL_KEY];
  return typeof key === "string" && HEX_KEY.test(key) ? key : null;
}

/** The kept key, or a new one written through the serialized credential writer; null when it cannot be kept. */
export async function ensureSavedSecretsKey(read, update) {
  const existing = readSavedSecretsKey(read());
  if (existing) return existing;
  const created = randomBytes(32).toString("hex");
  try {
    await update((credentials) => readSavedSecretsKey(credentials) ? credentials : { ...credentials, [SAVED_SECRETS_CREDENTIAL_KEY]: created });
  } catch {
    return null;
  }
  return readSavedSecretsKey(read());
}

export function savedSecretsKeyMessage(key) {
  return HEX_KEY.test(key ?? "") ? { type: SAVED_SECRETS_KEY_MESSAGE, key } : { type: SAVED_SECRETS_KEY_MESSAGE, unavailable: true };
}
