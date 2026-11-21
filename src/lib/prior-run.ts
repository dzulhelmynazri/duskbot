// Read before main.tsx's first-paint writes: applySkin stamps madani-skin on every boot.
const PRIOR_RUN_KEYS = ["madani-skin", "madani-installed", "madani-email-gate", "madani-drafts", "madani-show-threads"];

export function hasPriorRun(store: Pick<Storage, "getItem"> | undefined): boolean {
  try {
    return PRIOR_RUN_KEYS.some((key) => store?.getItem(key) != null);
  } catch {
    return false;
  }
}
