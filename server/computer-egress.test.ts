import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { BOT_DESKTOP_BRIDGE } from "../shared/bot-desktop.ts";
import { EGRESS_PORTS as MAC_PORTS } from "../electron/vps-link-egress.mjs";
import { egressRouteState } from "../shared/computer-egress.ts";
import { DIRECT_ASSET_SITES, EGRESS_POLICY_PATH, EGRESS_PORTS, FAST_DIAL_MS, HOME_ONLY_SITES, SLOW_DIAL_MS, createComputerEgress, egressPac, egressPolicy, parseEgressReport, type EgressAgentReport } from "./computer-egress.ts";
import { createComputerEgressRoutes } from "./routes/computer-egress.ts";
import { PASS, type RouteContext } from "./routes/table.ts";

const proxy = { host: "172.18.0.1", port: 3129 };
const report = (over: Partial<EgressAgentReport> = {}): EgressAgentReport => ({ online: true, proxy, active: 0, relayed: 0, refused: 0, fallbacks: 0, ...over });

function pacFor(generation = 1, only: readonly string[] | null = null) {
  const sandbox: Record<string, unknown> = {
    isPlainHostName: (host: string) => !host.includes("."),
    dnsDomainIs: (host: string, domain: string) => host.endsWith(domain),
    isInNet: (host: string, pattern: string, mask: string) => {
      const n = (ip: string) => ip.split(".").reduce((acc, part) => (acc << 8) + Number(part), 0) >>> 0;
      return ((n(host) & n(mask)) >>> 0) === ((n(pattern) & n(mask)) >>> 0);
    },
  };
  runInNewContext(egressPac(proxy, generation, only), sandbox);
  return (url: string) => (sandbox.FindProxyForURL as (url: string, host: string) => string)(url, new URL(url).hostname.replace(/^\[|\]$/g, ""));
}

function fakeDocker(ids: string[], answer: (args: string[]) => string = (args) => args[7] ?? "off") {
  const calls: string[][] = [];
  const docker = async (args: string[]) => {
    calls.push(args);
    if (args[0] === "ps") return { stdout: ids.join("\n") };
    return { stdout: answer(args) };
  };
  return { calls, docker };
}

describe("the PAC script", () => {
  it("on a slow path sends only the sites that block servers to the person's computer", () => {
    // live 2026-11-09: over the relay every page went out from the server and Instagram answered HTTP 429
    const find = pacFor(1, HOME_ONLY_SITES);
    expect(find("https://www.instagram.com/accounts/login/")).toBe("SOCKS5 172.18.0.1:3129; DIRECT");
    expect(find("https://x.com/home")).toBe("SOCKS5 172.18.0.1:3129; DIRECT");
    expect(find("https://example.com/")).toBe("DIRECT");
    expect(find("https://notinstagram.com/")).toBe("DIRECT");
  });

  it("loads those sites' css, scripts and images direct on either path, so a path that drops mid-load cannot strip a page", () => {
    // live 2026-11-09: the path to the person's computer closed while instagram.com/zuck loaded, its connections to
    // static.cdninstagram.com and scontent.cdninstagram.com went with it, and the page stayed unstyled html
    for (const find of [pacFor(1), pacFor(1, HOME_ONLY_SITES)]) {
      expect(find("https://www.instagram.com/zuck/")).toBe("SOCKS5 172.18.0.1:3129; DIRECT");
      expect(find("https://www.facebook.com/ig_xsite_user_info/")).toBe("SOCKS5 172.18.0.1:3129; DIRECT");
      for (const url of ["https://static.cdninstagram.com/rsrc.php/v5/y2/l/0,cross/a.css", "https://scontent.cdninstagram.com/v/t51/a.jpg", "https://static.xx.fbcdn.net/rsrc.php/a.js",
        "https://abs.twimg.com/responsive-web/main.js", "https://pbs.twimg.com/media/a.jpg", "https://static.licdn.com/aero-v1/a.css", "https://www.redditstatic.com/shreddit/a.js", "https://i.redd.it/a.png"]) {
        expect(find(url), url).toBe("DIRECT");
      }
    }
    expect(pacFor(1)("https://notcdninstagram.com/")).toBe("SOCKS5 172.18.0.1:3129; DIRECT");
    expect(DIRECT_ASSET_SITES.some((site: string) => HOME_ONLY_SITES.some((home: string) => site === home || site.endsWith(`.${home}`)))).toBe(false);
  });

  it("sends web ports on public names to the person's computer, with a direct fallback", () => {
    const find = pacFor();
    expect(find("https://www.instagram.com/")).toBe("SOCKS5 172.18.0.1:3129; DIRECT");
    expect(find("http://example.com/")).toBe("SOCKS5 172.18.0.1:3129; DIRECT");
    expect(find("wss://chat.example.com/")).toBe("SOCKS5 172.18.0.1:3129; DIRECT");
    expect(find("https://93.184.216.34/")).toBe("SOCKS5 172.18.0.1:3129; DIRECT");
  });
  it("keeps everything else direct, so the computer never refuses it and the proxy is not skipped for minutes", () => {
    const find = pacFor();
    for (const url of ["https://example.com:8443/", "http://example.com:8080/", "https://intranet/", "http://printer.local/", "http://localhost:3000/",
      "http://10.0.0.5/", "http://192.168.1.1/", "http://172.18.0.1/", "http://169.254.169.254/", "http://100.64.1.1/", "http://127.0.0.1/", "http://[::1]/"]) {
      expect(find(url), url).toBe("DIRECT");
    }
  });
  it("changes with the generation, which makes Chromium try the proxy again", () => {
    expect(egressPolicy(proxy, 1)).not.toBe(egressPolicy(proxy, 2));
    const policy = JSON.parse(egressPolicy(proxy, 1));
    expect(policy.ProxySettings.ProxyMode).toBe("pac_script");
    expect(policy.ProxySettings.ProxyPacUrl).toMatch(/^data:application\/x-ns-proxy-autoconfig;base64,/);
    expect(policy.WebRtcIPHandlingPolicy).toBe("disable_non_proxied_udp");
  });
});

describe("the agent's report", () => {
  it("is validated", () => {
    expect(parseEgressReport(report())).toEqual(report());
    expect(parseEgressReport({ ...report(), proxy: { host: "example.com", port: 1 } })?.proxy).toBeNull();
    expect(parseEgressReport({ ...report(), active: -4 })?.active).toBe(0);
    expect(parseEgressReport({ proxy })).toBeNull();
    expect(parseEgressReport(null)).toBeNull();
  });
});

describe("routing the bot computers", () => {
  it("writes the policy into running boxes while the computer is online and removes it when it goes offline", async () => {
    let enabled = true;
    const fake = fakeDocker(["aaaaaaaaaaaa", "bbbbbbbbbbbb"]);
    const egress = createComputerEgress({ enabled: () => enabled, docker: () => fake.docker });
    egress.report(report());
    await egress.changed();
    const writes = fake.calls.filter((args) => args[0] === "exec");
    expect(writes).toHaveLength(2);
    expect(writes[0]!.slice(0, 5)).toEqual(["exec", "-u", "0", "aaaaaaaaaaaa", "python3"]);
    expect(writes[0]![6]).toContain(EGRESS_POLICY_PATH);
    expect(writes[0]!.slice(7, 10)).toEqual(["on", "172.18.0.1", "3129"]);
    expect(egress.status()).toMatchObject({ available: true, enabled: true, route: "computer" });

    fake.calls.length = 0;
    egress.report(report());
    await egress.changed();
    expect(fake.calls.filter((args) => args[0] === "exec")).toHaveLength(0);

    egress.report(report({ online: false }));
    await egress.changed();
    expect(fake.calls.filter((args) => args[0] === "exec").map((args) => args[7])).toEqual(["off", "off"]);
    expect(egress.status().route).toBe("server");

    fake.calls.length = 0;
    egress.report(report());
    await egress.changed();
    const back = fake.calls.filter((args) => args[0] === "exec");
    expect(back.map((args) => args[7])).toEqual(["on", "on"]);
    expect(back[0]![10]).not.toBe(writes[0]![10]);

    enabled = false;
    await egress.changed();
    expect(egress.status().route).toBe("off");
    expect(fake.calls.filter((args) => args[0] === "exec").slice(-2).map((args) => args[7])).toEqual(["off", "off"]);
    expect(egress.prompt()).toBe("");
  });

  it("a request that fell back while online gets a fresh policy so the proxy is tried again", async () => {
    const fake = fakeDocker(["aaaaaaaaaaaa"]);
    let t = 0;
    const egress = createComputerEgress({ enabled: () => true, docker: () => fake.docker, now: () => t });
    egress.report(report());
    await egress.changed();
    egress.report(report({ fallbacks: 1 }));
    await egress.changed();
    expect(fake.calls.filter((args) => args[0] === "exec")).toHaveLength(2);
    t = 5000;
    egress.report(report({ fallbacks: 2 }));
    await egress.changed();
    expect(fake.calls.filter((args) => args[0] === "exec")).toHaveLength(2);
  });

  it("a silent agent means the server's own network, and nothing runs without docker on this server", async () => {
    let t = 0;
    const egress = createComputerEgress({ enabled: () => true, docker: () => null, now: () => t });
    expect(egress.status()).toMatchObject({ available: false, route: "server" });
    egress.report(report());
    expect(egress.status().route).toBe("computer");
    expect(egress.prompt()).toContain("check it in the browser");
    t = 60_000;
    expect(egress.status()).toMatchObject({ available: false, route: "server" });
  });

  it("routes through the computer only while its dials are fast, and does not flap between the two limits", async () => {
    // over the relay a dial took 350-1100 ms and pages stayed black for minutes
    const fake = fakeDocker(["aaaaaaaaaaaa"]);
    const egress = createComputerEgress({ enabled: () => true, docker: () => fake.docker });
    const route = async (dialMs: number | null) => { egress.report(report({ dialMs })); await egress.changed(); return egress.status().route; };
    const applied = () => fake.calls.filter((args) => args[0] === "exec").map((args) => (args[7] === "on" && Buffer.from(JSON.parse(args[10]!).ProxySettings.ProxyPacUrl.split(",")[1], "base64").toString().includes(JSON.stringify(HOME_ONLY_SITES)) ? "sites" : args[7]));
    expect(await route(null)).toBe("server");
    expect(await route(450)).toBe("server");
    expect(await route(FAST_DIAL_MS + 1)).toBe("server");
    expect(await route(FAST_DIAL_MS)).toBe("computer");
    expect(applied()).toEqual(["sites", "on"]);
    expect(await route(SLOW_DIAL_MS)).toBe("computer");
    expect(await route(null)).toBe("computer");
    expect(await route(SLOW_DIAL_MS + 1)).toBe("server");
    expect(applied()).toEqual(["sites", "on", "sites"]);
    expect(await route(SLOW_DIAL_MS)).toBe("server");
  });

  it("never calls an online computer offline: a fresh link with no dial yet and a slow path read as online", () => {
    // walkthrough 2026-11-14: right after linking a server and moving bots there, its chat said "Your computer is
    // offline" while the Mac was online, because route "server" (no dial measured yet, or a slow relay) read as offline
    let t = 0;
    const egress = createComputerEgress({ enabled: () => true, docker: () => null, now: () => t });
    expect(egressRouteState(egress.status())).toBe("unknown");
    egress.report(report({ dialMs: null }));
    expect(egress.status()).toMatchObject({ available: true, route: "server", computerOnline: true });
    expect(egressRouteState(egress.status())).toBe("slow");
    egress.report(report({ dialMs: 900 }));
    expect(egressRouteState(egress.status())).toBe("slow");
    egress.report(report({ dialMs: FAST_DIAL_MS }));
    expect(egressRouteState(egress.status())).toBe("computer");
    egress.report(report({ online: false }));
    expect(egress.status()).toMatchObject({ route: "server", computerOnline: false });
    expect(egressRouteState(egress.status())).toBe("offline");
    t = 60_000;
    expect(egress.status().computerOnline).toBe(false);
    expect(egressRouteState(egress.status())).toBe("unknown");
    expect(egressRouteState({ available: true, enabled: true, route: "server" })).toBe("unknown");
    expect(egressRouteState({ available: true, enabled: false, route: "off", computerOnline: false })).toBe("off");
  });

  it("keeps an agent that does not measure dials on the old rule", () => {
    const egress = createComputerEgress({ enabled: () => true, docker: () => null });
    egress.report(report());
    expect(egress.status().route).toBe("computer");
    expect(parseEgressReport({ ...report(), dialMs: -3 })).not.toHaveProperty("dialMs");
    expect(parseEgressReport({ ...report(), dialMs: null })?.dialMs).toBeNull();
    expect(parseEgressReport({ ...report(), dialMs: 120 })?.dialMs).toBe(120);
  });

  it("clears a box that starts while the route is off, so a policy left in its root never outlives the route", async () => {
    // live 2026-11-08: boxes woken while the route was off kept an old "SOCKS5 ..." policy with no fallback, and every
    // page failed with ERR_SOCKS_CONNECTION_FAILED while the person's computer took no streams
    const ids = ["aaaaaaaaaaaa"];
    const fake = fakeDocker(ids);
    const egress = createComputerEgress({ enabled: () => true, docker: () => fake.docker });
    egress.report(report({ online: false }));
    await egress.changed();
    expect(fake.calls.filter((args) => args[0] === "exec").map((args) => [args[3], args[7]])).toEqual([["aaaaaaaaaaaa", "off"]]);
    ids.length = 0;
    egress.report(report({ online: false }));
    await egress.changed();
    ids.push("aaaaaaaaaaaa", "bbbbbbbbbbbb");
    egress.report(report({ online: false }));
    await egress.changed();
    expect(fake.calls.filter((args) => args[0] === "exec").map((args) => [args[3], args[7]])).toEqual([
      ["aaaaaaaaaaaa", "off"], ["aaaaaaaaaaaa", "off"], ["bbbbbbbbbbbb", "off"],
    ]);
    egress.report(report({ online: false }));
    await egress.changed();
    expect(fake.calls.filter((args) => args[0] === "exec")).toHaveLength(3);
  });

  it("a box that cannot hold the policy (read-only) does not stop the others", async () => {
    const fake = fakeDocker(["aaaaaaaaaaaa", "bbbbbbbbbbbb"]);
    const docker = async (args: string[]) => {
      if (args[3] === "aaaaaaaaaaaa") throw new Error("OSError: [Errno 30] Read-only file system");
      return fake.docker(args);
    };
    const egress = createComputerEgress({ enabled: () => true, docker: () => docker, log: () => {} });
    egress.report(report());
    await egress.changed();
    expect(fake.calls.filter((args) => args[0] === "exec").map((args) => args[3])).toEqual(["bbbbbbbbbbbb"]);
  });
});

describe("the routes", () => {
  function call(handler: ReturnType<typeof createComputerEgressRoutes>, auth: RouteContext["auth"], method: string, path: string, body?: unknown) {
    let answer: { status: number; body: unknown } | null = null;
    const ctx = {
      req: {} as RouteContext["req"], res: { setHeader: () => {} } as unknown as RouteContext["res"], url: new URL(`http://x${path}`), path, method, auth,
      json: ((_res: unknown, status: number, value: unknown) => { answer = { status, body: value }; }) as unknown as RouteContext["json"],
      readBody: (async () => body) as unknown as RouteContext["readBody"],
    };
    return handler(ctx).then((out) => (out === PASS ? "pass" : answer));
  }
  const owner = { kind: "loopback", scopes: ["admin", "client"] } as const;
  const service = { kind: "loopback", scopes: ["client"], trust: "service" } as const;
  const session = (scopes: string[]) => ({ kind: "session", via: "cookie", scopes, session: { id: "s" } }) as unknown as RouteContext["auth"];

  it("takes the agent's report only from owner-trust loopback", async () => {
    const saved: boolean[] = [];
    let blockedOn = false;
    const egress = createComputerEgress({ enabled: () => false, blockedSitesEnabled: () => blockedOn, docker: () => null });
    const routes = createComputerEgressRoutes({ egress, setEnabled: (on) => saved.push(on) });
    expect(await call(routes, owner, "POST", "/api/computer/egress/agent", report())).toEqual({ status: 200, body: { enabled: false } });
    // the agent refuses every stream while told off, so "when a site blocks the cloud" alone keeps it taking them
    blockedOn = true;
    expect(await call(routes, owner, "POST", "/api/computer/egress/agent", report())).toEqual({ status: 200, body: { enabled: true } });
    expect((await call(routes, service, "POST", "/api/computer/egress/agent", report()) as { status: number }).status).toBe(403);
    expect((await call(routes, session(["admin", "client"]), "POST", "/api/computer/egress/agent", report()) as { status: number }).status).toBe(403);
    expect((await call(routes, owner, "POST", "/api/computer/egress/agent", { online: "yes" }) as { status: number }).status).toBe(400);
  });

  it("lets only the owner or an admin read and change the setting", async () => {
    let enabled = false;
    const egress = createComputerEgress({ enabled: () => enabled, docker: () => null });
    const routes = createComputerEgressRoutes({ egress, setEnabled: (on) => { enabled = on; } });
    expect((await call(routes, session(["client"]), "PUT", "/api/computer/egress", { enabled: true }) as { status: number }).status).toBe(403);
    expect((await call(routes, owner, "PUT", "/api/computer/egress", { enabled: "on" }) as { status: number }).status).toBe(400);
    expect(await call(routes, session(["admin", "client"]), "PUT", "/api/computer/egress", { enabled: true })).toMatchObject({ status: 200, body: { enabled: true, route: "server" } });
    expect(enabled).toBe(true);
    expect(await call(routes, owner, "GET", "/api/computer/egress")).toMatchObject({ status: 200, body: { enabled: true } });
    expect(await call(routes, owner, "GET", "/api/computers/vps")).toBe("pass");
  });

  it("saves \"when a site blocks the cloud\" on its own, owner or admin only", async () => {
    let sites = true;
    const egress = createComputerEgress({ enabled: () => true, blockedSitesEnabled: () => sites, docker: () => null });
    const routes = createComputerEgressRoutes({ egress, setEnabled: () => { throw new Error("not this one"); }, setBlockedSites: (on) => { sites = on; } });
    expect((await call(routes, session(["client"]), "PUT", "/api/computer/egress", { blockedSitesEnabled: false }) as { status: number }).status).toBe(403);
    expect((await call(routes, owner, "PUT", "/api/computer/egress", { blockedSitesEnabled: "no" }) as { status: number }).status).toBe(400);
    expect(await call(routes, owner, "PUT", "/api/computer/egress", { blockedSitesEnabled: false })).toMatchObject({ status: 200, body: { enabled: true, blockedSitesEnabled: false, blockedSites: [] } });
    expect(sites).toBe(false);
  });
});

describe("a site that blocks a bot computer", () => {
  const pacSites = (args: string[]) => {
    const pac = Buffer.from(JSON.parse(args[10]!).ProxySettings.ProxyPacUrl.split(",")[1], "base64").toString();
    return JSON.parse(/if \(!(\[[^\]]*\])\.some/u.exec(pac)?.[1] ?? "null") as string[] | null;
  };

  it("goes through the person's connection by itself, sticky for the session, while the rest stays on this network", async () => {
    let t = 1_000;
    const fake = fakeDocker(["aaaaaaaaaaaa"]);
    const egress = createComputerEgress({ enabled: () => false, docker: () => fake.docker, now: () => t });
    egress.report(report());
    await egress.changed();
    expect(fake.calls.filter((args) => args[0] === "exec").map((args) => args[7])).toEqual(["off"]);
    expect(await egress.routeSite("www.Pastebin.com")).toBe(true);
    const last = fake.calls.filter((args) => args[0] === "exec").at(-1)!;
    expect(last[7]).toBe("on");
    expect(pacSites(last)).toEqual(["pastebin.com"]);
    expect(egress.status()).toMatchObject({ blockedSitesEnabled: true, blockedSites: ["pastebin.com"] });
    // the PAC sends that site and its subdomains the person's way, and nothing else
    const pac = (url: string) => {
      const sandbox: Record<string, unknown> = { isPlainHostName: (h: string) => !h.includes("."), dnsDomainIs: (h: string, d: string) => h.endsWith(d), isInNet: () => false };
      runInNewContext(Buffer.from(JSON.parse(last[10]!).ProxySettings.ProxyPacUrl.split(",")[1], "base64").toString(), sandbox);
      return (sandbox.FindProxyForURL as (u: string, h: string) => string)(url, new URL(url).hostname);
    };
    expect(pac("https://pastebin.com/")).toBe(`SOCKS5 ${proxy.host}:${proxy.port}; DIRECT`);
    expect(pac("https://www.pastebin.com/api")).toBe(`SOCKS5 ${proxy.host}:${proxy.port}; DIRECT`);
    expect(pac("https://example.com/")).toBe("DIRECT");
    // later blocks add to the list; after the session window a site goes back
    t += 60_000;
    egress.report(report());
    expect(await egress.routeSite("example.org")).toBe(true);
    expect(pacSites(fake.calls.filter((args) => args[0] === "exec").at(-1)!)).toEqual(["example.org", "pastebin.com"]);
    t += 12 * 60 * 60_000 - 30_000;
    egress.report(report());
    await egress.changed();
    expect(egress.status().blockedSites).toEqual(["example.org"]);
  });

  it("joins the sites that always go home while the whole route is on but slow", async () => {
    const fake = fakeDocker(["aaaaaaaaaaaa"]);
    const egress = createComputerEgress({ enabled: () => true, docker: () => fake.docker });
    egress.report(report({ dialMs: 900 }));
    await egress.changed();
    expect(await egress.routeSite("pastebin.com")).toBe(true);
    expect(pacSites(fake.calls.filter((args) => args[0] === "exec").at(-1)!)).toEqual([...HOME_ONLY_SITES, "pastebin.com"]);
  });

  it("falls back to this network when the person's computer goes offline, and comes back with it", async () => {
    const fake = fakeDocker(["aaaaaaaaaaaa"]);
    const egress = createComputerEgress({ enabled: () => false, docker: () => fake.docker });
    egress.report(report());
    expect(await egress.routeSite("pastebin.com")).toBe(true);
    egress.report(report({ online: false }));
    await egress.changed();
    expect(fake.calls.filter((args) => args[0] === "exec").at(-1)![7]).toBe("off");
    egress.report(report());
    await egress.changed();
    expect(pacSites(fake.calls.filter((args) => args[0] === "exec").at(-1)!)).toEqual(["pastebin.com"]);
  });

  it("says no, so the bot moves on, when the setting is off, the computer is offline, there is no link agent or everything already goes home", async () => {
    const fake = fakeDocker(["aaaaaaaaaaaa"]);
    const off = createComputerEgress({ enabled: () => false, blockedSitesEnabled: () => false, docker: () => fake.docker });
    off.report(report());
    expect(await off.routeSite("pastebin.com")).toBe(false);
    expect(off.status().blockedSites).toEqual([]);
    const offline = createComputerEgress({ enabled: () => false, docker: () => fake.docker });
    offline.report(report({ online: false }));
    expect(await offline.routeSite("pastebin.com")).toBe(false);
    expect(await createComputerEgress({ enabled: () => false, docker: () => fake.docker }).routeSite("pastebin.com")).toBe(false);
    const all = createComputerEgress({ enabled: () => true, docker: () => fake.docker });
    all.report(report());
    expect(await all.routeSite("pastebin.com")).toBe(false);
    for (const name of ["localhost", "10.0.0.1", "printer.local", "intranet", ""]) expect(await offline.routeSite(name)).toBe(false);
  });
});

it("keeps the agent, the host fence, the app and the server in step", () => {
  const agent = readFileSync(new URL("../apps/link-service/agent.mjs", import.meta.url), "utf8");
  expect(agent).toContain(`export const EGRESS_BRIDGE = "${BOT_DESKTOP_BRIDGE}";`);
  const port = /export const EGRESS_PORT = Number\(process\.env\.LINK_EGRESS_PORT\) \|\| (\d+);/.exec(agent)?.[1];
  expect(port).toBe("3129");
  expect(readFileSync(new URL("../deploy/bot-desktop/host-fence.sh", import.meta.url), "utf8")).toContain(`EGRESS_PORT="\${MADANI_EGRESS_PORT:-${port}}"`);
  expect([...MAC_PORTS]).toEqual([...EGRESS_PORTS]);
});
