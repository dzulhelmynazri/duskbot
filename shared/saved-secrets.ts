import { SEAL_LABELS } from "../electron/legacy-names.mjs";
/** A secret saved to the Vault from a bot's card, as Settings shows it: never its value. */
export interface SavedSecretSummary {
  id: string;
  label: string;
  /** The bots that may use it. */
  bots: string[];
  createdAt: number;
  updatedAt: number;
  lastUsedAt?: number;
  /** A use failed in a way that may mean it is wrong: Settings shows it to check. */
  needsCheck?: number;
}

/** A card secret sealed in the person's app for the server that keeps it (HPKE, P-256, AES-256-GCM): the relay between
 * them only ever carries this. */
export interface SealedCardSecret {
  keyId: string;
  encapsulatedKey: string;
  ciphertext: string;
}

/** The server's key a card, a login, a 1Password token or an API key seals for, valid while that server process runs.
 * `identity` is the server's long-term P-256 signing key (`x.y`, base64url), which the desktop app pins for a linked
 * server; `signature` is its ECDSA P-256 SHA-256 signature (IEEE P1363, base64url) over sealKeySigningInput. */
export interface CardSealKey {
  version: 1;
  keyId: string;
  x: string;
  y: string;
  identity?: string;
  signature?: string;
}

export const CARD_SECRET_INFO = "madani bot card secret v1";

/** What the seal is bound to, so a relay cannot move it to another bot, conversation, card or choice. */
export function cardSecretAAD(context: { keyId: string; botId: string; threadId: string; messageId: string; requestKey: string; remember: boolean }): Uint8Array {
  return new TextEncoder().encode([
    SEAL_LABELS.cardSecret, context.keyId, context.botId, context.threadId, context.messageId, context.requestKey, context.remember ? "save" : "once",
  ].join("\n"));
}

/** What the server's identity key signs, so a relay cannot hand the app a sealing key of its own. */
export function sealKeySigningInput(key: Pick<CardSealKey, "keyId" | "x" | "y">, identity: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode([SEAL_LABELS.sealKey, identity, key.keyId, key.x, key.y].join("\n"));
}

export const SEALED_VALUE_INFO = "madani bot sealed value v1";

/** Where a sealed login, token or key may be opened: a relay cannot move it to another purpose or target. */
export type SealPurpose = "login.create" | "login.update" | "login.card" | "onepassword.connect" | "config" | "model-provider" | "vault.secret" | "card.secret";

/** A login saved from Settings is bound to its site and username, a change to the login's id, a sign-in card's to
 * that card; a config seal to the sorted paths it carries. */
export function sealedValueAAD(keyId: string, purpose: SealPurpose, target: readonly string[]): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(JSON.stringify([SEAL_LABELS.sealedValue, keyId, purpose, target]));
}

/** The settings paths that hold a secret: from any client but this computer's own app they travel only sealed.
 * `opencodeGo.providerKeys` holds a key under each name. */
export const CONFIG_SECRET_PATHS = [
  "xai.key", "mistral.key", "cerebras.key", "treg.key", "groq.key", "greenference.key", "meta.key", "deepseek.key",
  "anthropic.key", "openaiCompat.key", "openai.key", "openrouter.key", "composio.apiKey", "opencodeGo.apiKey",
  "tts.key", "tts.fishKey", "tts.geminiKey", "decider.key", "decider.openrouterKey", "decider.workersAiToken",
  "decider.gatewayKey", "imageGen.key", "imageGen.customApiKey", "live.key",
] as const;
export const CONFIG_SECRET_MAPS = ["opencodeGo.providerKeys"] as const;

/** Every non-empty secret in a settings patch, by dotted path; "" (remove the key) is not a secret. */
export function configSecrets(patch: unknown): Map<string, string> {
  const found = new Map<string, string>();
  const at = (path: string): unknown => path.split(".").reduce<unknown>((node, part) =>
    node && typeof node === "object" && !Array.isArray(node) ? (node as Record<string, unknown>)[part] : undefined, patch);
  for (const path of CONFIG_SECRET_PATHS) {
    const value = at(path);
    if (typeof value === "string" && value) found.set(path, value);
  }
  for (const path of CONFIG_SECRET_MAPS) {
    const map = at(path);
    if (!map || typeof map !== "object" || Array.isArray(map)) continue;
    for (const [name, value] of Object.entries(map)) if (typeof value === "string" && value) found.set(`${path}.${name}`, value);
  }
  return found;
}
