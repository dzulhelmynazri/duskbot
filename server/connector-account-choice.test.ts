import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { accountsForBot, createAccountChoiceRoutes, forgetAccount, readAccountChoices, removeAccountAndForget, setAccountChoice } from "./connector-account-choice.ts";
import { parseConnectorAccountsEnv, withChosenAccounts } from "./connector-account-pick.ts";
import { PASS } from "./routes/table.ts";

const dirs: string[] = [];
const fresh = () => { const dir = mkdtempSync(join(tmpdir(), "madani-accounts-")); dirs.push(dir); return dir; };
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("account choices", () => {
  it("a bot's own pick wins over the app's default", () => {
    const dir = fresh();
    setAccountChoice({ slug: "gmail", accountId: "ca_work" }, dir);
    setAccountChoice({ slug: "gmail", accountId: "ca_home", botId: "nova" }, dir);
    setAccountChoice({ slug: "github", accountId: "ca_gh" }, dir);
    const choices = readAccountChoices(dir);
    expect(accountsForBot("nova", choices)).toEqual({ gmail: "ca_home", github: "ca_gh" });
    expect(accountsForBot("quill", choices)).toEqual({ gmail: "ca_work", github: "ca_gh" });
  });

  it("clearing a pick falls back to the default, and a removed account is nobody's any more", () => {
    const dir = fresh();
    setAccountChoice({ slug: "gmail", accountId: "ca_work" }, dir);
    setAccountChoice({ slug: "gmail", accountId: "ca_home", botId: "nova" }, dir);
    setAccountChoice({ slug: "gmail", accountId: null, botId: "nova" }, dir);
    expect(readAccountChoices(dir).bots).toEqual({});
    setAccountChoice({ slug: "gmail", accountId: "ca_home", botId: "nova" }, dir);
    forgetAccount("gmail", "ca_home", dir);
    expect(accountsForBot("nova", readAccountChoices(dir))).toEqual({ gmail: "ca_work" });
  });

  it("answers the routes, refusing a bad body", async () => {
    const dir = fresh();
    const route = createAccountChoiceRoutes(dir);
    const answers: Array<[number, unknown]> = [];
    const ctx = (method: string, path: string, body?: unknown) => ({
      method, path, res: {} as never, req: {} as never, url: new URL(`http://x${path}`), auth: {} as never,
      json: ((_res: unknown, status: number, value: unknown) => { answers.push([status, value]); }) as never,
      readBody: (async () => body) as never,
    });
    await route(ctx("PUT", "/api/connectors/gmail/account-choice", { accountId: "ca_work" }));
    await route(ctx("PUT", "/api/connectors/gmail/account-choice", { accountId: "bad id!" }));
    await route(ctx("GET", "/api/connectors/account-choices"));
    expect(answers.map(([status]) => status)).toEqual([200, 400, 200]);
    expect(answers[2]![1]).toEqual({ defaults: { gmail: "ca_work" }, bots: {} });
    expect(await route(ctx("DELETE", "/api/connectors/gmail/accounts/ca_work"))).toBe(PASS);
    expect(readAccountChoices(dir).defaults, "the removal has not happened yet").toEqual({ gmail: "ca_work" });
  });

  it("keeps every pick of an account whose removal failed, so no bot moves to another account", async () => {
    const dir = fresh();
    setAccountChoice({ slug: "gmail", accountId: "ca_home" }, dir);
    setAccountChoice({ slug: "gmail", accountId: "ca_work", botId: "nova" }, dir);
    await expect(removeAccountAndForget("gmail", "ca_work", async () => { throw new Error("Composio refused"); }, dir)).rejects.toThrow("Composio refused");
    expect(accountsForBot("nova", readAccountChoices(dir))).toEqual({ gmail: "ca_work" });
  });

  it("forgets an account's picks once it is removed, matching the app without case", async () => {
    const dir = fresh();
    setAccountChoice({ slug: "gmail", accountId: "ca_work", botId: "nova" }, dir);
    expect(await removeAccountAndForget("Gmail", "ca_work", async () => ({ removed: 1 }), dir)).toEqual({ removed: 1 });
    expect(readAccountChoices(dir).bots).toEqual({});
  });

  it("keeps a choice for an app whose slug starts with an underscore, beside the others", async () => {
    const dir = fresh();
    const statuses: number[] = [];
    const put = (path: string, body: unknown) => createAccountChoiceRoutes(dir)({
      method: "PUT", path, res: {} as never, req: {} as never, url: new URL(`http://x${path}`), auth: {} as never,
      json: ((_res: unknown, status: number) => { statuses.push(status); }) as never,
      readBody: (async () => body) as never,
    });
    await put("/api/connectors/gmail/account-choice", { accountId: "ca_work" });
    await put("/api/connectors/_1password/account-choice", { accountId: "ca_vault" });
    await put("/api/connectors/_1password/account-choice", { accountId: "ca_team", botId: "nova" });
    expect(statuses).toEqual([200, 200, 200]);
    const choices = readAccountChoices(dir);
    expect(accountsForBot("nova", choices)).toEqual({ gmail: "ca_work", _1password: "ca_team" });
    expect(accountsForBot("quill", choices)).toEqual({ gmail: "ca_work", _1password: "ca_vault" });
  });
});

describe("withChosenAccounts", () => {
  const call = { tools: [{ tool_slug: "GMAIL_SEND_EMAIL", arguments: {} }, { tool_slug: "GOOGLECALENDAR_LIST", arguments: {} }, { tool_slug: "GMAIL_FETCH", account: "personal" }] };

  it("names the bot's account on every multi-execute call that names none", () => {
    expect(withChosenAccounts("COMPOSIO_MULTI_EXECUTE_TOOL", call, { gmail: "ca_work" })).toEqual({
      tools: [{ tool_slug: "GMAIL_SEND_EMAIL", arguments: {}, account: "ca_work" }, call.tools[1], call.tools[2]],
    });
  });

  it("leaves other tools and empty picks alone", () => {
    expect(withChosenAccounts("COMPOSIO_SEARCH_TOOLS", call, { gmail: "ca_work" })).toBe(call);
    expect(withChosenAccounts("COMPOSIO_MULTI_EXECUTE_TOOL", call, {})).toBe(call);
  });

  it("names the account of an app whose slug starts with an underscore", () => {
    const chosen = parseConnectorAccountsEnv('{"gmail":"ca_work","_1password":"ca_vault"}');
    expect(chosen).toEqual({ gmail: "ca_work", _1password: "ca_vault" });
    expect(withChosenAccounts("COMPOSIO_MULTI_EXECUTE_TOOL", { tools: [{ tool_slug: "_1PASSWORD_GET_ITEM", arguments: {} }] }, chosen))
      .toEqual({ tools: [{ tool_slug: "_1PASSWORD_GET_ITEM", arguments: {}, account: "ca_vault" }] });
  });

  it("reads only a well-formed env", () => {
    expect(parseConnectorAccountsEnv('{"gmail":"ca_work"}')).toEqual({ gmail: "ca_work" });
    expect(parseConnectorAccountsEnv("{nope")).toEqual({});
    expect(parseConnectorAccountsEnv('{"gmail":"bad id"}')).toEqual({});
  });
});
