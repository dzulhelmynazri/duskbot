import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ComputerControl } from "./computer-control.ts";
import { TeamComputers, teamComputerOwner } from "./team-computers.ts";
import { teamComputerVpsTarget } from "./team-computer-vps.ts";
import { TurnResources } from "./turn-resources.ts";
import { vpsContainerName } from "./vps-computer.ts";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
const fixture = () => {
  const directory = mkdtempSync(join(tmpdir(), "madani-team-vps-"));
  directories.push(directory);
  const registry = new TeamComputers(join(directory, "team-computers.json"), randomUUID());
  const computer = registry.create("Research desktop");
  registry.assign(computer.id, "Research");
  return { registry, computer };
};

describe("shared VPS computer routing", () => {
  it("grants only Auto members the shared desktop, regardless of their legacy provider selection", () => {
    const { registry, computer } = fixture();
    expect(registry.forBot({ section: "Research", cloudBackend: "vps" })?.id).toBe(computer.id);
    expect(registry.forBot({ section: "Other", cloudBackend: "vps" })).toBeUndefined();
    for (const destination of ["off", "cloud", "local", "vm"]) expect(registry.forBot({ section: "Research", computer: destination })).toBeUndefined();
    registry.assign(computer.id, null);
    expect(registry.forBot({ section: "Research" })).toBeUndefined();
  });
  it("uses one workspace-owned container and turn lock for members with different personal VPS aliases", () => {
    const { registry, computer } = fixture();
    const cfg = { vps: { sshAlias: "workspace-vps" } };
    const members = [
      { section: "Research", cloudBackend: "vps", vpsAlias: "member-one-vps" },
      { section: "Research", vpsAlias: "member-two-vps" },
    ];
    const targets = members.map((bot) => teamComputerVpsTarget(cfg, registry.forBot(bot)!));
    expect(targets[0]).toEqual(targets[1]);
    expect(targets[0]).toEqual({ ownerId: teamComputerOwner(computer.id), config: cfg, containerName: vpsContainerName(teamComputerOwner(computer.id)), resource: `computer:vps:workspace-vps:${teamComputerOwner(computer.id)}` });
    const locks = new TurnResources();
    const first = { threadId: "first", generation: "one" }, second = { threadId: "second", generation: "two" };
    expect(locks.claim(targets[0]!.resource, first)).toBe(true);
    expect(locks.claim(targets[1]!.resource, second)).toBe(false);
    locks.release(first);
    expect(locks.claim(targets[1]!.resource, second)).toBe(true);
  });
  it("shares human control without exposing or releasing another viewer's lease", () => {
    const { computer } = fixture();
    const target = teamComputerVpsTarget({ vps: { sshAlias: "workspace-vps" } }, computer);
    const control = new ComputerControl();
    expect(control.acquireLease(target.ownerId, "private-first-lease").owned).toBe(true);
    expect(control.acquireLease(target.ownerId, "private-second-lease").owned).toBe(false);
    expect(control.releaseLease(target.ownerId, "private-second-lease").released).toBe(false);
    expect(control.snapshot(target.ownerId).held).toBe(true);
    expect(JSON.stringify(control.snapshot(target.ownerId))).not.toContain("lease");
  });
  it("keeps an operation on its snapshotted workspace alias when config reloads", () => {
    const { computer } = fixture();
    const cfg = { vps: { sshAlias: "first-vps" } };
    const target = teamComputerVpsTarget(cfg, computer);
    cfg.vps.sshAlias = "next-vps";
    expect(target.config.vps?.sshAlias).toBe("first-vps");
    expect(target.resource).toContain(":first-vps:");
  });
});
