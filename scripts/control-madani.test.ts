// What crosses from the launching shell into a fixture server: only what a
// test scripted on purpose. A real OpenAI key must never reach a fixture that
// could send it to OpenAI.
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";

import { verificationServerArgs, verificationServerEnvironment } from "./control-madani.ts";

const childEnv = (parentEnv: NodeJS.ProcessEnv) => verificationServerEnvironment(parentEnv, join(tmpdir(), "madani-fixture-env"), 9100);

it("keeps the home and every login folder beside the data folder only for its explicit switch, so a workspace backup can run", () => {
  const dir = join(tmpdir(), "madani-fixture-env");
  const outside = childEnv({ MADANI_VERIFY_HOME_OUTSIDE: "1" });
  for (const key of ["HOME", "USERPROFILE", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "APPDATA", "LOCALAPPDATA", "HERMES_HOME"]) expect(outside[key]!.startsWith(`${dir}-home`), key).toBe(true);
  expect(outside.MADANI_DATA_DIR).toBe(dir);
  expect(childEnv({}).HOME).toBe(dir);
});

it("loads the isolated VPS idle clock only for its explicit fixture switch", () => {
  const enabled = childEnv({ MADANI_TEST_VPS_IDLE_CLOCK: "1" });
  expect(enabled.MADANI_TEST_VPS_IDLE_CLOCK).toBe("1");
  expect(verificationServerArgs(enabled).some((arg) => arg.endsWith("vps-idle-clock-hooks.mjs"))).toBe(true);
  for (const value of [undefined, "true", "0"]) {
    const disabled = childEnv({ MADANI_TEST_VPS_IDLE_CLOCK: value });
    expect(disabled).not.toHaveProperty("MADANI_TEST_VPS_IDLE_CLOCK");
    expect(verificationServerArgs(disabled).some((arg) => arg.endsWith("vps-idle-clock-hooks.mjs"))).toBe(false);
  }
});

it("loads the no-container native browser guard only for its explicit fixture switch", () => {
  const enabled = childEnv({ MADANI_TEST_LOCAL_BROWSER_GUARD: "1" });
  expect(enabled.MADANI_TEST_LOCAL_BROWSER_GUARD).toBe("1");
  expect(verificationServerArgs(enabled).some((arg) => arg.endsWith("local-browser-guard.mjs"))).toBe(true);
  for (const value of [undefined, "true", "0"]) {
    const disabled = childEnv({ MADANI_TEST_LOCAL_BROWSER_GUARD: value });
    expect(disabled).not.toHaveProperty("MADANI_TEST_LOCAL_BROWSER_GUARD");
    expect(verificationServerArgs(disabled).some((arg) => arg.endsWith("local-browser-guard.mjs"))).toBe(false);
  }
});

describe("a fixture driven from a real browser", () => {
  it("trusts this machine's browsers as `pnpm dev` does, unless the caller tests the sign-in", () => {
    expect(childEnv({}).MADANI_DEV_TRUST_LOCAL_BROWSER).toBe("1");
    expect(childEnv({ MADANI_DEV_TRUST_LOCAL_BROWSER: "0" })).not.toHaveProperty("MADANI_DEV_TRUST_LOCAL_BROWSER");
  });
});

describe("the fixture's fake engine knobs", () => {
  it("lets the Claude fake's knobs and the Codex fake's background-call knobs cross, and nothing else", () => {
    const env = childEnv({
      FAKE_CLAUDE_TEXT_ROUTES: "/tmp/routes.json", FAKE_CODEX_TEXT_ROUTES: "/tmp/codex-routes.json", FAKE_CODEX_TEXT_LOG: "/tmp/codex.jsonl",
      FAKE_CODEX_MODE: "approval", FAKE_CODEX_DUMP: "/tmp/codex-dump.json", SOME_SECRET: "x",
    });
    expect(env).toMatchObject({ FAKE_CLAUDE_TEXT_ROUTES: "/tmp/routes.json", FAKE_CODEX_TEXT_ROUTES: "/tmp/codex-routes.json", FAKE_CODEX_TEXT_LOG: "/tmp/codex.jsonl" });
    for (const key of ["FAKE_CODEX_MODE", "FAKE_CODEX_DUMP", "SOME_SECRET"]) expect(env, key).not.toHaveProperty(key);
  });
});

describe("the fixture's Live call environment", () => {
  it("passes a loopback fake GPT-Live and its key through", () => {
    expect(childEnv({ MADANI_OPENAI_LIVE_URL: " http://127.0.0.1:4100 ", MADANI_OPENAI_LIVE_KEY: "sk-fake" }))
      .toMatchObject({ MADANI_OPENAI_LIVE_URL: "http://127.0.0.1:4100", MADANI_OPENAI_LIVE_KEY: "sk-fake" });
    const noKey = childEnv({ MADANI_OPENAI_LIVE_URL: "http://127.0.0.1:4100" });
    expect(noKey.MADANI_OPENAI_LIVE_URL).toBe("http://127.0.0.1:4100");
    expect(noKey).not.toHaveProperty("MADANI_OPENAI_LIVE_KEY");
  });

  it("drops any other Live URL, and never lets the key cross without the fake", () => {
    for (const url of ["https://api.openai.com", "http://localhost:4100", "http://127.0.0.1:4100/v1", "http://192.0.2.1:4100", "http://127.0.0.1", ""]) {
      const env = childEnv({ MADANI_OPENAI_LIVE_URL: url, MADANI_OPENAI_LIVE_KEY: "sk-real" });
      expect(env, url).not.toHaveProperty("MADANI_OPENAI_LIVE_URL");
      expect(env, url).not.toHaveProperty("MADANI_OPENAI_LIVE_KEY");
    }
    expect(childEnv({ MADANI_OPENAI_LIVE_KEY: "sk-real" })).not.toHaveProperty("MADANI_OPENAI_LIVE_KEY");
  });
});

describe("the fixture's X research relay", () => {
  it("passes a loopback relay stub and its token through, the token only with the stub", () => {
    expect(childEnv({ MADANI_CLOUD_X_URL: " http://127.0.0.1:4200/api/cloud/services/x ", MADANI_CLOUD_X_TOKEN: "madani_x_fixture" }))
      .toMatchObject({ MADANI_CLOUD_X_URL: "http://127.0.0.1:4200/api/cloud/services/x", MADANI_CLOUD_X_TOKEN: "madani_x_fixture" });
    for (const url of ["https://madani.bot/api/cloud/services/x", "http://localhost:4200/api/cloud/services/x", "http://192.0.2.1:4200", "http://127.0.0.1:4200/../x?y", ""]) {
      const env = childEnv({ MADANI_CLOUD_X_URL: url, MADANI_CLOUD_X_TOKEN: "madani_x_real" });
      expect(env, url).not.toHaveProperty("MADANI_CLOUD_X_URL");
      expect(env, url).not.toHaveProperty("MADANI_CLOUD_X_TOKEN");
    }
    expect(childEnv({ MADANI_TREG_URL: " http://127.0.0.1:4300 " })).toMatchObject({ MADANI_TREG_URL: "http://127.0.0.1:4300" });
    for (const url of ["https://treg.to", "http://localhost:4300", "http://127.0.0.1:4300/x", ""]) expect(childEnv({ MADANI_TREG_URL: url }), url).not.toHaveProperty("MADANI_TREG_URL");
  });
});

describe("the fixture's @devs reports", () => {
  it("go to a loopback fake endpoint, else to a closed port: never to the Madani team", () => {
    const closed = "http://127.0.0.1:9/api/bug-reports";
    expect(childEnv({ MADANI_BUG_REPORT_URL: " http://127.0.0.1:4400/api/bug-reports " }).MADANI_BUG_REPORT_URL).toBe("http://127.0.0.1:4400/api/bug-reports");
    for (const url of ["https://madani.bot/api/bug-reports", "http://localhost:4400/api/bug-reports", "http://192.0.2.1:4400/x", "http://127.0.0.1:4400/../x?y", ""]) {
      expect(childEnv({ MADANI_BUG_REPORT_URL: url }).MADANI_BUG_REPORT_URL, url).toBe(closed);
    }
    expect(childEnv({}).MADANI_BUG_REPORT_URL).toBe(closed);
  });
});
