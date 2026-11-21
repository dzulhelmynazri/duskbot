import { describe, expect, it } from "vitest";
import { isAdminTestAccount, isDevBuild, isTestEvent, isTestInstall, testAccountIds, testBuyerIds, withoutAccounts, withoutBilling } from "./test-accounts.ts";

describe("admin test accounts", () => {
  it("flags harness, reserved-domain and review addresses, never real ones", () => {
    for (const email of ["qa-smoke@qa.madani.test", "billing-1@qa.madani.test", "qa@madani.bot", "qa-user@madani.bot", "QA-JP2@madani.bot", "madani-appconn-mwf7ync4@fldubai.com",
      "madani-e2e-abc@mail.tm", "someone@example.com", "a@mail.example.org", "x@foo.test", "y@thing.invalid"]) expect(isAdminTestAccount(email), email).toBe(true);
    expect(isAdminTestAccount("app-review@madani.bot", "app-review@madani.bot")).toBe(true);
    for (const email of ["meenasiddarth72@gmail.com", "siddz.dev@gmail.com", "app-review@madani.bot", "hello@madani.bot", "qaisar@gmail.com", "qa@madani.bot.com",
      "me@example.co", "me@testing.com", "me@notexample.com"]) expect(isAdminTestAccount(email), email).toBe(false);
  });
  it("drops the accounts' sign-ins, sessions and billing rows and the refunds of their payments, without touching the input", () => {
    const directory = { accounts: [{ id: "a", email: "real@gmail.com" }, { id: "t", email: "qa-1@qa.madani.test" }],
      identities: [{ accountId: "t", provider: "google" }], sessions: [{ accountId: "a" }, { accountId: "t" }] };
    const hidden = testAccountIds(directory.accounts);
    expect([...hidden]).toEqual(["t"]);
    expect(withoutAccounts(directory, hidden)).toEqual({ accounts: [directory.accounts[0]], identities: [], sessions: [{ accountId: "a" }] });
    const state = { invoices: [{ accountId: "a", providerPaymentId: "p1" }, { accountId: "t", providerPaymentId: "p2" }], refunds: [{ paymentId: "p1" }, { paymentId: "p2" }],
      licenses: [{ ownerAccountId: "t" }], webhookEvents: [{ id: "w" }], lastSync: 5 };
    const kept = withoutBilling(state, hidden);
    expect(kept).toEqual({ invoices: [state.invoices[0]], refunds: [{ paymentId: "p1" }], licenses: [], webhookEvents: [{ id: "w" }], lastSync: 5 });
    expect(state.invoices).toHaveLength(2);
  });
  it("flags harness installs, dev builds and deleted test buyers, never a real install or release", () => {
    for (const id of ["app:qatest_v8S", "qatest_abc", "app:smoke-1", "e2e_x"]) expect(isTestInstall(id), id).toBe(true);
    for (const id of ["ws_AgcVuaZCr", "0StaAMU1k1Ci4kLHSFEupg", "app:quest_1", undefined]) expect(isTestInstall(id), String(id)).toBe(false);
    for (const v of ["0.0.0", "0.0.0-e2e", "0.0.0-test"]) expect(isDevBuild(v), v).toBe(true);
    for (const v of ["0.2.11", "1.0.0", "0.0.1", null]) expect(isDevBuild(v), String(v)).toBe(false);
    expect(isTestEvent({ accountId: "t", ctx: {} }, new Set(["t"]))).toBe(true);
    expect(isTestEvent({ accountId: null, ctx: { install: "app:qatest_1" } }, new Set())).toBe(true);
    expect(isTestEvent({ accountId: null, ctx: { app: { version: "0.0.0-e2e" } } }, new Set())).toBe(true);
    expect(isTestEvent({ accountId: "a", ctx: { install: "x1", app: { version: "0.2.9" } } }, new Set(["t"]))).toBe(false);
    expect([...testBuyerIds([{ accountId: "gone", email: "rev-buyer@qa.madani.test" }, { accountId: "a", email: "real@gmail.com" }])]).toEqual(["gone"]);
  });
});
