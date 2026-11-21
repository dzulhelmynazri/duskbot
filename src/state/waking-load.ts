import { cloudAsleep, cloudWaking } from "../lib/cloud-power";
import { ApiError } from "./api";

/** How long the first snapshot waits on a waking madani cloud before it says the load failed. */
export const WAKING_LOAD_MS = 120_000;

/** The first snapshot failed because the person's madani cloud sleeps or is still starting, not because it broke. */
export function cloudWakingLoad(error: unknown): boolean {
  if (cloudAsleep() || cloudWaking()) return true;
  if (!(error instanceof ApiError)) return false;
  const code = (error.body as { error?: unknown } | undefined)?.error;
  return code === "waking" || code === "asleep" || error.status === 502 || error.status === 504;
}
