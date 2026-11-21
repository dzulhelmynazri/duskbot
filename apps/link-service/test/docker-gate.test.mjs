import { DOCKER_NAMES } from "../../../electron/legacy-names.mjs";
import * as sharedDesktop from "../../../shared/bot-desktop.ts";
import * as managedNames from "../../../server/vps-managed-names.ts";
import { once } from "node:events";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  FREE_CAPABILITIES, STRICT_CAPABILITIES, SelfCheck, Tracker, checkCreate, checkExec, checkNetworkCreate, checkUpdate, decide, parseImageRef,
  parseJson, pingGate, startGate,
} from "../docker-gate.mjs";

const NAME = `${DOCKER_NAMES.vpsPrefix}-abc-0123456789ab`;
const CID = "c".repeat(64);
const EID = "e".repeat(64);
const PROBE_ID = "d".repeat(64);
const IMAGE = `sha256:${"f".repeat(64)}`;

// what Docker CLI 29.7 sends for botDesktopRunArgs (captured against a recording daemon)
function desktop(mode = "strict", edit = () => {}) {
  const strict = mode === "strict";
  const body = {
    Hostname: "bot", Domainname: "", User: "", AttachStdin: false, AttachStdout: false, AttachStderr: false, Tty: false,
    OpenStdin: false, StdinOnce: false, Env: [`MADANI_MODE=${mode}`, "VNC_PW=x"], Cmd: null, Image: IMAGE, Volumes: {}, WorkingDir: "",
    Entrypoint: null, Labels: { [DOCKER_NAMES.label("container")]: NAME, [DOCKER_NAMES.label("vps")]: "1" },
    HostConfig: {
      Binds: null, ContainerIDFile: "", LogConfig: { Type: "", Config: {} }, NetworkMode: DOCKER_NAMES.desktopNetwork, PortBindings: {},
      RestartPolicy: { Name: "no", MaximumRetryCount: 0 }, AutoRemove: false, VolumeDriver: "", VolumesFrom: null, ConsoleSize: [0, 0],
      CapAdd: strict ? ["CAP_NET_ADMIN", "CAP_SETGID", "CAP_SETUID"] : FREE_CAPABILITIES.map((cap) => `CAP_${cap}`), CapDrop: ["ALL"],
      CgroupnsMode: "private", Dns: ["1.1.1.1", "9.9.9.9"], DnsOptions: [], DnsSearch: [], ExtraHosts: null, GroupAdd: null,
      IpcMode: "private", Cgroup: "", Links: null, OomScoreAdj: 500, PidMode: "", Privileged: false, PublishAllPorts: false,
      ReadonlyRootfs: strict, SecurityOpt: strict ? ["no-new-privileges"] : null,
      Tmpfs: { "/run": "rw,nosuid,nodev,size=64m,uid=1000,gid=1000,mode=0755", "/tmp": "rw,nosuid,nodev,size=1g" },
      UTSMode: "", UsernsMode: "", ShmSize: 536870912, Runtime: "runsc", Isolation: "", CpuShares: 256, Memory: 4294967296,
      NanoCpus: 2000000000, CgroupParent: "", BlkioWeight: 0, BlkioWeightDevice: [], BlkioDeviceReadBps: [], BlkioDeviceWriteBps: [],
      BlkioDeviceReadIOps: [], BlkioDeviceWriteIOps: [], CpuPeriod: 0, CpuQuota: 0, CpuRealtimePeriod: 0, CpuRealtimeRuntime: 0,
      CpusetCpus: "", CpusetMems: "", Devices: [], DeviceCgroupRules: null, DeviceRequests: null, MemoryReservation: 0,
      MemorySwap: 4294967296, MemorySwappiness: -1, OomKillDisable: false, PidsLimit: 4096, Ulimits: [], CpuCount: 0, CpuPercent: 0,
      IOMaximumIOps: 0, IOMaximumBandwidth: 0,
      Mounts: [{ Type: "volume", Source: `${NAME}-home`, Target: "/home/cua" }], MaskedPaths: null, ReadonlyPaths: null,
    },
    NetworkingConfig: { EndpointsConfig: {} },
  };
  edit(body, body.HostConfig);
  return body;
}

function legacyCua(edit = () => {}) {
  return desktop("free", (body, host) => {
    Object.assign(host, { NetworkMode: "bridge", CapAdd: ["CAP_SETUID", "CAP_SETGID"], Tmpfs: null, Mounts: null, Runtime: "", Dns: null });
    edit(body, host);
  });
}

function probe(kind = "fence", edit = () => {}) {
  const fence = kind === "fence";
  const body = {
    Hostname: "", Domainname: "", User: fence ? "" : "1000:1000", AttachStdin: false, AttachStdout: true, AttachStderr: true, Tty: false,
    OpenStdin: false, StdinOnce: false, Env: null, Cmd: fence ? ["--check"] : ["-o", "addr", "show", "scope", "global"], Image: IMAGE,
    Volumes: {}, WorkingDir: "", Entrypoint: fence ? ["/usr/local/bin/omb-host-fence"] : ["ip"], Labels: {},
    HostConfig: {
      Binds: null, ContainerIDFile: "", LogConfig: { Type: "", Config: {} }, NetworkMode: "host", PortBindings: {},
      RestartPolicy: { Name: "no", MaximumRetryCount: 0 }, AutoRemove: true, VolumeDriver: "", VolumesFrom: null, ConsoleSize: [0, 0],
      CapAdd: fence ? ["CAP_NET_ADMIN"] : null, CapDrop: ["ALL"], CgroupnsMode: "", Dns: null, DnsOptions: [], DnsSearch: [],
      ExtraHosts: null, GroupAdd: null, IpcMode: "", Cgroup: "", Links: null, OomScoreAdj: 0, PidMode: "", Privileged: false,
      PublishAllPorts: false, ReadonlyRootfs: true, SecurityOpt: ["no-new-privileges"], UTSMode: "", UsernsMode: "host", ShmSize: 0,
      Isolation: "", CpuShares: 0, Memory: 0, NanoCpus: 0, CgroupParent: "", BlkioWeight: 0, BlkioWeightDevice: [], Devices: [],
      DeviceCgroupRules: null, DeviceRequests: null, MemorySwappiness: -1, OomKillDisable: false, PidsLimit: 0, Ulimits: [],
      MaskedPaths: null, ReadonlyPaths: null,
    },
    NetworkingConfig: { EndpointsConfig: {} },
  };
  edit(body, body.HostConfig);
  return body;
}

const network = (edit = () => {}) => {
  const body = {
    Name: DOCKER_NAMES.desktopNetwork, Driver: "bridge", Scope: "", IPAM: { Driver: "default", Options: {}, Config: [] }, Internal: false,
    Attachable: false, Ingress: false, ConfigOnly: false, ConfigFrom: null,
    Options: { "com.docker.network.bridge.enable_icc": "false", "com.docker.network.bridge.name": "omb-desk0" },
    Labels: { [DOCKER_NAMES.label("vps-network")]: "1" },
  };
  edit(body);
  return body;
};

const createOk = (body, ctx = { name: NAME }) => expect(() => checkCreate(body, ctx)).not.toThrow();
const createRefused = (body, pattern, ctx = { name: NAME }) => expect(() => checkCreate(body, ctx)).toThrow(pattern);

describe("docker gate container create", () => {
  it("allows the bot desktop in both modes, with and without gVisor, and the legacy Cua desktop", () => {
    createOk(desktop("strict"), { name: NAME, runsc: true });
    createOk(desktop("free"), { name: NAME, runsc: true });
    createOk(desktop("free", (_, host) => { host.Runtime = ""; }), { name: NAME, runsc: false });
    createOk(legacyCua());
    expect(checkCreate(probe("fence"), {})).toEqual({ kind: "probe", image: IMAGE });
    expect(checkCreate(probe("ip"), {})).toEqual({ kind: "probe", image: IMAGE });
  });

  it("refuses privilege and capabilities beyond the box's own", () => {
    createRefused(desktop("strict", (_, host) => { host.Privileged = true; }), /Privileged/);
    createRefused(desktop("strict", (_, host) => { host.CapAdd.push("CAP_SYS_ADMIN"); }), /SYS_ADMIN/);
    createRefused(desktop("strict", (_, host) => { host.CapAdd.push("sys_ptrace"); }), /SYS_PTRACE/);
    createRefused(desktop("strict", (_, host) => { host.CapAdd.push("ALL"); }), /ALL is not allowed/);
    createRefused(desktop("free", (_, host) => { host.CapAdd.push("NET_ADMIN"); }), /NET_ADMIN/);
    createRefused(desktop("free", (_, host) => { host.CapAdd.push("CAP_NET_RAW"); }), /NET_RAW/);
    createRefused(desktop("strict", (_, host) => { host.CapDrop = ["NET_RAW"]; }), /CapDrop must include ALL/);
    createRefused(desktop("strict", (_, host) => { host.CapDrop = null; }), /CapDrop must include ALL/);
    createRefused(desktop("strict", (body) => { delete body.HostConfig; }), /CapDrop/);
  });

  it("refuses host paths, devices and other containers' volumes", () => {
    createRefused(desktop("strict", (_, host) => { host.Binds = ["/:/host"]; }), /Binds/);
    createRefused(desktop("strict", (_, host) => { host.Mounts = [{ Type: "bind", Source: "/", Target: "/home/cua" }]; }), /Mounts/);
    createRefused(desktop("strict", (_, host) => { host.Mounts[0].Source = `${DOCKER_NAMES.vpsPrefix}-other-0123456789ab-home`; }), /Mounts/);
    createRefused(desktop("strict", (_, host) => { host.Mounts[0].Target = "/etc"; }), /Mounts/);
    createRefused(desktop("strict", (_, host) => { host.Mounts.push({ Type: "volume", Source: "x", Target: "/x" }); }), /Mounts/);
    createRefused(desktop("strict", (_, host) => {
      host.Mounts[0].VolumeOptions = { DriverConfig: { Name: "local", Options: { type: "none", o: "bind", device: "/" } } };
    }), /Options is not allowed/);
    createRefused(desktop("strict", (_, host) => { host.Mounts[0].VolumeOptions = { Subpath: "../../" }; }), /Subpath/);
    createRefused(desktop("strict", (_, host) => { host.VolumesFrom = ["other"]; }), /VolumesFrom/);
    createRefused(desktop("strict", (_, host) => { host.Devices = [{ PathOnHost: "/dev/sda", PathInContainer: "/dev/sda", CgroupPermissions: "rwm" }]; }), /Devices/);
    createRefused(desktop("strict", (_, host) => { host.DeviceRequests = [{ Driver: "nvidia", Count: -1 }]; }), /DeviceRequests/);
    createRefused(desktop("strict", (_, host) => { host.DeviceCgroupRules = ["a *:* rwm"]; }), /DeviceCgroupRules/);
    createRefused(desktop("strict", (body) => { body.Volumes = { "/etc": {} }; }), /Volumes/);
    createRefused(desktop("strict", (_, host) => { host.Tmpfs["/etc"] = "rw"; }), /Tmpfs/);
    createRefused(desktop("strict", (_, host) => { host.Tmpfs["/tmp"] = "rw,dev,suid"; }), /Tmpfs/);
    createRefused(desktop("strict", (_, host) => { host.VolumeDriver = "evil"; }), /VolumeDriver/);
    createRefused(desktop("strict", (_, host) => { host.Links = ["db:db"]; }), /Links/);
  });

  it("refuses shared host namespaces and security profile switches", () => {
    createRefused(desktop("strict", (_, host) => { host.NetworkMode = "host"; }), /NetworkMode/);
    createRefused(desktop("strict", (_, host) => { host.NetworkMode = "container:other"; }), /NetworkMode/);
    createRefused(desktop("strict", (_, host) => { host.PidMode = "host"; }), /PidMode/);
    createRefused(desktop("strict", (_, host) => { host.IpcMode = "host"; }), /IpcMode/);
    createRefused(desktop("strict", (_, host) => { host.IpcMode = ""; }), /IpcMode must be private/);
    createRefused(desktop("strict", (_, host) => { host.UTSMode = "host"; }), /UTSMode/);
    createRefused(desktop("strict", (_, host) => { host.UsernsMode = "host"; }), /UsernsMode/);
    createRefused(desktop("strict", (_, host) => { host.CgroupnsMode = "host"; }), /CgroupnsMode/);
    for (const option of ["seccomp=unconfined", "apparmor=unconfined", "label=disable", "systempaths=unconfined", "no-new-privileges:false"]) {
      createRefused(desktop("strict", (_, host) => { host.SecurityOpt.push(option); }), /SecurityOpt/);
    }
    createRefused(desktop("strict", (_, host) => { host.MaskedPaths = []; }), /MaskedPaths/);
    createRefused(desktop("strict", (_, host) => { host.ReadonlyPaths = []; }), /ReadonlyPaths/);
    createRefused(desktop("strict", (_, host) => { host.Sysctls = { "kernel.core_pattern": "|/tmp/x" }; }), /Sysctls/);
    createRefused(desktop("strict", (_, host) => { host.CgroupParent = "/"; }), /CgroupParent/);
    createRefused(desktop("strict", (_, host) => { host.Runtime = "/tmp/evil-runtime"; }), /Runtime/);
    createRefused(desktop("strict", (_, host) => { host.Runtime = "runc"; }), /gVisor/, { name: NAME, runsc: true });
    createRefused(desktop("strict", (_, host) => { host.Annotations = { "dev.gvisor.spec.mount": "x" }; }), /Annotations/);
    createRefused(desktop("strict", (_, host) => { host.GroupAdd = ["docker"]; }), /GroupAdd/);
    createRefused(desktop("strict", (_, host) => { host.CpuRealtimeRuntime = 950000; }), /CpuRealtimeRuntime/);
  });

  it("refuses published ports, unbounded boxes and restart policies", () => {
    createRefused(desktop("strict", (_, host) => { host.PortBindings = { "6901/tcp": [{ HostIp: "0.0.0.0", HostPort: "6901" }] }; }), /published ports/);
    createRefused(desktop("strict", (_, host) => { host.PublishAllPorts = true; }), /PublishAllPorts/);
    createRefused(desktop("strict", (_, host) => { host.OomKillDisable = true; }), /OomKillDisable/);
    createRefused(desktop("strict", (_, host) => { host.PidsLimit = 0; }), /PidsLimit/);
    createRefused(desktop("strict", (_, host) => { host.PidsLimit = -1; }), /PidsLimit/);
    createRefused(desktop("strict", (_, host) => { host.RestartPolicy = { Name: "always" }; }), /RestartPolicy/);
    createRefused(desktop("strict", (_, host) => { host.LogConfig = { Type: "syslog", Config: {} }; }), /LogConfig/);
    createRefused(desktop("strict", (_, host) => { host.OomScoreAdj = -1000; }), /OomScoreAdj/);
    createRefused(desktop("strict", (body) => { body.NetworkingConfig.EndpointsConfig = { bridge: {} }; }), /own network/);
    createRefused(desktop("strict", (body) => {
      body.NetworkingConfig.EndpointsConfig = { [DOCKER_NAMES.desktopNetwork]: { DriverOpts: { "com.docker.network.endpoint.sysctls": "x" } } };
    }), /DriverOpts/);
  });

  it("refuses the ways Go's JSON decoding could see a different config than the gate", () => {
    createRefused(desktop("strict", (body) => { body.hostconfig = { Privileged: true }; }), /given twice/);
    createRefused(desktop("strict", (_, host) => { host.privileged = true; }), /given twice/);
    createRefused(desktop("strict", (body) => { body.Privileged = true; }), /Config.Privileged is not allowed/);
    createRefused(desktop("strict", (body) => { body.Binds = ["/:/host"]; }), /Config.Binds is not allowed/);
    createRefused({ ...desktop("strict"), "ſecurityopt": ["seccomp=unconfined"] }, /does not know/);
    const twice = `{"Image":"x","HostConfig":{"Privileged":true},"HostConfig":{"CapDrop":["ALL"]}}`;
    expect(() => parseJson(twice)).toThrow(/repeats a key/);
    expect(() => parseJson('{"Memory":1.5}')).toThrow(/not JSON/);
    expect(() => parseJson('{"a":1} x')).toThrow(/not JSON/);
    expect(() => parseJson('{"a":"x\ny"}')).toThrow(/not JSON/);
    expect(() => parseJson('{"a":"x\\"}')).toThrow(/not JSON/);
    expect(parseJson('{"a":"q\\"\\\\\\u00e9"}')).toEqual({ a: 'q"\\é' });
    expect(parseJson('{"__proto__":{"x":1},"a":[1,"b",null,true]}')).toEqual(JSON.parse('{"__proto__":{"x":1},"a":[1,"b",null,true]}'));
    expect(Object.getPrototypeOf(parseJson('{"__proto__":{"x":1}}'))).toBe(Object.prototype);
  });

  it("ties labelled containers to a managed name and its own home volume", () => {
    createRefused(desktop("strict"), /must be named/, { name: undefined });
    createRefused(desktop("strict"), /must be named/, { name: "evil" });
    createRefused(desktop("strict", (body) => { body.Labels[DOCKER_NAMES.label("vps")] = "0"; }), /must be 1/);
  });

  it("allows host networking only for the two exact probes", () => {
    const refusedProbe = (body, pattern) => createRefused(body, pattern, {});
    refusedProbe(probe("fence", (body) => { body.Env = ["BASH_ENV=/tmp/x"]; }), /may not set env/);
    refusedProbe(probe("fence", (body) => { body.Cmd = ["--apply"]; }), /one of the two host probes/);
    refusedProbe(probe("ip", (body) => { body.Entrypoint = ["sh"]; body.Cmd = ["-c", "id"]; }), /one of the two host probes/);
    refusedProbe(probe("ip", (body) => { body.Entrypoint = "ip"; }), /one of the two host probes/);
    refusedProbe(probe("ip", (body) => { body.User = ""; }), /wrong user/);
    refusedProbe(probe("fence", (body) => { body.Healthcheck = { Test: ["CMD", "iptables", "-F"] }; }), /Healthcheck|healthcheck/);
    refusedProbe(probe("fence", (body) => { body.WorkingDir = "/tmp"; }), /workingdir/);
    refusedProbe(probe("fence", (_, host) => { host.CapAdd.push("CAP_SYS_ADMIN"); }), /wrong capabilities/);
    refusedProbe(probe("ip", (_, host) => { host.CapAdd = ["CAP_NET_ADMIN"]; }), /wrong capabilities/);
    refusedProbe(probe("fence", (_, host) => { host.Binds = ["/:/host"]; }), /Binds/);
    refusedProbe(probe("fence", (_, host) => { host.Tmpfs = { "/tmp": "" }; }), /tmpfs/);
    refusedProbe(probe("fence", (_, host) => { host.PidMode = "host"; }), /PidMode/);
    refusedProbe(probe("fence", (_, host) => { host.ReadonlyRootfs = false; }), /read-only/);
    refusedProbe(probe("fence", (_, host) => { host.AutoRemove = false; }), /removed on exit/);
    refusedProbe(probe("fence", (_, host) => { host.SecurityOpt = []; }), /without new privileges/);
    refusedProbe(probe("fence", (_, host) => { host.Runtime = "runc"; }), /runtime/);
    refusedProbe(probe("fence", (body) => { body.Image = "ghcr.io/sidddevz/omb-bot-desktop:v3"; }), /by id/);
    refusedProbe(probe("fence", (body) => { body.Labels = { other: "x" }; }), /labels/);
    createRefused(probe("fence"), /may not be named/, { name: "probe" });
    createRefused(desktop("strict", (_, host) => { host.NetworkMode = "host"; host.UsernsMode = "host"; }), /UsernsMode|NetworkMode/);
  });
});

describe("docker gate exec, update, network and pull rules", () => {
  it("allows any exec inside the box but never a privileged one", () => {
    const exec = { User: "cua", Privileged: false, Tty: false, AttachStdin: true, AttachStderr: true, AttachStdout: true, DetachKeys: "", Env: ["HOME=/home/cua"], WorkingDir: "", Cmd: ["cat"] };
    expect(() => checkExec(exec)).not.toThrow();
    expect(() => checkExec({ ...exec, User: "0" })).not.toThrow();
    expect(() => checkExec({ ...exec, Privileged: true })).toThrow(/Privileged/);
    expect(() => checkExec({ ...exec, privileged: true })).toThrow(/given twice/);
    expect(() => checkExec({ Cmd: ["sh"], PRIVILEGED: true })).toThrow(/Privileged/);
  });

  it("allows only the desktop's resource updates", () => {
    const update = { CpuShares: 256, Memory: 4294967296, NanoCpus: 0, CgroupParent: "", BlkioWeight: 0, Devices: null, MemorySwap: 4294967296, MemorySwappiness: null, OomKillDisable: null, PidsLimit: null, Ulimits: null, RestartPolicy: { Name: "no", MaximumRetryCount: 0 } };
    expect(() => checkUpdate(update)).not.toThrow();
    expect(() => checkUpdate({ ...update, PidsLimit: 4096, RestartPolicy: { Name: "", MaximumRetryCount: 0 } })).not.toThrow();
    expect(() => checkUpdate({ ...update, PidsLimit: 0 })).toThrow(/PidsLimit/);
    expect(() => checkUpdate({ ...update, RestartPolicy: { Name: "always" } })).toThrow(/RestartPolicy/);
    expect(() => checkUpdate({ ...update, Devices: [{ PathOnHost: "/dev/sda" }] })).toThrow(/Devices/);
    expect(() => checkUpdate({ ...update, CpuRealtimeRuntime: 1 })).toThrow(/CpuRealtimeRuntime/);
  });

  it("allows only the desktops' bridge network", () => {
    expect(() => checkNetworkCreate(network())).not.toThrow();
    expect(() => checkNetworkCreate(network((body) => { body.Name = "other"; }))).toThrow(/Name/);
    expect(() => checkNetworkCreate(network((body) => { body.Driver = "macvlan"; }))).toThrow(/Driver/);
    expect(() => checkNetworkCreate(network((body) => { body.Internal = true; }))).toThrow(/Internal/);
    expect(() => checkNetworkCreate(network((body) => { body.Attachable = true; }))).toThrow(/Attachable/);
    expect(() => checkNetworkCreate(network((body) => { body.ConfigFrom = { Network: "x" }; }))).toThrow(/ConfigFrom/);
    expect(() => checkNetworkCreate(network((body) => { body.IPAM.Config = [{ Subnet: "10.0.0.0/8" }]; }))).toThrow(/IPAM/);
    expect(() => checkNetworkCreate(network((body) => { body.Options["com.docker.network.bridge.gateway_mode_ipv4"] = "routed"; }))).toThrow(/options/);
    expect(() => checkNetworkCreate(network((body) => { body.Options["com.docker.network.bridge.name"] = "eth0"; }))).toThrow(/options/);
    expect(() => checkNetworkCreate(network((body) => { body.Labels.extra = "1"; }))).toThrow(/label/);
  });

  it("normalises image references like docker", () => {
    expect(parseImageRef("trycua/xfce-cua")?.repository).toBe("docker.io/trycua/xfce-cua");
    expect(parseImageRef("docker.io/trycua/xfce-cua@sha256:" + "a".repeat(64))?.repository).toBe("docker.io/trycua/xfce-cua");
    expect(parseImageRef("index.docker.io/trycua/xfce-cua:latest")?.repository).toBe("docker.io/trycua/xfce-cua");
    expect(parseImageRef("ubuntu")?.repository).toBe("docker.io/library/ubuntu");
    expect(parseImageRef("localhost:5000/omb:1")?.repository).toBe("localhost:5000/omb");
    expect(parseImageRef("GHCR.io/sidddevz/omb-bot-desktop")).toBeNull();
    expect(parseImageRef("ghcr.io/sidddevz/../x")).toBeNull();
  });
});

function fakeContext(containers = {}) {
  return {
    pull: new Set(["ghcr.io/sidddevz/omb-bot-desktop", "docker.io/trycua/xfce-cua"]),
    probes: new Tracker(),
    execs: new Tracker(),
    lookups: [],
    async runsc() { return false; },
    async inspectImage(ref) {
      return ref === IMAGE ? { status: 200, json: { Id: IMAGE, Config: { Labels: { [DOCKER_NAMES.label("bot-desktop")]: "3" } } } } : { status: 404, json: { message: "No such image" } };
    },
    async inspectContainer(ref) {
      this.lookups.push(ref);
      const found = containers[ref];
      return found ? { status: 200, json: found } : { status: 404, json: { message: `No such container: ${ref}` } };
    },
  };
}

const own = { Id: CID, Config: { Labels: { [DOCKER_NAMES.label("vps")]: "1" } }, HostConfig: { CapDrop: ["ALL"], CapAdd: ["CAP_SETUID", "CAP_SETGID"], MaskedPaths: ["/proc/kcore"] }, Mounts: [] };
const foreign = { Id: "b".repeat(64), Config: { Labels: {} }, HostConfig: { CapDrop: ["ALL"] }, Mounts: [] };
const tainted = { Id: "a".repeat(64), Config: { Labels: { [DOCKER_NAMES.label("vps")]: "1" } }, HostConfig: { Privileged: true }, Mounts: [{ Type: "bind" }] };
const json = (value) => Buffer.from(JSON.stringify(value));

describe("docker gate routing", () => {
  it("allows the read-only endpoints, versioned or not, and refuses old API versions", async () => {
    const ctx = fakeContext();
    for (const [method, target] of [
      ["HEAD", "/_ping"], ["GET", "/_ping"], ["GET", "/v1.47/version"], ["GET", "/info"], ["GET", `/v1.47/containers/json?all=1&filters=${encodeURIComponent(JSON.stringify({ label: [DOCKER_NAMES.label("vps") + "=1"] }))}`],
      ["GET", "/v1.47/images/json"], ["GET", "/v1.47/images/ghcr.io/sidddevz/omb-bot-desktop:v3/json"], ["GET", `/v1.47/images/${IMAGE}/json`],
      ["GET", `/v1.47/networks/${DOCKER_NAMES.desktopNetwork}`], ["GET", "/v1.47/networks?filters=%7B%7D"], ["GET", "/v1.47/system/df"], ["GET", "/v1.47/events?since=1"],
      ["GET", "/v1.47/volumes/x-home"], ["GET", "/v1.47/plugins/x/json"],
    ]) {
      expect(await decide(method, target, null, ctx), `${method} ${target}`).toMatchObject({ allow: true, target });
    }
    expect(await decide("GET", "/v1.23/version", null, ctx)).toMatchObject({ allow: false, status: 403 });
    expect(await decide("GET", "/v2.1/version", null, ctx)).toMatchObject({ allow: false });
  });

  it("refuses everything that builds, imports, exports or reaches beyond containers", async () => {
    const ctx = fakeContext({ [NAME]: own });
    for (const [method, target] of [
      ["POST", "/v1.47/build"], ["POST", "/grpc"], ["POST", "/session"], ["POST", "/v1.47/images/load"], ["POST", "/v1.47/images/x/tag?repo=y"],
      ["POST", "/v1.47/images/x/push"], ["POST", `/v1.47/commit?container=${NAME}`], ["DELETE", "/v1.47/images/x"], ["POST", "/v1.47/images/prune"],
      ["PUT", `/v1.47/containers/${NAME}/archive?path=/`], ["GET", `/v1.47/containers/${NAME}/archive?path=/`], ["GET", `/v1.47/containers/${NAME}/export`],
      ["POST", `/v1.47/containers/${NAME}/rename?name=x`], ["POST", "/v1.47/containers/prune"], ["POST", "/v1.47/plugins/pull?remote=x"],
      ["POST", "/v1.47/swarm/init"], ["POST", "/v1.47/services/create"], ["POST", "/v1.47/secrets/create"], ["POST", "/v1.47/configs/create"],
      ["POST", "/v1.47/volumes/create"], ["DELETE", "/v1.47/volumes/x-home"], ["POST", "/v1.47/networks/x/connect"], ["DELETE", "/v1.47/networks/x"],
      ["POST", "/v1.47/auth"], ["GET", "/v1.47/distribution/x/json"], ["GET", `/v1.47/containers/${NAME}/changes`],
    ]) {
      expect(await decide(method, target, null, ctx), `${method} ${target}`).toMatchObject({ allow: false, status: 403 });
    }
  });

  it("refuses ambiguous paths and query strings", async () => {
    const ctx = fakeContext({ [NAME]: own });
    for (const target of [
      "/containers/../build", "/v1.47/containers/x%2F..%2F..%2Fbuild/start", "//_ping", "/v1.47/containers//start", "/_ping/", "/v1.47/./_ping",
      `/v1.47/containers/${NAME}/stop?t=1&t=2`, `/v1.47/containers/${NAME}/stop?t=1;signal=KILL`, "/v1.47/images/create?fromImage=ghcr.io%2Fsidddevz%2Fomb-bot-desktop&fromSrc=-",
      `/v1.47/containers/${NAME}/top?ps_args=aux`, `/v1.47/containers/${NAME}?force=1&link=1`,
    ]) {
      expect(await decide(target.includes("stop") || target.includes("images") ? "POST" : target.includes("force") ? "DELETE" : "GET", target, null, ctx), target)
        .toMatchObject({ allow: false });
    }
  });

  it("pulls only allow-listed repositories, never imports, and never takes a body", async () => {
    const ctx = fakeContext();
    const pull = (query, body = null) => decide("POST", `/v1.47/images/create?${query}`, body, ctx);
    expect(await pull("fromImage=ghcr.io%2Fsidddevz%2Fomb-bot-desktop&tag=v3")).toMatchObject({ allow: true });
    expect(await pull(`fromImage=docker.io%2Ftrycua%2Fxfce-cua&tag=sha256%3A${"a".repeat(64)}`)).toMatchObject({ allow: true });
    expect(await pull("fromImage=trycua%2Fxfce-cua&tag=latest")).toMatchObject({ allow: true });
    expect(await pull("fromImage=ubuntu&tag=latest")).toMatchObject({ allow: false });
    expect(await pull("fromImage=ghcr.io%2Fsidddevz%2Fevil&tag=v3")).toMatchObject({ allow: false });
    expect(await pull("fromImage=evil.io%2Fsidddevz%2Fomb-bot-desktop")).toMatchObject({ allow: false });
    expect(await pull("fromSrc=-&repo=x")).toMatchObject({ allow: false });
    // Go's ParseForm reads a urlencoded body over the query string
    expect(await pull("fromImage=ghcr.io%2Fsidddevz%2Fomb-bot-desktop", Buffer.from("fromImage=evil%2Fimage"))).toMatchObject({ allow: false, message: /no body/ });
  });

  it("creates desktops, requires runsc when the host has it, and checks the probe image upstream", async () => {
    const ctx = fakeContext();
    expect(await decide("POST", `/v1.47/containers/create?name=${NAME}`, json(desktop("strict")), ctx)).toMatchObject({ allow: true, json: true });
    ctx.runsc = async () => true;
    expect(await decide("POST", `/v1.47/containers/create?name=${NAME}`, json(legacyCua()), ctx)).toMatchObject({ allow: false, message: /gVisor/ });
    const verdict = await decide("POST", "/v1.47/containers/create", json(probe("fence")), ctx);
    expect(verdict).toMatchObject({ allow: true });
    verdict.capture(PROBE_ID);
    expect(ctx.probes.get(PROBE_ID)).toBe(true);
    expect(await decide("POST", "/v1.47/containers/create", json(probe("ip", (body) => { body.Image = `sha256:${"0".repeat(64)}`; })), ctx))
      .toMatchObject({ allow: false, message: /bot desktop image/ });
    expect(await decide("POST", `/v1.47/containers/create?name=${NAME}&privileged=1`, json(desktop("strict")), ctx)).toMatchObject({ allow: false });
  });

  it("acts on labelled containers by id, on this gate's probes, and on nothing else", async () => {
    const ctx = fakeContext({ [NAME]: own, foreign, tainted });
    expect(await decide("POST", `/v1.47/containers/${NAME}/start`, null, ctx)).toMatchObject({ allow: true, target: `/v1.47/containers/${CID}/start` });
    expect(await decide("POST", `/v1.47/containers/${NAME}/stop?t=10`, null, ctx)).toMatchObject({ allow: true, target: `/v1.47/containers/${CID}/stop?t=10` });
    expect(await decide("DELETE", `/v1.47/containers/${NAME}?force=1`, null, ctx)).toMatchObject({ allow: true, target: `/v1.47/containers/${CID}?force=1` });
    expect(await decide("POST", `/v1.47/containers/${NAME}/attach?stream=1&stdout=1`, null, ctx)).toMatchObject({ allow: true, hijack: true });
    expect(await decide("POST", `/v1.47/containers/${NAME}/start`, json({ Privileged: true, Binds: ["/:/host"] }), ctx)).toMatchObject({ allow: false, message: /no body/ });
    expect(await decide("POST", "/v1.47/containers/foreign/start", null, ctx)).toMatchObject({ allow: false, status: 403 });
    expect(await decide("GET", "/v1.47/containers/foreign/json", null, ctx)).toMatchObject({ allow: false, status: 403 });
    expect(await decide("DELETE", "/v1.47/containers/foreign?force=1", null, ctx)).toMatchObject({ allow: false, status: 403 });
    expect(await decide("GET", "/v1.47/containers/missing/json", null, ctx)).toEqual({ allow: false, status: 404, message: "No such container: missing" });
    expect(await decide("POST", "/v1.47/containers/tainted/exec", json({ Cmd: ["sh"] }), ctx)).toMatchObject({ allow: false, message: /safe flags/ });
    expect(await decide("DELETE", "/v1.47/containers/tainted?force=1", null, ctx)).toMatchObject({ allow: true });
    expect(await decide("POST", `/v1.47/containers/${PROBE_ID}/wait?condition=removed`, null, ctx)).toMatchObject({ allow: false, status: 404 });
    ctx.probes.add(PROBE_ID, true);
    const before = ctx.lookups.length;
    expect(await decide("POST", `/v1.47/containers/${PROBE_ID}/attach?stderr=1&stdout=1&stream=1`, null, ctx)).toMatchObject({ allow: true, hijack: true });
    expect(await decide("POST", `/v1.47/containers/${PROBE_ID}/wait?condition=removed`, null, ctx)).toMatchObject({ allow: true });
    expect(await decide("POST", `/v1.47/containers/${PROBE_ID}/start`, null, ctx)).toMatchObject({ allow: true });
    expect(ctx.lookups.length).toBe(before);
    expect(await decide("POST", `/v1.47/containers/${PROBE_ID}/exec`, json({ Cmd: ["iptables", "-F"] }), ctx)).toMatchObject({ allow: false, status: 404 });
  });

  it("renames a bot computer only to its own set-aside name and back", async () => {
    const previous = `${NAME}-previous`;
    const other = `${DOCKER_NAMES.vpsPrefix}-xyz-ba9876543210`;
    const ctx = fakeContext({ [NAME]: { ...own, Name: `/${NAME}` }, [previous]: { ...own, Name: `/${previous}` }, foreign: { ...foreign, Name: `/${other}` } });
    expect(await decide("POST", `/v1.47/containers/${NAME}/rename?name=${previous}`, null, ctx)).toMatchObject({ allow: true, target: `/v1.47/containers/${CID}/rename?name=${previous}` });
    expect(await decide("POST", `/v1.47/containers/${previous}/rename?name=${NAME}`, null, ctx)).toMatchObject({ allow: true });
    expect(await decide("POST", `/v1.47/containers/${NAME}/rename?name=${other}`, null, ctx)).toMatchObject({ allow: false, message: /own name/ });
    expect(await decide("POST", `/v1.47/containers/${NAME}/rename?name=${other}-previous`, null, ctx)).toMatchObject({ allow: false });
    expect(await decide("POST", `/v1.47/containers/${NAME}/rename?name=${NAME}`, null, ctx)).toMatchObject({ allow: false });
    expect(await decide("POST", `/v1.47/containers/${NAME}/rename?name=web`, null, ctx)).toMatchObject({ allow: false });
    expect(await decide("POST", `/v1.47/containers/${NAME}/rename`, null, ctx)).toMatchObject({ allow: false });
    expect(await decide("POST", `/v1.47/containers/${NAME}/rename?name=${previous}&force=1`, null, ctx)).toMatchObject({ allow: false });
    expect(await decide("POST", `/v1.47/containers/foreign/rename?name=${other}-previous`, null, ctx)).toMatchObject({ allow: false, status: 403 });
  });

  it("limits updates and execs, and starts only execs it saw created", async () => {
    const ctx = fakeContext({ [NAME]: own });
    expect(await decide("POST", `/v1.47/containers/${NAME}/update`, json({ Memory: 1, RestartPolicy: { Name: "no" } }), ctx)).toMatchObject({ allow: true });
    expect(await decide("POST", `/v1.47/containers/${NAME}/update`, json({ RestartPolicy: { Name: "always" } }), ctx)).toMatchObject({ allow: false });
    expect(await decide("POST", `/v1.47/containers/${NAME}/exec`, json({ Cmd: ["sh"], Privileged: true }), ctx)).toMatchObject({ allow: false });
    const exec = await decide("POST", `/v1.47/containers/${NAME}/exec`, json({ User: "cua", Cmd: ["cat"], AttachStdin: true }), ctx);
    expect(exec).toMatchObject({ allow: true, target: `/v1.47/containers/${CID}/exec` });
    expect(await decide("POST", `/v1.47/exec/${EID}/start`, json({ Detach: false, Tty: false }), ctx)).toMatchObject({ allow: false });
    exec.capture(EID);
    expect(await decide("POST", `/v1.47/exec/${EID}/start`, json({ Detach: false, Tty: false }), ctx)).toMatchObject({ allow: true, hijack: true });
    expect(await decide("POST", `/v1.47/exec/${EID}/start`, json({ Detach: true }), ctx)).toMatchObject({ allow: true, hijack: false });
    expect(await decide("POST", `/v1.47/exec/${EID}/resize?h=10&w=20`, null, ctx)).toMatchObject({ allow: true });
    expect(await decide("GET", `/v1.47/exec/${EID}/json`, null, ctx)).toMatchObject({ allow: true });
    expect(await decide("GET", `/v1.47/exec/${"9".repeat(64)}/json`, null, ctx)).toMatchObject({ allow: false });
  });

  it("forgets probes and execs after their time and when full", () => {
    let now = 0;
    const tracker = new Tracker(1000, 2, () => now);
    tracker.add("a", 1);
    tracker.add("b", 2);
    tracker.add("c", 3);
    expect([tracker.get("a"), tracker.get("b"), tracker.get("c")]).toEqual([undefined, 2, 3]);
    now = 1000;
    expect(tracker.get("b")).toBeUndefined();
  });

  it("keeps its capability lists and names in step with the server", async () => {
    const source = await readFile(new URL("../../../server/bot-desktop.ts", import.meta.url), "utf8");
    const listed = (name) => JSON.parse(new RegExp(`export const ${name} = (\\[[^\\]]*\\])`).exec(source)[1].replace(/,\s*\]/, "]"));
    expect(listed("FREE_CAPABILITIES")).toEqual(FREE_CAPABILITIES);
    expect(listed("STRICT_CAPABILITIES")).toEqual(STRICT_CAPABILITIES);
    for (const [constant, value] of [["BOT_DESKTOP_LABEL", DOCKER_NAMES.label("bot-desktop")], ["BOT_DESKTOP_NETWORK", DOCKER_NAMES.desktopNetwork], ["BOT_DESKTOP_NETWORK_LABEL", DOCKER_NAMES.label("vps-network")], ["BOT_DESKTOP_BRIDGE", "omb-desk0"], ["BOT_DESKTOP_HOME", "/home/cua"]]) {
      expect(sharedDesktop[constant]).toBe(value);
    }
    expect(managedNames.VPS_MANAGED_LABEL).toBe(DOCKER_NAMES.label("vps"));
    expect(managedNames.VPS_CONTAINER_LABEL).toBe(DOCKER_NAMES.label("container"));
    expect(managedNames.MANAGED_VPS_CONTAINER_NAME.source).toBe(`^${DOCKER_NAMES.vpsPrefix}-[a-z0-9]{1,12}-[a-f0-9]{12}$`);
  });
});

const respond = (status, body, extra = "") => {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return `HTTP/1.1 ${status} X\r\nContent-Type: application/json\r\n${extra}Content-Length: ${Buffer.byteLength(text)}\r\n\r\n${text}`;
};
const VERSION_CHUNKED = 'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n9\r\n{"Version\r\n7\r\n":"29"}\r\n0\r\n\r\n';
const NETWORK_CREATED = respond(201, { Id: "9".repeat(64), Warning: "" });

/** A docker stand-in on a unix socket: records every request it gets and answers from `routes`. */
async function fakeDocker(path) {
  const received = [];
  const streams = [];
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    let buffer = Buffer.alloc(0);
    let raw = null;
    socket.on("data", (chunk) => {
      if (raw) return raw(chunk);
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        const end = buffer.indexOf("\r\n\r\n");
        if (end < 0) return;
        const head = buffer.subarray(0, end).toString("latin1");
        const length = Number(/\r\ncontent-length: (\d+)/i.exec(head)?.[1] ?? 0);
        if (buffer.length < end + 4 + length) return;
        const request = { head, raw: buffer.subarray(0, end + 4 + length).toString("latin1"), body: buffer.subarray(end + 4, end + 4 + length).toString() };
        const [method, target] = head.split(" ");
        Object.assign(request, { method, target });
        buffer = buffer.subarray(end + 4 + length);
        received.push(request);
        if (method === "POST" && /^\/v1\.47\/exec\/e+\/start$/.test(target)) {
          const stream = { in: "", ended: false };
          streams.push(stream);
          socket.write("HTTP/1.1 101 UPGRADED\r\nContent-Type: application/vnd.docker.raw-stream\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n");
          raw = (data) => {
            stream.in += data.toString();
            socket.write(data.toString().toUpperCase());
          };
          socket.on("end", () => {
            stream.ended = true;
            socket.end("bye after stdin closed");
          });
          if (buffer.length) raw(buffer);
          return;
        }
        const answer = route(method, target);
        if (answer === null) return socket.destroy();
        socket.write(answer);
      }
    });
    socket.on("error", () => {});
  });
  const route = (method, target) => {
    if (target === "/v1.56/images/ghcr.io/madanibotai/madani-desktop:v6/json") return null;
    if (target === "/info") return respond(200, { Runtimes: { runc: {} } });
    if (target === "/_ping" || target === "/v1.47/_ping") return `HTTP/1.1 200 OK\r\nApi-Version: 1.47\r\nContent-Type: text/plain\r\nContent-Length: 2\r\n\r\n${method === "HEAD" ? "" : "OK"}`;
    if (target === "/v1.47/version") return VERSION_CHUNKED;
    if (target === "/v1.47/networks/create") return NETWORK_CREATED;
    if (target === `/containers/${NAME}/json`) return respond(200, own);
    if (target === `/v1.47/containers/${CID}/exec`) return respond(201, { Id: EID });
    if (method === "GET" && target.startsWith("/containers/")) return respond(404, { message: "No such container: x" });
    return respond(500, { message: "fake docker: unexpected request" });
  };
  await new Promise((resolve) => server.listen(path, resolve));
  return { received, streams, close: () => new Promise((resolve) => { server.close(resolve); server.emit("close"); }) };
}

/** A raw HTTP/1.1 client: the test writes exact bytes and reads exact responses. */
async function client(path) {
  const socket = connect({ path, allowHalfOpen: true });
  await once(socket, "connect");
  let buffer = Buffer.alloc(0), ended = false;
  const waiters = [];
  const wake = () => waiters.splice(0).forEach((resolve) => resolve());
  socket.on("data", (chunk) => { buffer = Buffer.concat([buffer, chunk]); wake(); });
  socket.on("end", () => { ended = true; wake(); });
  const until = async (read) => {
    for (;;) {
      const value = read();
      if (value !== undefined) return value;
      if (ended) throw new Error(`connection ended with ${JSON.stringify(buffer.toString())}`);
      await new Promise((resolve) => waiters.push(resolve));
    }
  };
  return {
    socket,
    send: (text) => socket.write(text),
    response: ({ head: headOnly = false } = {}) => until(() => {
      const text = buffer.toString("latin1");
      const end = text.indexOf("\r\n\r\n");
      if (end < 0) return undefined;
      const head = text.slice(0, end);
      let size = end + 4;
      const length = /\r\ncontent-length: (\d+)/i.exec(head);
      if (headOnly) {
        // a HEAD answer carries Content-Length but no body
      } else if (length) {
        size += Number(length[1]);
        if (text.length < size) return undefined;
      } else if (/\r\ntransfer-encoding: chunked/i.test(head)) {
        const last = text.indexOf("\r\n0\r\n\r\n", end);
        if (last < 0) return undefined;
        size = last + 7;
      }
      buffer = buffer.subarray(size);
      return { status: Number(head.split(" ")[1]), raw: text.slice(0, size), body: text.slice(end + 4, size) };
    }),
    received: (expected) => until(() => (buffer.toString().includes(expected) ? buffer.toString() : undefined)),
    ended: () => until(() => (ended ? buffer.toString() : undefined)),
  };
}

describe("docker gate self-check", () => {
  it("asks systemd for a restart only after three of its own pings in a row went unanswered", () => {
    const check = new SelfCheck();
    expect([false, false].map((answered) => check.record(answered))).toEqual([false, false]);
    expect(check.record(true)).toBe(false);
    expect([false, false, false].map((answered) => check.record(answered))).toEqual([false, false, true]);
  });
});

describe("docker gate over unix sockets", () => {
  let dir, docker, gate, logs;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "omb-gate-"));
    docker = await fakeDocker(join(dir, "docker.sock"));
    logs = [];
    gate = await startGate({ listen: join(dir, "gate.sock"), upstream: join(dir, "docker.sock"), log: (line) => logs.push(line) });
  });

  afterEach(async () => {
    await gate.close();
    await docker.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("answers 502 instead of a bare EOF when docker drops the connection, and says so in its log", async () => {
    const http = await client(join(dir, "gate.sock"));
    http.send("GET /v1.56/images/ghcr.io/madanibotai/madani-desktop:v6/json HTTP/1.1\r\nHost: api.moby.localhost\r\n\r\n");
    const answer = await http.response();
    expect(answer.status).toBe(502);
    expect(JSON.parse(answer.body).message).toBe("docker gate: docker closed the connection before answering; try again");
    expect(logs.join("\n")).toContain("docker closed the connection before answering");
    await http.ended();
  });

  it("closes a connection that sends no request for its idle time, and answers its own health ping", async () => {
    const idle = await startGate({ listen: join(dir, "idle.sock"), upstream: join(dir, "docker.sock"), log: () => {}, idleMs: 50 });
    try {
      const http = await client(join(dir, "idle.sock"));
      await http.ended();
      expect(await pingGate(join(dir, "idle.sock"), 2_000)).toBe(true);
    } finally {
      await idle.close();
    }
    expect(await pingGate(join(dir, "idle.sock"), 500)).toBe(false);
  });

  it("listens on a 0660 socket", async () => {
    expect((await stat(join(dir, "gate.sock"))).mode & 0o777).toBe(0o660);
  });

  it("forwards an allowed request byte for byte and relays the answer unchanged", async () => {
    const body = JSON.stringify(network());
    const request = `POST /v1.47/networks/create HTTP/1.1\r\nHost: api.moby.localhost\r\nUser-Agent: Docker-Client/29.7.2 (linux)\r\nContent-Length: ${body.length}\r\nContent-Type: application/json\r\n\r\n${body}`;
    const http = await client(join(dir, "gate.sock"));
    http.send(request);
    const answer = await http.response();
    expect(answer.raw).toBe(NETWORK_CREATED);
    expect(docker.received.map((entry) => entry.raw)).toEqual([request]);
  });

  it("answers a refused request 403 with a docker error and never forwards it, then keeps serving", async () => {
    const body = JSON.stringify(desktop("strict", (_, host) => { host.Privileged = true; }));
    const http = await client(join(dir, "gate.sock"));
    http.send(`POST /v1.47/containers/create?name=${NAME} HTTP/1.1\r\nHost: docker\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\n\r\n${body}`);
    const refused = await http.response();
    expect(refused.status).toBe(403);
    expect(JSON.parse(refused.body)).toEqual({ message: "docker gate: HostConfig.Privileged is not allowed" });
    expect(docker.received.some((entry) => entry.target.includes("/containers/create"))).toBe(false);
    expect(logs).toEqual([`docker gate: refused POST /v1.47/containers/create: HostConfig.Privileged is not allowed`]);
    expect(logs.join("")).not.toContain("Privileged\":true");
    http.send("GET /_ping HTTP/1.1\r\nHost: docker\r\n\r\n");
    expect((await http.response()).body).toBe("OK");
  });

  it("serves two requests on one keep-alive connection, relaying a chunked answer", async () => {
    const http = await client(join(dir, "gate.sock"));
    http.send("HEAD /_ping HTTP/1.1\r\nHost: docker\r\n\r\n");
    const ping = await http.response({ head: true });
    expect(ping.status).toBe(200);
    http.send("GET /v1.47/version HTTP/1.1\r\nHost: docker\r\n\r\n");
    const version = await http.response();
    expect(version.raw).toBe(VERSION_CHUNKED);
    expect(docker.received.map((entry) => `${entry.method} ${entry.target}`)).toEqual(["HEAD /_ping", "GET /v1.47/version"]);
  });

  it("decodes a chunked request body and forwards it with a Content-Length", async () => {
    const body = JSON.stringify(network());
    const parts = [body.slice(0, 10), body.slice(10, 200), body.slice(200)];
    const http = await client(join(dir, "gate.sock"));
    http.send(`POST /v1.47/networks/create HTTP/1.1\r\nHost: docker\r\nTransfer-Encoding: chunked\r\nContent-Type: application/json\r\n\r\n`);
    for (const part of parts) http.send(`${part.length.toString(16)}\r\n${part}\r\n`);
    http.send("0\r\n\r\n");
    expect((await http.response()).status).toBe(201);
    const [forwarded] = docker.received;
    expect(forwarded.body).toBe(body);
    expect(forwarded.head).toContain(`\r\nContent-Length: ${body.length}`);
    expect(forwarded.head.toLowerCase()).not.toContain("transfer-encoding");
  });

  it("refuses request smuggling shapes and oversized bodies", async () => {
    const smuggle = await client(join(dir, "gate.sock"));
    smuggle.send("POST /v1.47/networks/create HTTP/1.1\r\nHost: docker\r\nContent-Length: 4\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n");
    expect((await smuggle.response()).status).toBe(400);
    const large = await client(join(dir, "gate.sock"));
    large.send(`POST /v1.47/containers/create HTTP/1.1\r\nHost: docker\r\nContent-Length: ${2 * 1024 * 1024}\r\n\r\n`);
    expect((await large.response()).status).toBe(413);
    await large.ended();
    expect(docker.received).toEqual([]);
  });

  it("resolves an exec target to its id, then pipes the upgraded stream both ways with half-close", async () => {
    const http = await client(join(dir, "gate.sock"));
    const exec = JSON.stringify({ User: "cua", Privileged: false, Tty: false, AttachStdin: true, AttachStderr: true, AttachStdout: true, DetachKeys: "", Env: null, WorkingDir: "", Cmd: ["cat"] });
    http.send(`POST /v1.47/containers/${NAME}/exec HTTP/1.1\r\nHost: docker\r\nContent-Length: ${exec.length}\r\nContent-Type: application/json\r\n\r\n${exec}`);
    expect(JSON.parse((await http.response()).body)).toEqual({ Id: EID });
    expect(docker.received.map((entry) => entry.target)).toEqual([`/containers/${NAME}/json`, `/v1.47/containers/${CID}/exec`]);

    const start = '{"Detach":false,"Tty":false}';
    http.send(`POST /v1.47/exec/${EID}/start HTTP/1.1\r\nHost: docker\r\nContent-Length: ${start.length}\r\nConnection: Upgrade\r\nContent-Type: application/json\r\nUpgrade: tcp\r\n\r\n${start}`);
    expect((await http.response()).status).toBe(101);
    expect(docker.received.at(-1).head).toContain("\r\nConnection: Upgrade\r\n");
    expect(docker.received.at(-1).body).toBe(start);
    http.send("hello");
    await http.received("HELLO");
    http.socket.end();
    expect(await http.ended()).toBe("HELLObye after stdin closed");
    expect(docker.streams).toEqual([{ in: "hello", ended: true }]);
  });

  it("never starts an exec it did not see created", async () => {
    const http = await client(join(dir, "gate.sock"));
    const start = '{"Detach":false,"Tty":false}';
    http.send(`POST /v1.47/exec/${EID}/start HTTP/1.1\r\nHost: docker\r\nContent-Length: ${start.length}\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n${start}`);
    expect((await http.response()).status).toBe(403);
    expect(docker.received).toEqual([]);
  });
});
