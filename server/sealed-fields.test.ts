import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { sealValues } from "../src/lib/card-seal.ts";
import { createCardSealer, loadSealIdentity, SEAL_IDENTITY_FILE, sealIdentityOf } from "./card-seal.ts";
import { excludedWorkspaceAuthPath } from "./workspace-backup-policy.ts";
import type { RequestAuth } from "./request-auth.ts";
import { unsealConfig, unsealFields } from "./sealed-fields.ts";

const PASSWORD = "fake-sealed-pass-1";
const KEY = "sk-fake-sealed-key-1234";
const loopback = { kind: "loopback", scopes: ["admin", "client"] } as unknown as RequestAuth;
// a request through the link tunnel arrives forwarded, so it carries a paired session and never loopback trust
const forwarded = { kind: "session", via: "cookie", scopes: ["admin", "client"], session: { id: "s1" } } as unknown as RequestAuth;

describe("a value sealed for its purpose and target", () => {
  it("opens for the same purpose and target, once", async () => {
    const sealer = createCardSealer();
    const sealed = await sealValues({ password: PASSWORD }, sealer.publicKey(), "login.create", ["example.com", "alice"]);
    expect(JSON.stringify(sealed)).not.toContain(PASSWORD);
    const options = { auth: forwarded, sealer, purpose: "login.create" as const, target: ["example.com", "alice"], fields: ["password", "totp"] };
    expect(await unsealFields({ site: "example.com", sealed }, options)).toEqual({ ok: true, body: { site: "example.com", password: PASSWORD } });
    // a relay that kept a copy cannot send it again
    expect(await unsealFields({ site: "example.com", sealed }, options)).toMatchObject({ ok: false, status: 409 });
  });

  it("cannot be moved to another site, account, login, card or purpose", async () => {
    const sealer = createCardSealer();
    const key = sealer.publicKey();
    const sealed = await sealValues({ password: PASSWORD }, key, "login.create", ["example.com", "alice"]);
    for (const [purpose, target] of [["login.create", ["evil.example", "alice"]], ["login.create", ["example.com", "bob"]], ["login.update", ["example.com", "alice"]], ["login.card", ["example.com", "alice"]]] as const) {
      const answer = await unsealFields({ sealed }, { auth: forwarded, sealer, purpose, target, fields: ["password"] });
      expect(answer).toMatchObject({ ok: false, status: 400, body: { error: expect.stringMatching(/could not be verified/u) } });
    }
    const token = await sealValues({ token: "ops_fake" }, key, "onepassword.connect", []);
    expect(await unsealFields({ sealed: token }, { auth: forwarded, sealer, purpose: "onepassword.connect", target: [], fields: ["password"] })).toMatchObject({ ok: false, status: 400 });
  });

  it("refuses a plain secret from a forwarded request with seal_required and the key, and takes one from loopback", async () => {
    const sealer = createCardSealer();
    const options = { sealer, purpose: "login.update" as const, target: ["l1"], fields: ["password", "totp"] };
    const refused = await unsealFields({ password: PASSWORD }, { ...options, auth: forwarded });
    expect(refused).toMatchObject({ ok: false, status: 400, body: { code: "seal_required", sealKey: { keyId: sealer.publicKey().keyId, signature: expect.any(String) } } });
    expect(JSON.stringify(refused)).not.toContain(PASSWORD);
    expect(await unsealFields({ password: PASSWORD }, { ...options, auth: loopback })).toEqual({ ok: true, body: { password: PASSWORD } });
    // no secret at all, or a removal, needs no seal
    expect(await unsealFields({ bots: "all", totp: null }, { ...options, auth: forwarded })).toEqual({ ok: true, body: { bots: "all", totp: null } });
  });

  it("tells an app that sealed for a server since restarted the new key", async () => {
    const before = createCardSealer();
    const after = createCardSealer();
    const sealed = await sealValues({ token: "ops_fake" }, before.publicKey(), "onepassword.connect", []);
    expect(await unsealFields({ sealed }, { auth: forwarded, sealer: after, purpose: "onepassword.connect", target: [], fields: ["token"] }))
      .toMatchObject({ ok: false, status: 409, body: { sealKey: { keyId: after.publicKey().keyId } } });
  });
});

describe("API keys in a settings patch", () => {
  it("opens sealed keys back into their paths, a named key too", async () => {
    const sealer = createCardSealer();
    const paths = ["anthropic.key", "opencodeGo.providerKeys.GROQ_API_KEY"];
    const sealed = await sealValues({ "anthropic.key": KEY, "opencodeGo.providerKeys.GROQ_API_KEY": `${KEY}-groq` }, sealer.publicKey(), "config", paths);
    const answer = await unsealConfig({ anthropic: { everyClaudeBot: false }, sealed, sealedPaths: [...paths].reverse() }, { auth: forwarded, sealer });
    expect(answer).toEqual({ ok: true, body: { anthropic: { everyClaudeBot: false, key: KEY }, opencodeGo: { providerKeys: { GROQ_API_KEY: `${KEY}-groq` } } } });
  });

  it("cannot be moved to another setting", async () => {
    const sealer = createCardSealer();
    const sealed = await sealValues({ "openai.key": KEY }, sealer.publicKey(), "config", ["openai.key"]);
    expect(await unsealConfig({ sealed, sealedPaths: ["xai.key"] }, { auth: forwarded, sealer })).toMatchObject({ ok: false, status: 400 });
    expect(await unsealConfig({ sealed, sealedPaths: ["profile.name"] }, { auth: forwarded, sealer })).toMatchObject({ ok: false, status: 400 });
    expect(await unsealConfig({ sealed, sealedPaths: ["opencodeGo.providerKeys.__proto__"] }, { auth: forwarded, sealer })).toMatchObject({ ok: false, status: 400 });
  });

  it("refuses a plain key from a forwarded request, but not a removal or a setting that is no secret", async () => {
    const sealer = createCardSealer();
    for (const patch of [{ openai: { key: KEY } }, { opencodeGo: { providerKeys: { GROQ_API_KEY: KEY } } }, { live: { key: KEY } }]) {
      const refused = await unsealConfig(patch, { auth: forwarded, sealer });
      expect(refused).toMatchObject({ ok: false, body: { code: "seal_required" } });
      expect(JSON.stringify(refused)).not.toContain(KEY);
      expect(await unsealConfig(patch, { auth: loopback, sealer })).toEqual({ ok: true, body: patch });
    }
    expect(await unsealConfig({ openai: { key: "" }, openaiCompat: { url: "https://example.com" } }, { auth: forwarded, sealer })).toMatchObject({ ok: true });
  });
});

describe("the server's signed sealing key", () => {
  it("is signed by the identity it names, and every secret stays out of the logs", async () => {
    const lines: string[] = [];
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((level) => vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { lines.push(args.map(String).join(" ")); }));
    try {
      const sealer = createCardSealer();
      const key = sealer.publicKey();
      expect(key.identity).toBe(sealer.identity());
      expect(key.signature).toMatch(/^[A-Za-z0-9_-]{86}$/u);
      const sealed = await sealValues({ password: PASSWORD, totp: "JBSWY3DPEHPK3PXP" }, key, "login.card", ["b", "t", "m"]);
      await unsealFields({ sealed }, { auth: forwarded, sealer, purpose: "login.card", target: ["b", "t", "m"], fields: ["password", "totp"] });
      await unsealFields({ sealed }, { auth: forwarded, sealer, purpose: "login.card", target: ["b", "t", "x"], fields: ["password", "totp"] });
      await unsealFields({ password: PASSWORD }, { auth: forwarded, sealer, purpose: "login.card", target: ["b", "t", "m"], fields: ["password"] });
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
    expect(lines.join("\n")).not.toContain(PASSWORD);
  });
});

describe("the server's identity", () => {
  it("is made once, 0600, kept across starts, and never in a backup", () => {
    const dir = mkdtempSync(join(tmpdir(), "madani-seal-identity-"));
    try {
      const first = loadSealIdentity(dir);
      expect(statSync(join(dir, SEAL_IDENTITY_FILE)).mode & 0o777).toBe(0o600);
      expect(sealIdentityOf(loadSealIdentity(dir))).toBe(sealIdentityOf(first));
      // a new start makes a new sealing key, signed by the same identity
      expect(createCardSealer({ identity: loadSealIdentity(dir) }).identity()).toBe(sealIdentityOf(first));
      expect(excludedWorkspaceAuthPath(SEAL_IDENTITY_FILE)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
