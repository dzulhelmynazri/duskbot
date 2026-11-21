import { afterEach, describe, expect, it, vi } from "vitest";

import { levelHas, SERVER_API_LEVEL, SERVER_FEATURES, serverApiLevel } from "../../shared/server-api";
import { ApiError } from "@/state/api";
import { currentServerCompat, isMissingRoute, readServerCompat, resetServerCompat, serverBehind, serverHas, whenServerHas } from "./server-compat";
import { serverBehindHint } from "./server-behind";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const server = (descriptors: Record<string, unknown>) => vi.fn(async (input: string | URL | Request) => { const path = String(input); return path in descriptors ? json(descriptors[path]) : json({ error: `no route: GET ${path}` }, 404); });
const noRoute = (path: string) => new ApiError(`no route: GET ${path}`, 404, { error: `no route: GET ${path}` });

afterEach(() => resetServerCompat());

describe("the API level a server says", () => {
  it("reads capabilities.api and nothing else", () => {
    expect(serverApiLevel({ capabilities: { api: 3 } })).toBe(3);
    for (const said of [null, {}, { capabilities: {} }, { capabilities: { api: "2" } }, { capabilities: { api: 1.5 } }, { capabilities: { api: -1 } }]) {
      expect(serverApiLevel(said)).toBeNull();
    }
  });

  it("every feature needs a level this app's own server speaks", () => {
    for (const level of Object.values(SERVER_FEATURES)) expect(level).toBeLessThanOrEqual(SERVER_API_LEVEL);
    expect(levelHas(SERVER_API_LEVEL, "allowance")).toBe(true);
    expect(levelHas(0, "allowance")).toBe(false);
    expect(levelHas(null, "allowance")).toBeNull();
  });
});

describe("a page on an older server", () => {
  it("a server at this level has everything and is not behind", async () => {
    const fetch = server({ "/.well-known/madanibot/environment": { version: "9.9.9", capabilities: { api: SERVER_API_LEVEL } } });
    expect(await serverHas("connectorDirectory", fetch)).toBe(true);
    expect(serverBehind(currentServerCompat())).toBe(false);
  });

  it("a server that says a lower level hides the newer parts without asking for them", async () => {
    const fetch = server({ "/.well-known/madanibot/environment": { version: "1.0.0", capabilities: { api: 0 } } });
    await readServerCompat(fetch);
    const read = vi.fn(async () => ({ apps: [] }));
    expect(await whenServerHas("connectorDirectory", read)).toBeNull();
    expect(read).not.toHaveBeenCalled();
    expect(serverBehind(currentServerCompat())).toBe(true);
  });

  it("a server from before levels (and before the rename) is asked, and a missing route hides that part only", async () => {
    const fetch = server({ "/.well-known/openmausbot/environment": { version: "0.1.141", capabilities: { remoteSessions: true } } });
    expect(await readServerCompat(fetch)).toEqual({ level: null, version: "0.1.141", missing: [] });
    expect(serverBehind(currentServerCompat())).toBe(false);

    const allowance = vi.fn(async () => { throw noRoute("/api/usage/allowance"); });
    expect(await whenServerHas("allowance", allowance)).toBeNull();
    expect(await whenServerHas("allowance", allowance)).toBeNull();
    expect(allowance).toHaveBeenCalledTimes(1);
    expect(await whenServerHas("updateDigest", async () => ({ digest: null }))).toEqual({ digest: null });
    expect(currentServerCompat().missing).toEqual(["allowance"]);
    expect(serverBehind(currentServerCompat())).toBe(true);
  });

  it("a refusal or an outage is never taken for a missing part", async () => {
    await readServerCompat(server({}));
    expect(isMissingRoute(new ApiError("bot not found", 404))).toBe(false);
    expect(isMissingRoute(new ApiError("no route: GET /x", 503))).toBe(false);
    await expect(whenServerHas("allowance", async () => { throw new ApiError("forbidden", 403); })).rejects.toThrow("forbidden");
    expect(currentServerCompat().missing).toEqual([]);
  });

  it("an unreachable descriptor hides nothing up front", async () => {
    const fetch = vi.fn(async () => { throw new TypeError("offline"); });
    expect(await readServerCompat(fetch as typeof globalThis.fetch)).toEqual({ level: null, version: null, missing: [] });
    expect(await serverHas("allowance")).toBe(true);
  });
});

describe("the update hint", () => {
  it("offers the server's own update command, and says nothing where madani or the app updates it", () => {
    const copy = vi.fn();
    const hint = serverBehindHint({ current: "0.1.141", install: "docker", available: true, command: "docker compose pull && docker compose up -d" }, copy);
    hint!.action!.onClick();
    expect(copy).toHaveBeenCalledWith("docker compose pull && docker compose up -d");
    expect(serverBehindHint({ current: "1", install: "unknown", available: false }, copy)?.action).toBeUndefined();
    expect(serverBehindHint(null, copy)?.text).toBeTruthy();
    expect(serverBehindHint({ current: "1", install: "managed", available: false }, copy)).toBeNull();
    expect(serverBehindHint({ current: "1", install: "desktop", available: false }, copy)).toBeNull();
  });
});
