import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { resolveAgentBrowserBinary } from "../../server/browser-engine.ts";
import { waitForExit } from "../../server/testing/cleanup.ts";
import { canonicalJson, parsePackageDocument } from "../../shared/package-format.ts";
import { runControlMadani } from "../control-madani.ts";
import { request } from "../mcp-server.ts";
import { UI_TOOLS_DIR } from "./control-madani-ui.ts";
import { clickByName } from "./grok-nav.ts";
import { openTemplatesWhenFree } from "./grok-templates.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const FIXTURES = join(ROOT, "shared", "package-fixtures");
const binary = resolveAgentBrowserBinary({ dataDir: UI_TOOLS_DIR, env: process.env });
const forced = process.env.MADANI_UI_E2E === "1";
const enabled = forced || Boolean(binary);
const launchTimeout = forced && !binary ? 600_000 : 180_000;
if (!enabled) console.log("skipping org-library UI e2e: set MADANI_UI_E2E=1 to install the pinned browser");

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const ORG = "11111111-1111-4111-8111-111111111111";
const TEAM_ID = "22222222-2222-4222-8222-222222222222";
const LIBRARY_ID = "44444444-4444-4444-8444-444444444444";

/** A release as Admin serves it: parsed as a file, stamped, canonical bytes. */
function release(name: string) {
  const document: any = parsePackageDocument(JSON.parse(readFileSync(join(FIXTURES, name), "utf8")), { trust: "file" });
  document.package.publisher = { organization: "acme", name: "Acme Partners" };
  const bytes = canonicalJson(document);
  const pkg = document.package;
  return {
    bytes,
    sha256: sha(bytes),
    entry: (packageId: string) => ({
      packageId, ref: `acme/${pkg.id}`, name: pkg.name, tagline: pkg.tagline, kind: pkg.agents.length ? "team" : "library",
      publisher: { organizationId: "33333333-3333-4333-8333-333333333333", name: "Acme Partners", self: false },
      mode: pkg.agents.length ? "required" : "available", offAction: "keep",
      release: { version: pkg.release, sha256: sha(bytes), sizeBytes: Buffer.byteLength(bytes), formatVersion: 2, publishedAt: 1_700_000_000_000, notes: "" },
      withdrawnReleases: [],
      contents: { bots: pkg.agents.length, skills: pkg.skills?.entries.length ?? 0, presets: pkg.presets?.length ?? 0, rooms: pkg.rooms?.length ?? 0,
        routines: pkg.routines?.length ?? 0, connections: pkg.connections?.length ?? 0, botNames: pkg.agents.map((agent: any) => agent.name) },
      scanFindings: 0,
    }),
  };
}

describe("the organization library in the real renderer", () => {
  let child: ChildProcess | undefined;
  afterAll(async () => { await waitForExit(child, { signal: "SIGINT", graceMs: 30_000 }); });

  (enabled ? it : it.skip)("has no shelf without an organization, then adds a team and a skill with one click each", async () => {
    const key = randomBytes(32).toString("hex");
    let stdout = "";
    let stderr = "";
    let info: { ui: string; url: string; botId: string; dataDir: string; logPath: string };
    child = spawn(process.execPath, ["--experimental-strip-types", join(ROOT, "scripts/control-madani.ts"), "ui", "launch"], {
      cwd: ROOT, env: { ...process.env, MADANI_TEST_ORG_LIBRARY_KEY: key }, stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout!.on("data", (chunk: Buffer) => { stdout += String(chunk); });
    child.stderr!.on("data", (chunk: Buffer) => { stderr += String(chunk); });
    child.on("error", (error) => { stderr += error.message; });
    await expect.poll(() => {
      if (child!.exitCode !== null || child!.signalCode !== null) throw new Error(`UI launcher exited: ${stderr}`);
      try { info = JSON.parse(stdout); return Boolean(info.ui); } catch { return false; }
    }, { timeout: launchTimeout, interval: 250 }).toBe(true);
    const ui = (verb: string, ...args: string[]) => runControlMadani(["ui", verb, "--ui", info.ui, ...args]) as Promise<Record<string, any>>;
    const click = (name: string) => ui("click", "--name", name);
    const press = (keys: string) => ui("press", "--keys", keys);
    const snapshot = async () => (await ui("snapshot")).snapshot as string;
    const api = (path: string, method = "GET", body?: unknown) => request(path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, info.url);
    const evidence = (name: string) => ui("screenshot", "--out", join(ROOT, ".madani-scratch", "verify-evidence", name));

    await openTemplatesWhenFree(ui);
    // the library is open on its ready bots (the community list went in 317f92713), with no organization shelf yet
    await expect.poll(snapshot, { timeout: 10_000 }).toContain("Add Quinn, Researcher");
    expect(await snapshot()).not.toContain("From Customer Co");
    await press("Escape");

    // Relay a catalog the way Electron does, with the files where it keeps them.
    const team = release("full-team.v2.json");
    const skills = release("library-only.v2.json");
    const blobs = join(info!.dataDir, "org-library", "blobs");
    mkdirSync(blobs, { recursive: true });
    for (const rel of [team, skills]) writeFileSync(join(blobs, `${rel.sha256}.json`), rel.bytes, { mode: 0o600 });
    const catalog = JSON.stringify({ format: "madani.org-library", version: 1, libraryVersion: 1, organization: { id: ORG, name: "Customer Co" },
      packages: [team.entry(TEAM_ID), skills.entry(LIBRARY_ID)] });
    const relayed = await fetch(`${info!.url}/api/testing/org-library`, {
      method: "POST", headers: { "content-type": "application/json", "x-madani-test-org-library": key },
      body: JSON.stringify({ library: { adminOrigin: "https://admin.example.com", organizationId: ORG, organizationName: "Customer Co", digest: sha(catalog), catalog } }),
    });
    expect(relayed.status).toBe(200);

    await openTemplatesWhenFree(ui);
    await expect.poll(snapshot, { timeout: 10_000 }).toContain("Packages Customer Co shares with you");
    let shelf = await snapshot();
    for (const line of ["From Customer Co", "Sales desk", "Recommended by Acme Partners", "Sales skills", "From Acme Partners"]) expect(shelf).toContain(line);
    await evidence("org-library-shelf.png");

    await click("Details of Sales desk");
    await expect.poll(snapshot, { timeout: 10_000 }).toContain("Included skills (switched on)");
    expect(await snapshot()).toContain("Skills arrive switched on and routines paused");
    await evidence("org-library-preview.png");
    await click("Back to templates");

    await click("Add Sales desk");
    await expect.poll(snapshot, { timeout: 20_000 }).toContain('button "Sales desk"');
    const bots = (await api("/api/bots")).bots.filter((bot: { section?: string }) => bot.section === "Sales desk");
    expect(bots).toHaveLength(3);
    for (const bot of bots) {
      const listed = (await api(`/api/bots/${bot.id}/skills`)).skills as Array<{ enabled: boolean }>;
      expect(listed.every((skill) => skill.enabled)).toBe(true);
    }
    expect((await api("/api/routines")).routines.every((routine: { enabled: boolean }) => !routine.enabled)).toBe(true);

    await openTemplatesWhenFree(ui);
    await expect.poll(snapshot, { timeout: 10_000 }).toContain("Packages Customer Co shares with you");
    shelf = await snapshot();
    expect(shelf).toContain("Added");
    expect(shelf).not.toContain("Add Sales desk");
    await click("Add Sales skills");
    await expect.poll(snapshot, { timeout: 10_000 }).toContain("Sales skills is added. Its skills are offered under each bot's skills.");
    await evidence("org-library-added.png");
    await press("Escape");

    const state = await ui("snapshot", "--interactive");
    const profile = Object.entries(state.refs as Record<string, { role: string; name: string }>)
      .find(([, entry]) => entry.role === "button" && /Open .+ profile/.test(entry.name));
    expect(profile).toBeDefined();
    await ui("click", "--ref", `@${profile![0]}`);
    await expect.poll(snapshot, { timeout: 10_000 }).toContain("From Sales desk 1.3.0 · Acme Partners");
    await clickByName(ui, "Advanced", "tab");
    await clickByName(ui, /^Skills /, "button");
    // the skills the organization shares sit with the bot's installed ones, a page under Skills
    await clickByName(ui, /^Installed/, "button");
    await expect.poll(snapshot, { timeout: 10_000 }).toContain("Skills your organization shares");
    await evidence("org-library-bot-skills.png");
    // the Installed page wipes in; a press mid-wipe lands beside the button, so wait until it stops moving
    await expect.poll(async () => (await ui("eval", "--js", `new Promise(done => { const at = () => { const r = document.querySelector('button[aria-label="Add follow-up to this bot"]')?.getBoundingClientRect(); return r ? [r.left, r.top].join() : null; };
      const first = at(); setTimeout(() => done(first !== null && first === at()), 250); })`)).result, { timeout: 10_000 }).toBe(true);
    await click("Add follow-up to this bot");
    // the bot whose profile is open, by its exact name: one Sales desk name can sit inside another
    const openName = /^Open (.+)'s profile$/.exec(profile![1].name)?.[1];
    const selected = bots.find((bot: { name: string }) => bot.name === openName);
    expect(selected, `a Sales desk bot named ${openName}`).toBeDefined();
    await expect.poll(async () => ((await api(`/api/bots/${selected.id}/skills`)).skills as Array<{ name: string; enabled: boolean }>)
      .find((skill) => skill.name === "follow-up")?.enabled, { timeout: 10_000 }).toBe(true);
    process.stdout.write(`${JSON.stringify({ fixture: info!, addedSection: "Sales desk", offeredSkill: "follow-up" })}\n`);
  }, launchTimeout + 120_000);
});
