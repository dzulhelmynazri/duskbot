import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TeamComputers, teamComputerOwner, workspaceComputerId } from "./team-computers.ts";
import { teamComputerVpsTarget } from "./team-computer-vps.ts";

const directories: string[] = [];
const fixture = () => {
  const directory = mkdtempSync(join(tmpdir(), "madani-default-computer-"));
  directories.push(directory);
  const file = join(directory, "team-computers.json");
  const environmentId = randomUUID();
  return { file, environmentId, registry: new TeamComputers(file, environmentId) };
};
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
const enabled = { workspaceShared: true };

describe("one implicit personal workspace computer", () => {
  it("tells which bots shared mode would move without creating the workspace computer", () => {
    const { file, registry } = fixture();
    const named = registry.create("Named desktop");
    registry.assign(named.id, "Research");
    expect(registry.joinsWorkspaceComputer({})).toBe(true);
    expect(registry.joinsWorkspaceComputer({ computer: "cloud", section: "Research" })).toBe(true);
    for (const bot of [{ section: "Research" }, { computer: "local" }, { vpsAlias: "private-host" }, { createdBy: "owner@example.test" }]) {
      expect(registry.joinsWorkspaceComputer(bot), JSON.stringify(bot)).toBe(false);
    }
    expect(registry.hasWorkspaceComputer()).toBe(false);
    expect(JSON.parse(readFileSync(file, "utf8")).computers).toHaveLength(1);
    registry.workspaceDefault();
    expect(registry.hasWorkspaceComputer()).toBe(true);
  });
  it("does not create a registry entry until sharing is explicitly permitted by workspace policy", () => {
    const { file, registry } = fixture();
    expect(registry.forBot({})).toBeUndefined();
    expect(registry.forBot({}, { workspaceShared: false })).toBeUndefined();
    expect(existsSync(file)).toBe(false);
    expect(registry.list()).toEqual([]);
  });
  it("keeps one deterministic persisted identity across bots, sections and restarts", () => {
    const { file, environmentId, registry } = fixture();
    const first = registry.forBot({ section: "Research" }, enabled)!;
    expect(first).toMatchObject({ id: workspaceComputerId(environmentId), scope: "workspace", section: null });
    const saved = readFileSync(file, "utf8");
    expect(registry.forBot({ section: "Other", computer: "cloud" }, enabled)).toEqual(first);
    expect(readFileSync(file, "utf8")).toBe(saved);
    const restarted = new TeamComputers(file, environmentId);
    expect(restarted.forBot({}, enabled)).toEqual(first);
    expect(restarted.list()).toHaveLength(1);
    expect(workspaceComputerId(randomUUID())).not.toBe(first.id);
  });
  it("shares Auto and cloud locations but preserves every explicit local or disabled destination", () => {
    const { registry } = fixture();
    const shared = registry.forBot({}, enabled)!;
    expect(registry.forBot({ computer: "cloud" }, enabled)?.id).toBe(shared.id);
    for (const computer of ["off", "local", "vm", "browser"]) expect(registry.forBot({ computer }, enabled)).toBeUndefined();
    expect(registry.forBot({ vpsAlias: "private-host" }, enabled)).toBeUndefined();
    expect(registry.forBot({ computer: "cloud", vpsAlias: "private-host" }, enabled)).toBeUndefined();
  });
  it.each([
    { createdBy: "owner@example.test" }, { reportsTo: "owner@example.test" }, { defaultBot: { person: "owner@example.test" } },
  ])("refuses to implicitly combine a person-owned bot with the workspace: %o", (owner) => {
    const { registry, file } = fixture();
    expect(registry.forBot(owner, enabled)).toBeUndefined();
    expect(existsSync(file)).toBe(false);
  });
  it("preserves acknowledged named-team assignment priority for Auto only", () => {
    const { registry } = fixture();
    const named = registry.create("Named desktop");
    registry.assign(named.id, "Research");
    expect(registry.forBot({ section: "Research", vpsAlias: "member-host" }, enabled)?.id).toBe(named.id);
    const shared = registry.forBot({ section: "Research", computer: "cloud" }, enabled)!;
    expect(shared.scope).toBe("workspace");
    expect(shared.id).not.toBe(named.id);
    expect(registry.forBot({ section: "Research" }, { workspaceShared: false })?.id).toBe(named.id);
  });
  it("does not convert, merge or delete old named identities when the default is introduced", () => {
    const { registry, file, environmentId } = fixture();
    const named = registry.create("Existing private desktop");
    registry.assign(named.id, "Existing team");
    const before = registry.list();
    const shared = registry.workspaceDefault();
    expect(new TeamComputers(file, environmentId).get(named.id)).toEqual(before[0]);
    expect(teamComputerOwner(named.id)).not.toBe(teamComputerOwner(shared.id));
    expect(teamComputerVpsTarget({ vps: { sshAlias: "workspace-host" } }, named).containerName).not.toBe(teamComputerVpsTarget({ vps: { sshAlias: "workspace-host" } }, shared).containerName);
    expect(registry.forBot({ section: "No assignment" }, { workspaceShared: false })).toBeUndefined();
    expect(registry.get(shared.id)).toEqual(shared);
  });
  it("reserves the default identity and refuses section reassignment", () => {
    const { registry, environmentId } = fixture();
    expect(() => registry.create("Hijacked", workspaceComputerId(environmentId))).toThrow(/reserved/);
    const shared = registry.workspaceDefault();
    expect(() => registry.assign(shared.id, "Other")).toThrow(/cannot be assigned/);
    expect(() => registry.assign(shared.id, null)).toThrow(/cannot be assigned/);
    expect(registry.forSection(undefined)).toBeUndefined();
  });
  it("allows the existing named-computer limit alongside one implicit default", () => {
    const { registry, file, environmentId } = fixture();
    for (let index = 0; index < 100; index += 1) registry.create(`Desktop ${index}`);
    expect(registry.workspaceDefault().scope).toBe("workspace");
    expect(registry.list()).toHaveLength(101);
    expect(new TeamComputers(file, environmentId).list()).toHaveLength(101);
    expect(() => registry.create("One too many")).toThrow(/limit/);
  });
  it("fails closed for a forged default identity or section instead of adopting a private computer", () => {
    const { registry, file, environmentId } = fixture();
    const shared = registry.workspaceDefault();
    for (const invalid of [{ ...shared, id: randomUUID() }, { ...shared, section: "Other" }]) {
      const contents = JSON.stringify({ version: 1, environmentId, computers: [invalid] });
      writeFileSync(file, contents);
      const reopened = new TeamComputers(file, environmentId);
      expect(() => reopened.forBot({}, enabled)).toThrow(/workspace computer identity/);
      expect(readFileSync(file, "utf8")).toBe(contents);
    }
  });
});
