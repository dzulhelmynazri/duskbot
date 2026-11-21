/** Every body a bot can wear: the twenty pixel bodies and the Halloween costumes, which draw as pixel bodies. Ids saved by older versions still read. */

import { z } from "zod";

import {
  DEFAULT_BOT_BODY, MADANI_BODY_IDS, HALLOWEEN_BODY_IDS, LEGACY_BODY_IDS, madaniBody, migrateBodyId, type MadaniBodyId, type HalloweenBodyId, type LegacyBodyId,
} from "./body-migration.ts";
import type { MausColor } from "./wire.ts";

export { DEFAULT_BOT_BODY };

export type BotBodyId = MadaniBodyId | HalloweenBodyId;

/** A body id as stored or synced: one this version saves, or an older one still to be read through the migration. */
export type StoredBodyId = BotBodyId | LegacyBodyId;

/** The bodies a picker offers and a new bot saves. */
export const BOT_BODY_IDS = [...MADANI_BODY_IDS, ...HALLOWEEN_BODY_IDS] as [BotBodyId, ...BotBodyId[]];

export function isHalloweenBody(value: unknown): value is HalloweenBodyId {
  return (HALLOWEEN_BODY_IDS as readonly unknown[]).includes(value);
}

/** An id this version saves, or an older one moved onto the body it draws as now. */
function readBody(value: unknown): BotBodyId | null {
  return isHalloweenBody(value) ? value : migrateBodyId(value);
}

/** Accepts every id ever saved and gives back the one to save now. */
export const botBodySchema = z.enum([...BOT_BODY_IDS, ...LEGACY_BODY_IDS] as [string, ...string[]]).transform((id) => readBody(id)!);

/** Runtime-safe read of an untrusted persisted or streamed body id. */
export function botBodyId(value: unknown): BotBodyId {
  return readBody(value) ?? DEFAULT_BOT_BODY;
}

/** The one of our bodies a stored id draws as; Halloween costumes are drawn on their own. */
export const bodyShapeFor = madaniBody;

/** Whether a bot wearing `current` draws as `id`, so a picker marks an older id as the body it now looks like. */
export function wearsBody(current: unknown, id: BotBodyId): boolean {
  if (isHalloweenBody(id)) return current === id;
  return madaniBody(current) === madaniBody(id);
}

/** The costume each bot colour wears (ten costumes, so brown keeps its own body) when "Dress my bots up" is on with the Halloween skin. */
export const COSTUME_FOR_COLOR: Record<Exclude<MausColor, "silver" | "chrome" | "brown">, HalloweenBodyId> = {
  orange: "pumpkin",
  purple: "ghost",
  teal: "witch",
  red: "bat",
  blue: "cat",
  cyan: "skull",
  green: "monster",
  yellow: "mummy",
  coral: "vampire",
  pink: "spider",
};
