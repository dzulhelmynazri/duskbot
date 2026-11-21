import { afterEach, expect, it } from "vitest";
import { RetryableCloudError } from "../../dashboard/server/clouds/http.ts";
import { makeTar, tarEntries } from "./backups.ts";
import { startFakeInstaboxApi, type FakeInstaboxApi } from "./fake-instabox-api.ts";
import { createInstaboxProvider, instaboxCostProfile, instaboxHourlyCents, instaboxSize, instaboxUsageCents, InstaboxError } from "./instabox.ts";
import { HOME_IMAGE as INSTABOX_IMAGE, homeControlScript, INSTABOX_BOOT_FILE, INSTABOX_SETUP_FILE } from "./home.ts";
import { ProviderBusyError, ProviderLimitError } from "./provider.ts";

const apis: FakeInstaboxApi[] = [];
afterEach(async () => { for (const api of apis.splice(0)) await api.close(); });
const CLOUD = `c${"a".repeat(24)}`, SCOPE = "0123456789abcdef";
async function fixture(setupPolls = 1) {
  const api = await startFakeInstaboxApi({ setupPolls }); apis.push(api);
  return { api, provider: createInstaboxProvider({ apiKey: api.key, baseUrl: api.baseUrl, scope: SCOPE, pollMs: 1, settleMs: 2_000 }) };
}
const input = { cloudId: CLOUD, spec: { vcpu: 2, ramGb: 4, diskGb: 40 }, region: "eu", userData: "#!/bin/bash\ntrue\n", ttlSeconds: 7200, files: [{ path: INSTABOX_BOOT_FILE, content: "{\"v\":2}" }] };

it("prices and sizes machines from the plan's sizes", () => {
  expect(instaboxSize({ vcpu: 2, ramGb: 4, diskGb: 40 })).toEqual({ vcpu: 2, memMiB: 4096 });
  // never rounded up: a machine is the size that was sold
  for (const spec of [{ vcpu: 3, ramGb: 4, diskGb: 40 }, { vcpu: 2, ramGb: 16, diskGb: 40 }, { vcpu: 64, ramGb: 512, diskGb: 40 }]) expect(() => instaboxSize(spec)).toThrow("unavailable");
  expect(instaboxHourlyCents({ vcpu: 3, ramGb: 4, diskGb: 40 })).toBeCloseTo(3.4);
  expect(instaboxHourlyCents({ vcpu: 2, ramGb: 4, diskGb: 40 })).toBeCloseTo(1.7);
  expect(instaboxHourlyCents({ vcpu: 4, ramGb: 8, diskGb: 80 })).toBeCloseTo(3.4);
  const profile = instaboxCostProfile();
  expect(profile.startCents({ minute: 0, hour: 0, day: 0 })).toBe(0);
  expect(profile.startCents({ minute: 30, hour: 0, day: 0 })).toBe(Number.POSITIVE_INFINITY);
  expect(profile.held.probability).toBeGreaterThan(0.9);
  expect(profile.wakeMs.held).toBeLessThan(profile.wakeMs.cold);
  expect(instaboxUsageCents({ vcpuSeconds: 2 * 3600, memGiBSeconds: 4 * 3600 })).toBeCloseTo(1.7);
});

it("creates one labelled machine per cloud and attempt with no account credentials, publishes the home's port and starts the setup", async () => {
  const { api, provider } = await fixture();
  const first = await provider.create(input), again = await provider.create(input);
  expect(again.id).toBe(first.id);
  expect(api.machines.size).toBe(1);
  expect(first.origin).toMatch(/^https:\/\/8080-[a-z0-9]+\.instabox\.tech$/);
  const body = api.requests.find(r => r.method === "POST" && r.path === "/v1/machines")!.body as Record<string, any>;
  expect(body).toMatchObject({ templateId: "universal", vcpus: 2, memMiB: 4096, vault: false, secrets: [], autoSuspendAfterSeconds: 1800, metadata: { "omb.cloud": CLOUD, "omb.scope": SCOPE, "omb.attempt": "0" } });
  const machine = api.machines.get(first.id)!;
  expect(machine.files.get(INSTABOX_BOOT_FILE)?.toString()).toBe("{\"v\":2}");
  expect(machine.files.has(INSTABOX_SETUP_FILE)).toBe(true);
  expect(machine.metadata["omb.setup"]).toBe("running");
  expect(machine.leases.has("madani-lifecycle")).toBe(true);
  expect((await provider.machine(first.id))?.setup).toBe("done");
  expect(machine.metadata["omb.setup"]).toBe("done");
  const recovery = await provider.create({ ...input, attempt: 1 });
  expect(recovery.id).not.toBe(first.id);
  expect((await provider.find(CLOUD))?.id).toBe(recovery.id);
});

it("pauses with memory kept and resumes where it left off; a fresh boot is reported as one", async () => {
  const { api, provider } = await fixture();
  const server = await provider.create(input);
  const m = api.machines.get(server.id)!;
  m.memory.add("a turn in flight");
  await provider.power(server.id, "off");
  expect(m.state).toBe("suspended");
  expect(api.requests.some(r => r.path.endsWith("/exec") && (r.body as { cmd: string }).cmd === "sync")).toBe(true);
  expect((await provider.machine(server.id))?.state).toBe("stopped");
  expect((await provider.status(server.id)).state).toBe("off");
  await provider.power(server.id, "off");
  expect(api.requests.filter(r => r.path.endsWith("/suspend"))).toHaveLength(1);
  await provider.power(server.id, "on");
  expect(m.state).toBe("running");
  expect(m.memory.has("a turn in flight")).toBe(true);
  await provider.power(server.id, "off");
  api.coldResume();
  await provider.power(server.id, "on");
  expect(m.memory.size).toBe(0);
  expect(m.processesPreserved).toBe(false);
  api.lose(server.id);
  expect((await provider.status(server.id)).state).toBe("missing");
  expect(await provider.machine(server.id)).toBeNull();
});

it("wakes a machine that paused itself, starts a stopped one, and resizes a paused one through a stop", async () => {
  const { api, provider } = await fixture();
  const server = await provider.create(input);
  api.autoPause(server.id);
  await provider.power(server.id, "on");
  expect(api.machines.get(server.id)!.state).toBe("running");
  await provider.power(server.id, "off");
  await provider.resize(server.id, { vcpu: 4, ramGb: 8, diskGb: 80 });
  const m = api.machines.get(server.id)!;
  expect([m.vcpus, m.memMiB, m.diskGiB, m.state]).toEqual([4, 8192, 80, "running"]);
  expect((await provider.status(server.id)).diskGb).toBe(80);
  await expect(provider.resize(server.id, { vcpu: 2, ramGb: 4, diskGb: 40 })).rejects.toThrow("must be off");
});

it("reads a live backup of the volume and removes it from the machine once read; never from a sleeping machine", async () => {
  const { api, provider } = await fixture();
  const server = await provider.create(input);
  const m = api.machines.get(server.id)!;
  m.volume.set("data/.omb-cloud-home.json", Buffer.from(JSON.stringify({ version: 1, machine: CLOUD })));
  m.volume.set("data/.openmausbot/bots.json", Buffer.from("[]"));
  const snap = await provider.latestSnapshot(server.id);
  expect(snap?.id).toMatch(/^live-[a-z0-9]{26}-\d{13}$/);
  const stream = await provider.snapshotTar(snap!.id, INSTABOX_IMAGE.homeVolume);
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) chunks.push(chunk);
  const names = tarEntries(Buffer.concat(chunks)).map(e => e.name);
  expect(names).toEqual(expect.arrayContaining(["data/.omb-cloud-home.json", "data/.openmausbot/bots.json"]));
  await new Promise(r => setTimeout(r, 50));
  expect(m.files.has("/data/home/.omb-snapshot.tar")).toBe(false);
  await provider.power(server.id, "off");
  expect(await provider.latestSnapshot(server.id)).toBeNull();
  await expect(provider.snapshotTar("live-x", "data")).rejects.toThrow("Invalid");
});

it("restores a backup made on another host into the volume", async () => {
  const { api, provider } = await fixture();
  const server = await provider.create(input);
  const tar = makeTar([{ name: "data/.omb-cloud-home.json", data: Buffer.from(JSON.stringify({ version: 1, machine: CLOUD })) }, { name: "data/.openmausbot/bots.json", data: Buffer.from("[1]") }]);
  await provider.upload(server.id, INSTABOX_IMAGE.restorePath, tar);
  expect((await provider.run(server.id, INSTABOX_IMAGE.restoreCommand)).stdout).toContain("restored");
  expect(api.machines.get(server.id)!.volume.get("data/.openmausbot/bots.json")?.toString()).toBe("[1]");
  await expect(provider.upload(server.id, "/etc/passwd", Buffer.from("x"))).rejects.toThrow("Invalid upload path");
});

it("archives in one call when the save is accepted as an operation and the snapshot is listed only later", async () => {
  const { api, provider } = await fixture();
  const server = await provider.create(input);
  await provider.power(server.id, "off");
  api.slowSnapshots(3);
  const snap = await provider.archive(server.id, "madani-slow-save");
  expect(snap?.id).toMatch(/^sn_/);
  expect(api.snapshots.get(snap!.id)!.name).toBe("madani-slow-save");
  expect(api.requests.filter(r => r.method === "POST" && r.path.endsWith("/snapshots"))).toHaveLength(1);
  expect(await provider.archive(server.id, "madani-slow-save")).toEqual(snap);
});

it("treats limits, cooldowns and conflicts as waiting, deletes only with confirmation and a receipt, and never names the key", async () => {
  const { api, provider } = await fixture();
  const server = await provider.create(input);
  await expect(provider.destroy(server.id)).rejects.toThrow("retention reconciler");
  api.limitNext(1);
  await expect(provider.status(server.id)).rejects.toBeInstanceOf(ProviderLimitError);
  await provider.power(server.id, "off");
  api.refuseResume(server.id);
  await expect(provider.power(server.id, "on")).rejects.toBeInstanceOf(ProviderLimitError);
  api.refuseResume(null);
  api.failNext(1);
  await expect(provider.status(server.id)).rejects.toBeInstanceOf(RetryableCloudError);
  const answer = await provider.requestDelete(server.id);
  expect(answer.operationId).toMatch(/^op_[a-z0-9]{26}$/);
  expect(api.deletes()[0]!.headers["x-confirm-delete"]).toBe(server.id);
  expect((await provider.deletion(answer.operationId!))?.status).toBe("completed");
  expect(await provider.machine(server.id)).toBeNull();
  expect((await provider.requestDelete(server.id)).gone).toBe(true);
  const wrong = createInstaboxProvider({ apiKey: `ibk_${"w".repeat(52)}`, baseUrl: api.baseUrl, scope: SCOPE });
  const failure = await wrong.create(input).then(() => new Error("created"), (error: Error) => error);
  expect(failure).toBeInstanceOf(InstaboxError);
  expect(String(failure.message)).not.toContain("w".repeat(52));
  expect(() => createInstaboxProvider({ apiKey: api.key, baseUrl: "http://instabox.example.test", scope: SCOPE })).toThrow("INSTABOX_BASE_URL");
  expect(() => createInstaboxProvider({ apiKey: api.key, scope: SCOPE, idlePauseMinutes: 2 })).toThrow("idle pause");
  void ProviderBusyError;
});

it("sees only its own deployment's machines, and its leases and usage", async () => {
  const { api, provider } = await fixture();
  const server = await provider.create(input);
  const other = createInstaboxProvider({ apiKey: api.key, baseUrl: api.baseUrl, scope: "fedcba9876543210", pollMs: 1 });
  await other.create({ ...input, cloudId: `c${"b".repeat(24)}` });
  expect((await provider.inventory()).map(s => s.cloudId)).toEqual([CLOUD]);
  expect(await provider.listed(server.id)).toBe(true);
  await provider.lease(server.id, null);
  expect(api.machines.get(server.id)!.leases.size).toBe(0);
  await provider.lease(server.id, 99_999);
  expect(api.requests.at(-1)!.body).toEqual({ ttlSeconds: 3600 });
  const usage = await provider.usage!(server.id);
  expect(usage?.vcpuSeconds).toBeGreaterThanOrEqual(0);
});

it("the image restores in place and keeps the platform's entries, and a resumed home is not restarted", () => {
  const control = homeControlScript(), restore = control.slice(control.indexOf("  restore)"), control.indexOf("echo restored ;;"));
  expect(restore).toContain("mktemp -d /data/.omb-restore.");
  expect(restore).not.toContain("mv /data /data.old");
  for (const kept of ["home", "tmp", "workspace", "swapfile", "lost+found"]) expect(restore).toContain(kept);
  const start = control.slice(control.indexOf("  start)"));
  expect(start.indexOf("systemctl is-active --quiet omb-home.service")).toBeLessThan(start.indexOf("systemctl restart omb-home.service"));
  const setup = INSTABOX_IMAGE.setupScript({ releaseKeys: [], requireSigned: false });
  expect(setup).toContain("-m 0711 /data");
  expect(setup).not.toContain("pre-stop");
  expect(setup).toContain(INSTABOX_BOOT_FILE);
  expect(INSTABOX_IMAGE.installCommand("a".repeat(64))).toContain("/data/home/omb-home.tgz");
});

it("gives a new machine the disk that was sold and keeps it in step with plan changes", async () => {
  const { api, provider } = await fixture();
  const plus = await provider.create({ ...input, spec: { vcpu: 2, ramGb: 4, diskGb: 20 } });
  // the size's own 20 GiB: nothing to grow, and a create never sends a disk size (InstaBox refuses one)
  expect(api.machines.get(plus.id)!.diskGiB).toBe(20);
  expect(api.requests.filter(r => r.method === "PATCH" && (r.body as Record<string, unknown>)?.persistentDiskGiB)).toHaveLength(0);
  expect(Object.keys(api.requests.find(r => r.method === "POST" && r.path === "/v1/machines")!.body as object)).not.toContain("persistentDiskGiB");

  const pro = await provider.create({ ...input, cloudId: `c${"b".repeat(24)}`, spec: { vcpu: 4, ramGb: 8, diskGb: 60 } });
  expect(api.machines.get(pro.id)!.diskGiB).toBe(60);
  expect(pro.diskGb).toBe(60);
  // a retried create finds the grown disk and asks for nothing more
  const patches = api.requests.filter(r => r.method === "PATCH" && (r.body as Record<string, unknown>)?.persistentDiskGiB).length;
  await provider.create({ ...input, cloudId: `c${"b".repeat(24)}`, spec: { vcpu: 4, ramGb: 8, diskGb: 60 } });
  expect(api.requests.filter(r => r.method === "PATCH" && (r.body as Record<string, unknown>)?.persistentDiskGiB)).toHaveLength(patches);

  // a grow that needs a stop: stopped, grown and booted again before the setup starts
  api.growNeedsStop();
  const team = await provider.create({ ...input, cloudId: `c${"d".repeat(24)}`, spec: { vcpu: 8, ramGb: 16, diskGb: 160 } });
  const machine = api.machines.get(team.id)!;
  expect([machine.diskGiB, machine.state, machine.metadata["omb.setup"]]).toEqual([160, "running", "running"]);
  api.growNeedsStop(false);

  // a downgrade shrinks the disk while stopped; when the data does not fit, the bigger disk stays and the resize still lands
  await provider.power(pro.id, "off");
  await provider.resize(pro.id, { vcpu: 2, ramGb: 4, diskGb: 20 });
  expect([api.machines.get(pro.id)!.vcpus, api.machines.get(pro.id)!.diskGiB]).toEqual([2, 20]);
  await provider.power(team.id, "off");
  api.diskUsed(100);
  await provider.resize(team.id, { vcpu: 4, ramGb: 8, diskGb: 60 });
  expect([machine.vcpus, machine.diskGiB, machine.state]).toEqual([4, 160, "running"]);
});
