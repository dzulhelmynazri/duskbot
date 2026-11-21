import { action, feature } from "./product-analytics";

export function track(event: string, props?: Record<string, unknown>): void {
  action(event, props);
  if (event === "team_imported") feature("team_imported");
}

const GATE_KEY = "madani-email-gate";
export function emailGateDone(): boolean {
  try {
    return Boolean(localStorage.getItem(GATE_KEY));
  } catch {
    return false;
  }
}

export function setEmailGateDone(status: "submitted" | "skipped"): void {
  try {
    localStorage.setItem(GATE_KEY, status);
  } catch {}
}
