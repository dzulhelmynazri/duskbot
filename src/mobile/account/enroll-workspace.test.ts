import { beforeEach, expect, it, vi } from "vitest";
import { api } from "@/state/api";
import { webPlatform, type MobilePlatform } from "../platform";
import { enrollWorkspace } from "./enroll-workspace";

vi.mock("@/state/api", () => ({ api: vi.fn(async () => ({})) }));
let platform: MobilePlatform, prefs: Map<string, string>;
const grant = { enrollToken: "e".repeat(43), dashboardUrl: "https://accounts.example" };
beforeEach(() => {
  vi.clearAllMocks(); prefs = new Map();
  platform = { ...webPlatform(), prefs: { get: async key => prefs.get(key) ?? null, set: async (key, value) => { prefs.set(key, value); }, remove: async key => { prefs.delete(key); } } };
});
it("enrolls each connection once, and never moves it to the next account signed in on the phone", async () => {
  const getGrant = vi.fn(async () => grant);
  await Promise.all([enrollWorkspace(platform, "workspace", "person", getGrant), enrollWorkspace(platform, "workspace", "person", getGrant)]);
  await enrollWorkspace(platform, "workspace", "person", getGrant);
  expect(getGrant).toHaveBeenCalledOnce();
  expect(api).toHaveBeenCalledWith("/api/dashboard/link", { method: "POST", body: JSON.stringify({ url: grant.dashboardUrl, enrollToken: grant.enrollToken }) });
  expect(prefs.get("madani.account.enrolled.workspace")).toBe("person");
  await enrollWorkspace(platform, "other", "person", getGrant); await enrollWorkspace(platform, "workspace", "other-person", getGrant);
  expect(getGrant).toHaveBeenCalledTimes(2);
  expect(prefs.get("madani.account.enrolled.workspace")).toBe("person");
});
it("warns once without exposing secrets and leaves failed enrollment retryable", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.mocked(api).mockRejectedValueOnce(new Error(grant.enrollToken));
  await enrollWorkspace(platform, "workspace", "person", async () => grant);
  expect(warn).toHaveBeenCalledExactlyOnceWith("Account workspace enrollment failed"); expect(prefs.size).toBe(0);
  await enrollWorkspace(platform, "workspace", "person", async () => grant); expect(prefs.get("madani.account.enrolled.workspace")).toBe("person");
  warn.mockRestore();
});
