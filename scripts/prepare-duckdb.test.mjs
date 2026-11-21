import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { checkNativeMachine, dataChannelPlatformPackage, installedPackage, pinnedDataChannelVersion, pinnedDuckdbVersion, pinnedOnePasswordVersion, pinnedResvgVersion, platformPackage, resvgPlatformPackage, stageDuckdb, stageOnnxRuntime, targetsFor, verifyDuckdbTree } from "./prepare-duckdb.mjs";

const PIN = "9.9.9-r.9";
const RESVG_PIN = "8.8.8";
const OP_PIN = "7.7.7";
const DC_PIN = "6.6.6";

/** Just enough of an ELF header for the check: the magic and e_machine (62 x86-64, 183 aarch64). */
function elf(machine) {
  const header = Buffer.alloc(64);
  header.writeUInt32BE(0x7f454c46, 0);
  header.writeUInt16LE(machine, 18);
  return header;
}

/** A thin 64-bit Mach-O header: the magic and cputype (0x0100000c arm64, 0x01000007 x86_64). */
function macho(cputype) {
  const header = Buffer.alloc(64);
  header.writeUInt32LE(0xfeedfacf, 0);
  header.writeUInt32LE(cputype, 4);
  return header;
}

/** "MZ", e_lfanew at 0x3c, then "PE\0\0" and the COFF machine (0x8664 x64). */
function pe(machine) {
  const header = Buffer.alloc(256);
  header.write("MZ", 0, "latin1");
  header.writeUInt32LE(0x80, 0x3c);
  header.writeUInt32BE(0x50450000, 0x80);
  header.writeUInt16LE(machine, 0x84);
  return header;
}

const HEADERS = { elf, macho, pe };
function addon({ format, machine }) {
  return HEADERS[format](machine);
}
const temporaryDirectories = [];

function temporary(prefix) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

function writePackage(directory, name, version, files, scope = "@duckdb", extra = {}) {
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "package.json"), JSON.stringify({ name: scope ? `${scope}/${name}` : name, version, ...extra }));
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(directory, file)), { recursive: true });
    if (Buffer.isBuffer(content)) fs.writeFileSync(path.join(directory, file), content);
    else fs.writeFileSync(path.join(directory, file), content);
  }
}

/** A flat node_modules (npm's layout) holding the DuckDB, resvg, 1Password and node-datachannel packages for one target. */
function flatInstall({ version = PIN, platform = "linux", arch = "x64", nativeFiles, resvgBinary = "node", onePasswordCore = OP_PIN, dataChannelVersion = DC_PIN, dataChannelBinary } = {}) {
  const root = temporary("madani-duckdb-root-");
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ dependencies: { "@duckdb/node-api": PIN, "@resvg/resvg-js": RESVG_PIN, "@1password/sdk": OP_PIN, "node-datachannel": DC_PIN } }));
  const nodeModules = path.join(root, "node_modules");
  const scope = path.join(nodeModules, "@duckdb");
  writePackage(path.join(scope, "node-api"), "node-api", version, { "lib/index.js": "module.exports = {};" });
  writePackage(path.join(scope, "node-bindings"), "node-bindings", version, { "duckdb.js": "module.exports = require('./x');" });
  const native = platformPackage(platform, arch);
  writePackage(path.join(scope, native), native, version, nativeFiles ?? { "duckdb.node": "node", [platform === "win32" ? "duckdb.dll" : platform === "darwin" ? "libduckdb.dylib" : "libduckdb.so"]: "lib" });
  const resvg = path.join(nodeModules, "@resvg");
  const resvgNative = resvgPlatformPackage(platform, arch);
  writePackage(path.join(resvg, "resvg-js"), "resvg-js", RESVG_PIN, { "index.js": "module.exports = require('./js-binding.js');" }, "@resvg");
  writePackage(path.join(resvg, resvgNative.name), resvgNative.name, RESVG_PIN, { [resvgNative.binary]: resvgBinary }, "@resvg");
  const onePassword = path.join(nodeModules, "@1password");
  writePackage(path.join(onePassword, "sdk"), "sdk", OP_PIN, { "dist/sdk.js": "module.exports = require('@1password/sdk-core');" }, "@1password");
  fs.writeFileSync(path.join(onePassword, "sdk", "package.json"), JSON.stringify({ name: "@1password/sdk", version: OP_PIN, dependencies: { "@1password/sdk-core": OP_PIN } }));
  writePackage(path.join(onePassword, "sdk-core"), "sdk-core", onePasswordCore, { "nodejs/core.js": "module.exports = {};", "nodejs/core_bg.wasm": Buffer.from([0, 97, 115, 109]) }, "@1password");
  const dataChannel = dataChannelPlatformPackage(platform, arch);
  if (dataChannel) {
    writePackage(path.join(nodeModules, "node-datachannel"), "node-datachannel", dataChannelVersion, { "dist/cjs/lib/index.cjs": "module.exports = {};" }, "");
    writePackage(path.join(nodeModules, "detect-libc"), "detect-libc", "2.1.2", { "lib/detect-libc.js": "module.exports = {};" }, "", { main: "lib/detect-libc.js" });
    writePackage(path.join(nodeModules, "@node-datachannel", dataChannel.name), dataChannel.name, dataChannelVersion, { "node_datachannel.node": dataChannelBinary ?? addon(dataChannel) }, "@node-datachannel");
  }
  return { root, nodeModules, scope, resvg, onePassword };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("the installer", () => {
  it("copies the node_modules directory itself: electron-builder drops a root-level node_modules from any tree it copies", () => {
    // A Windows checkout may carry CRLF; the capture must not end in \r.
    const yml = fs.readFileSync(new URL("../build/electron-builder.yml", import.meta.url), "utf8").replace(/\r\n/g, "\n");
    const entries = [...yml.matchAll(/from: (dist-native\/duckdb\/[^\n]+)\n\s+to: ([^\n]+)/g)].map((m) => [m[1], m[2]]);
    expect(entries.length).toBeGreaterThanOrEqual(3);
    for (const [from, to] of entries) {
      expect(from, from).toMatch(/\/node_modules$/);
      expect(to).toBe("duckdb/node_modules");
    }
  });
});

describe("the pin", () => {
  it("requires an exact x.y.z version of @resvg/resvg-js", () => {
    const { root } = flatInstall();
    expect(pinnedResvgVersion(root)).toBe(RESVG_PIN);
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ dependencies: { "@duckdb/node-api": PIN, "@resvg/resvg-js": "^8.8.8" } }));
    expect(() => pinnedResvgVersion(root)).toThrow(/exact x\.y\.z version/);
  });

  it("requires an exact x.y.z version of @1password/sdk", () => {
    const { root } = flatInstall();
    expect(pinnedOnePasswordVersion(root)).toBe(OP_PIN);
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ dependencies: { "@1password/sdk": "^7.7.7" } }));
    expect(() => pinnedOnePasswordVersion(root)).toThrow(/exact x\.y\.z version/);
  });

  it("requires an exact x.y.z-r.n version of @duckdb/node-api", () => {
    const { root } = flatInstall();
    expect(pinnedDuckdbVersion(root)).toBe(PIN);
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ dependencies: { "@duckdb/node-api": "^1.5.6-r.1" } }));
    expect(() => pinnedDuckdbVersion(root)).toThrow(/exact x\.y\.z-r\.n/);
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ dependencies: {} }));
    expect(() => pinnedDuckdbVersion(root)).toThrow(/found nothing/);
  });

  it("stages both mac arches and x64 elsewhere", () => {
    expect(targetsFor("darwin", {})).toEqual([{ platform: "darwin", arch: "arm64" }, { platform: "darwin", arch: "x64" }]);
    expect(targetsFor("darwin", { MADANI_CUA_ARCHES: "arm64", MADANI_CUA_ARCHES_PARTIAL: "1" })).toEqual([{ platform: "darwin", arch: "arm64" }]);
    expect(targetsFor("linux", {})).toEqual([{ platform: "linux", arch: "x64" }]);
    // The Docker build stages the image's CPU, which need not be the build host's (linux/arm64 under buildx).
    expect(targetsFor("linux", { MADANI_DUCKDB_ARCH: "arm64" })).toEqual([{ platform: "linux", arch: "arm64" }]);
    expect(targetsFor("linux", { MADANI_DUCKDB_ARCH: "x64" })).toEqual([{ platform: "linux", arch: "x64" }]);
    expect(() => targetsFor("linux", { MADANI_DUCKDB_ARCH: "amd64" })).toThrow(/MADANI_DUCKDB_ARCH/);
    expect(targetsFor("win32", { MADANI_DUCKDB_ARCH: "arm64" })).toEqual([{ platform: "win32", arch: "x64" }]);
    expect(targetsFor("win32", {})).toEqual([{ platform: "win32", arch: "x64" }]);
  });
});

describe("staging from an install", () => {
  it("copies the three packages into a per-target tree that verifies", async () => {
    const { root } = flatInstall();
    const staged = await stageDuckdb({ root, targets: [{ platform: "linux", arch: "x64" }], sign: false, log: null });
    const tree = path.join(root, "dist-native", "duckdb", "linux-x64");
    expect(staged).toEqual([tree]);
    const scope = path.join(tree, "node_modules", "@duckdb");
    expect(fs.readdirSync(scope).sort()).toEqual(["node-api", "node-bindings", "node-bindings-linux-x64"]);
    expect(fs.readFileSync(path.join(scope, "node-bindings-linux-x64", "libduckdb.so"), "utf8")).toBe("lib");
    expect(fs.lstatSync(path.join(scope, "node-api")).isSymbolicLink()).toBe(false);
    // The chart rasteriser rides along, under its own scope, by target triple.
    const resvg = path.join(tree, "node_modules", "@resvg");
    expect(fs.readdirSync(resvg).sort()).toEqual(["resvg-js", "resvg-js-linux-x64-gnu"]);
    expect(fs.existsSync(path.join(resvg, "resvg-js-linux-x64-gnu", "resvgjs.linux-x64-gnu.node"))).toBe(true);
    // So does the 1Password SDK, with the WebAssembly core it reads from beside itself.
    const onePassword = path.join(tree, "node_modules", "@1password");
    expect(fs.readdirSync(onePassword).sort()).toEqual(["sdk", "sdk-core"]);
    expect(fs.existsSync(path.join(onePassword, "sdk-core", "nodejs", "core_bg.wasm"))).toBe(true);
    // And the direct screen path, with the libc probe it requires and the addon for this CPU.
    const modules = path.join(tree, "node_modules");
    expect(fs.readdirSync(modules).sort()).toEqual(["@1password", "@duckdb", "@node-datachannel", "@resvg", "detect-libc", "node-datachannel"]);
    expect(fs.readdirSync(path.join(modules, "@node-datachannel"))).toEqual(["linux-x64-gnu"]);
    await verifyDuckdbTree(tree, "linux", "x64", PIN, RESVG_PIN, OP_PIN, DC_PIN);
    fs.rmSync(path.join(resvg, "resvg-js-linux-x64-gnu"), { recursive: true });
    await expect(verifyDuckdbTree(tree, "linux", "x64", PIN, RESVG_PIN)).rejects.toThrow(/resvg-js-linux-x64-gnu/);
  });

  it("finds the 1Password core beside the SDK in pnpm's store, and refuses a tree without the core it needs", async () => {
    const root = temporary("madani-duckdb-pnpm-1p-");
    const nodeModules = path.join(root, "node_modules");
    const store = path.join(nodeModules, ".pnpm", `@1password+sdk@${OP_PIN}`, "node_modules", "@1password");
    writePackage(path.join(store, "sdk"), "sdk", OP_PIN, {}, "@1password");
    const core = path.join(nodeModules, ".pnpm", `@1password+sdk-core@${OP_PIN}`, "node_modules", "@1password", "sdk-core");
    writePackage(core, "sdk-core", OP_PIN, {}, "@1password");
    fs.symlinkSync(core, path.join(store, "sdk-core"), "dir");
    fs.mkdirSync(path.join(nodeModules, "@1password"));
    fs.symlinkSync(path.join(store, "sdk"), path.join(nodeModules, "@1password", "sdk"), "dir");
    expect(installedPackage(nodeModules, "sdk", "@1password", ["sdk"])).toBe(fs.realpathSync(path.join(store, "sdk")));
    expect(installedPackage(nodeModules, "sdk-core", "@1password", ["sdk"])).toBe(fs.realpathSync(core));

    const { root: other } = flatInstall({ onePasswordCore: "7.7.6" });
    await expect(stageDuckdb({ root: other, targets: [{ platform: "linux", arch: "x64" }], sign: false, log: null }))
      .rejects.toThrow(/sdk-core .* is 7\.7\.6; @1password\/sdk needs 7\.7\.7/);
  });

  it("finds the packages through pnpm's store links", () => {
    const root = temporary("madani-duckdb-pnpm-");
    const nodeModules = path.join(root, "node_modules");
    const store = path.join(nodeModules, ".pnpm");
    const api = path.join(store, `@duckdb+node-api@${PIN}`, "node_modules", "@duckdb");
    const bindings = path.join(store, `@duckdb+node-bindings@${PIN}`, "node_modules", "@duckdb");
    const native = path.join(store, `@duckdb+node-bindings-linux-x64@${PIN}`, "node_modules", "@duckdb");
    writePackage(path.join(api, "node-api"), "node-api", PIN, {});
    writePackage(path.join(bindings, "node-bindings"), "node-bindings", PIN, {});
    writePackage(path.join(native, "node-bindings-linux-x64"), "node-bindings-linux-x64", PIN, {});
    fs.symlinkSync(path.join(bindings, "node-bindings"), path.join(api, "node-bindings"), "dir");
    fs.symlinkSync(path.join(native, "node-bindings-linux-x64"), path.join(bindings, "node-bindings-linux-x64"), "dir");
    fs.mkdirSync(path.join(nodeModules, "@duckdb"));
    fs.symlinkSync(path.join(api, "node-api"), path.join(nodeModules, "@duckdb", "node-api"), "dir");

    expect(installedPackage(nodeModules, "node-api")).toBe(fs.realpathSync(path.join(api, "node-api")));
    expect(installedPackage(nodeModules, "node-bindings")).toBe(fs.realpathSync(path.join(bindings, "node-bindings")));
    expect(installedPackage(nodeModules, "node-bindings-linux-x64")).toBe(fs.realpathSync(path.join(native, "node-bindings-linux-x64")));
    expect(installedPackage(nodeModules, "node-bindings-win32-x64")).toBeNull();
    expect(installedPackage(path.join(root, "nowhere"), "node-api")).toBeNull();
  });

  it("refuses an installed package whose version is not the pin", async () => {
    const { root } = flatInstall({ version: "9.9.8-r.1" });
    await expect(stageDuckdb({ root, targets: [{ platform: "linux", arch: "x64" }], sign: false, log: null }))
      .rejects.toThrow(/node-api at .* is 9\.9\.8-r\.1; package\.json pins 9\.9\.9-r\.9/);
  });

  it("fetches a platform package the install lacks, at the pinned version only", async () => {
    const { root } = flatInstall();
    const packed = [];
    const pack = async (name, version, cache, scope = "@duckdb") => {
      packed.push({ name, version, cache, scope });
      const directory = path.join(cache, `${name}-${version}`);
      if (scope === "@resvg") writePackage(directory, name, version, { "resvgjs.win32-x64-msvc.node": "node" }, scope);
      else if (scope === "@node-datachannel") writePackage(directory, name, version, { "node_datachannel.node": pe(0x8664) }, scope);
      else writePackage(directory, name, version, { "duckdb.node": "node", "duckdb.dll": "lib" });
      return directory;
    };
    const staged = await stageDuckdb({ root, targets: [{ platform: "win32", arch: "x64" }], pack, sign: false, log: null });
    const cache = path.join(root, "node_modules", ".cache", "madanibot", "duckdb");
    // Both native packages the host lacks are fetched, each at its own pin.
    expect(packed).toEqual([
      { name: "node-bindings-win32-x64", version: PIN, cache, scope: "@duckdb" },
      { name: "resvg-js-win32-x64-msvc", version: RESVG_PIN, cache, scope: "@resvg" },
      { name: "win32-x64-msvc", version: DC_PIN, cache, scope: "@node-datachannel" },
    ]);
    await verifyDuckdbTree(staged[0], "win32", "x64", PIN, RESVG_PIN);

    const wrong = async (name, version, cache) => {
      const directory = path.join(cache, `${name}-other`);
      writePackage(directory, name, "9.9.9-r.8", { "duckdb.node": "node", "duckdb.dll": "lib" });
      return directory;
    };
    await expect(stageDuckdb({ root, targets: [{ platform: "win32", arch: "x64" }], pack: wrong, sign: false, log: null }))
      .rejects.toThrow(/is 9\.9\.9-r\.8; package\.json pins/);
  });

  it("never fetches node-api or node-bindings: those must be installed", async () => {
    const { root, scope } = flatInstall();
    fs.rmSync(path.join(scope, "node-bindings"), { recursive: true });
    await expect(stageDuckdb({ root, targets: [{ platform: "linux", arch: "x64" }], pack: async () => { throw new Error("must not pack"); }, sign: false, log: null }))
      .rejects.toThrow(/node-bindings is not installed/);
  });
});

describe("the direct screen path", () => {
  it("requires an exact x.y.z version of node-datachannel, and every tree carries it", () => {
    const { root } = flatInstall();
    expect(pinnedDataChannelVersion(root)).toBe(DC_PIN);
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ dependencies: { "node-datachannel": "^6.6.6" } }));
    expect(() => pinnedDataChannelVersion(root)).toThrow(/exact x\.y\.z version/);
    expect(dataChannelPlatformPackage("linux", "x64")?.name).toBe("linux-x64-gnu");
    expect(dataChannelPlatformPackage("linux", "arm64")?.name).toBe("linux-arm64-gnu");
    expect(dataChannelPlatformPackage("darwin", "arm64")?.name).toBe("darwin-arm64");
    expect(dataChannelPlatformPackage("darwin", "x64")?.name).toBe("darwin-x64");
    expect(dataChannelPlatformPackage("win32", "x64")?.name).toBe("win32-x64-msvc");
    expect(dataChannelPlatformPackage("win32", "arm64")).toBeNull();
  });

  it.each([["darwin", "arm64"], ["darwin", "x64"], ["win32", "x64"]])("stages and verifies the %s-%s desktop addon, with the libc probe its loader requires", async (platform, arch) => {
    const target = dataChannelPlatformPackage(platform, arch);
    const { root } = flatInstall({ platform, arch });
    const tree = path.join(root, "dist-native", "duckdb", `${platform}-${arch}`);
    // the mac checks need lipo on real binaries; here only the addon path is under test
    if (platform === "darwin") {
      fs.cpSync(path.join(root, "node_modules"), path.join(tree, "node_modules"), { recursive: true });
    } else {
      await stageDuckdb({ root, targets: [{ platform, arch }], sign: false, log: null });
    }
    const modules = path.join(tree, "node_modules");
    expect(fs.readdirSync(path.join(modules, "@node-datachannel"))).toEqual([target.name]);
    expect(fs.existsSync(path.join(modules, "detect-libc", "lib", "detect-libc.js"))).toBe(true);
    if (platform === "win32") await verifyDuckdbTree(tree, platform, arch, PIN, RESVG_PIN, OP_PIN, DC_PIN);
    checkNativeMachine(path.join(modules, "@node-datachannel", target.name, "node_datachannel.node"), target.format, target.machine, arch);
  });

  it("checks the addon's own binary format and CPU", () => {
    const directory = temporary("madani-dc-format-");
    const file = path.join(directory, "node_datachannel.node");
    const check = (bytes, platform, arch) => {
      fs.writeFileSync(file, bytes);
      const { format, machine } = dataChannelPlatformPackage(platform, arch);
      checkNativeMachine(file, format, machine, arch);
    };
    check(macho(0x0100000c), "darwin", "arm64");
    check(macho(0x01000007), "darwin", "x64");
    check(pe(0x8664), "win32", "x64");
    expect(() => check(macho(0x01000007), "darwin", "arm64")).toThrow(/MACHO machine 16777223, not arm64/);
    // a universal file is refused: each mac app is single-arch
    const fat = Buffer.alloc(64);
    fat.writeUInt32BE(0xcafebabe, 0);
    expect(() => check(fat, "darwin", "arm64")).toThrow(/not a thin 64-bit Mach-O/);
    expect(() => check(elf(183), "darwin", "arm64")).toThrow(/not a thin 64-bit Mach-O/);
    expect(() => check(pe(0xaa64), "win32", "x64")).toThrow(/PE machine 43620, not x64/);
    expect(() => check(macho(0x01000007), "win32", "x64")).toThrow(/not a PE file/);
    expect(() => check(Buffer.from("MZ"), "win32", "x64")).toThrow(/not a PE file/);
  });

  it("stages the image's CPU from pnpm's store, fetching the platform package the install lacks at the pin", async () => {
    const root = temporary("madani-duckdb-pnpm-dc-");
    const { root: flat, nodeModules: flatModules } = flatInstall({ arch: "arm64" });
    fs.cpSync(flat, root, { recursive: true });
    const nodeModules = path.join(root, "node_modules");
    // pnpm's layout: node-datachannel linked from its store folder, detect-libc beside it, no arm64 addon on this host
    fs.rmSync(path.join(nodeModules, "node-datachannel"), { recursive: true });
    fs.rmSync(path.join(nodeModules, "detect-libc"), { recursive: true });
    fs.rmSync(path.join(nodeModules, "@node-datachannel"), { recursive: true });
    const store = path.join(nodeModules, ".pnpm", `node-datachannel@${DC_PIN}`, "node_modules");
    fs.cpSync(path.join(flatModules, "node-datachannel"), path.join(store, "node-datachannel"), { recursive: true });
    fs.cpSync(path.join(flatModules, "detect-libc"), path.join(store, "detect-libc"), { recursive: true });
    fs.symlinkSync(path.join(store, "node-datachannel"), path.join(nodeModules, "node-datachannel"), "dir");
    const packed = [];
    const pack = async (name, version, cache, scope) => {
      packed.push(`${scope}/${name}@${version}`);
      const directory = path.join(cache, `${name}-${version}`);
      writePackage(directory, name, version, { "node_datachannel.node": elf(183) }, scope);
      return directory;
    };
    const [tree] = await stageDuckdb({ root, targets: [{ platform: "linux", arch: "arm64" }], pack, sign: false, log: null });
    // DuckDB's and resvg's arm64 packages were in the flat install; only the addon is fetched
    expect(packed).toEqual([`@node-datachannel/linux-arm64-gnu@${DC_PIN}`]);
    expect(fs.lstatSync(path.join(tree, "node_modules", "node-datachannel")).isSymbolicLink()).toBe(false);
    expect(fs.existsSync(path.join(tree, "node_modules", "detect-libc", "lib", "detect-libc.js"))).toBe(true);
    await verifyDuckdbTree(tree, "linux", "arm64", PIN, RESVG_PIN, OP_PIN, DC_PIN);
  });

  it("refuses another version, a missing libc probe, or an addon for the wrong CPU", async () => {
    await expect(stageDuckdb({ root: flatInstall({ dataChannelVersion: "6.6.5" }).root, targets: [{ platform: "linux", arch: "x64" }], sign: false, log: null }))
      .rejects.toThrow(/node-datachannel at .* is 6\.6\.5; package\.json pins node-datachannel 6\.6\.6/);
    await expect(stageDuckdb({ root: flatInstall({ dataChannelBinary: elf(183) }).root, targets: [{ platform: "linux", arch: "x64" }], sign: false, log: null }))
      .rejects.toThrow(/ELF machine 183, not x64/);
    await expect(stageDuckdb({ root: flatInstall({ dataChannelBinary: "node" }).root, targets: [{ platform: "linux", arch: "x64" }], sign: false, log: null }))
      .rejects.toThrow(/not an ELF file/);
    const { root, nodeModules } = flatInstall();
    const [tree] = await stageDuckdb({ root, targets: [{ platform: "linux", arch: "x64" }], sign: false, log: null });
    fs.rmSync(path.join(tree, "node_modules", "detect-libc", "lib"), { recursive: true });
    await expect(verifyDuckdbTree(tree, "linux", "x64", PIN, RESVG_PIN, OP_PIN, DC_PIN)).rejects.toThrow(/detect-libc/);
    fs.rmSync(path.join(nodeModules, "node-datachannel"), { recursive: true });
    await expect(stageDuckdb({ root, targets: [{ platform: "linux", arch: "x64" }], pack: async () => { throw new Error("must not pack"); }, sign: false, log: null }))
      .rejects.toThrow(/node-datachannel is not installed/);
  });
});

describe("verifying a tree", () => {
  async function stagedTree() {
    const { root } = flatInstall();
    const [tree] = await stageDuckdb({ root, targets: [{ platform: "linux", arch: "x64" }], sign: false, log: null });
    return { tree, native: path.join(tree, "node_modules", "@duckdb", "node-bindings-linux-x64") };
  }

  it("fails on a missing binding, a missing library, a link, or another version", async () => {
    const { tree, native } = await stagedTree();
    await verifyDuckdbTree(tree, "linux", "x64", PIN);
    await expect(verifyDuckdbTree(tree, "linux", "x64", "9.9.9-r.1")).rejects.toThrow(/pins 9\.9\.9-r\.1/);
    await expect(verifyDuckdbTree(tree, "linux", "arm64", PIN)).rejects.toThrow(/missing: .*node-bindings-linux-arm64/);
    fs.renameSync(path.join(native, "duckdb.node"), path.join(native, "duckdb.node.bak"));
    await expect(verifyDuckdbTree(tree, "linux", "x64", PIN)).rejects.toThrow(/duckdb\.node.*missing|missing: .*duckdb\.node/);
    fs.symlinkSync(path.join(native, "duckdb.node.bak"), path.join(native, "duckdb.node"));
    await expect(verifyDuckdbTree(tree, "linux", "x64", PIN)).rejects.toThrow(/regular file/);
    fs.unlinkSync(path.join(native, "duckdb.node"));
    fs.renameSync(path.join(native, "duckdb.node.bak"), path.join(native, "duckdb.node"));
    fs.unlinkSync(path.join(native, "libduckdb.so"));
    await expect(verifyDuckdbTree(tree, "linux", "x64", PIN)).rejects.toThrow(/libduckdb\.so/);
  });

  it("fails without the 1Password core's WebAssembly, or with another SDK version", async () => {
    const { tree } = await stagedTree();
    await verifyDuckdbTree(tree, "linux", "x64", PIN, RESVG_PIN, OP_PIN);
    await expect(verifyDuckdbTree(tree, "linux", "x64", PIN, RESVG_PIN, "7.7.8")).rejects.toThrow(/@1password\/sdk .* pins 7\.7\.8/);
    fs.unlinkSync(path.join(tree, "node_modules", "@1password", "sdk-core", "nodejs", "core_bg.wasm"));
    await expect(verifyDuckdbTree(tree, "linux", "x64", PIN, RESVG_PIN, OP_PIN)).rejects.toThrow(/core_bg\.wasm/);
  });
});

// Real Mach-O fixtures: /usr/bin binaries are arm64e, not arm64, so compile.
const canBuildMachO = process.platform === "darwin" && fs.existsSync("/usr/bin/lipo") && spawnSync("cc", ["--version"]).status === 0;

describe.skipIf(!canBuildMachO)("macOS slices", () => {
  const binaries = {};
  let directory;
  const archs = (file) => execFileSync("/usr/bin/lipo", ["-archs", file], { encoding: "utf8" }).trim();

  beforeAll(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "madani-duckdb-macho-"));
    fs.writeFileSync(path.join(directory, "main.c"), "int main(void) { return 0; }\n");
    for (const arch of ["arm64", "x86_64"]) {
      binaries[arch] = path.join(directory, arch);
      execFileSync("cc", ["-arch", arch, "-o", binaries[arch], path.join(directory, "main.c")]);
    }
    binaries.fat = path.join(directory, "fat");
    execFileSync("/usr/bin/lipo", ["-create", binaries.arm64, binaries.x86_64, "-output", binaries.fat]);
  });

  it.each([["arm64", "arm64"], ["x64", "x86_64"]])("keeps only the %s slice of the universal dylib and binding, signed", async (arch, lipoArch) => {
    const fat = fs.readFileSync(binaries.fat);
    const { root } = flatInstall({ platform: "darwin", arch, nativeFiles: { "duckdb.node": fat, "libduckdb.dylib": fat }, resvgBinary: fs.readFileSync(binaries[lipoArch]), dataChannelBinary: fs.readFileSync(binaries[lipoArch]) });
    const [tree] = await stageDuckdb({ root, targets: [{ platform: "darwin", arch }], sign: true, log: null });
    const native = path.join(tree, "node_modules", "@duckdb", platformPackage("darwin", arch));
    expect(archs(path.join(native, "libduckdb.dylib"))).toBe(lipoArch);
    expect(archs(path.join(native, "duckdb.node"))).toBe(lipoArch);
    expect(spawnSync("/usr/bin/codesign", ["--verify", path.join(native, "libduckdb.dylib")]).status).toBe(0);
    const dataChannel = path.join(tree, "node_modules", "@node-datachannel", dataChannelPlatformPackage("darwin", arch).name, "node_datachannel.node");
    expect(spawnSync("/usr/bin/codesign", ["--verify", dataChannel]).status).toBe(0);
    await verifyDuckdbTree(tree, "darwin", arch, PIN, RESVG_PIN, OP_PIN, DC_PIN);
  });

  it("rejects a tree whose dylib stayed universal or is not Mach-O", async () => {
    const fat = fs.readFileSync(binaries.fat);
    const { root, scope } = flatInstall({ platform: "darwin", arch: "arm64", nativeFiles: { "duckdb.node": fat, "libduckdb.dylib": fat }, resvgBinary: fs.readFileSync(binaries.arm64) });
    const tree = path.join(root, "dist-native", "duckdb", "darwin-arm64");
    fs.cpSync(path.join(root, "node_modules"), path.join(tree, "node_modules"), { recursive: true });
    await expect(verifyDuckdbTree(tree, "darwin", "arm64", PIN)).rejects.toThrow(/is \[(?:arm64 x86_64|x86_64 arm64)\], must be exactly arm64/);
    fs.writeFileSync(path.join(tree, "node_modules", "@duckdb", "node-bindings-darwin-arm64", "libduckdb.dylib"), "not a binary");
    fs.copyFileSync(binaries.arm64, path.join(tree, "node_modules", "@duckdb", "node-bindings-darwin-arm64", "duckdb.node"));
    await expect(verifyDuckdbTree(tree, "darwin", "arm64", PIN)).rejects.toThrow(/not a Mach-O/);
    expect(scope).toBeTruthy();
  });

  it("fails staging when the binary lacks the app's arch", async () => {
    const only = fs.readFileSync(binaries.x86_64);
    const { root } = flatInstall({ platform: "darwin", arch: "arm64", nativeFiles: { "duckdb.node": only, "libduckdb.dylib": only }, resvgBinary: only });
    await expect(stageDuckdb({ root, targets: [{ platform: "darwin", arch: "arm64" }], sign: false, log: null })).rejects.toThrow(/no arm64 slice/);
  });
});

describe("the built-in voice's runtime", () => {
  it("keeps one platform's ONNX Runtime binaries, without GPU-only DLLs or the mac library's second copy", () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "ort-stage-"));
    try {
      const pkg = path.join(base, "node_modules", "onnxruntime-node");
      const files = {
        "darwin/arm64": ["libonnxruntime.1.31.1.dylib", "libonnxruntime.1.dylib", "onnxruntime_binding.node"],
        "linux/x64": ["libonnxruntime.so.1", "onnxruntime_binding.node"],
        "win32/x64": ["DirectML.dll", "dxcompiler.dll", "onnxruntime.dll", "onnxruntime_binding.node"],
      };
      for (const [dir, names] of Object.entries(files)) {
        fs.mkdirSync(path.join(pkg, "bin", "napi-v6", dir), { recursive: true });
        for (const name of names) fs.writeFileSync(path.join(pkg, "bin", "napi-v6", dir, name), "x");
      }
      fs.writeFileSync(path.join(pkg, "package.json"), "{}");
      fs.mkdirSync(path.join(base, "node_modules", "onnxruntime-common"));
      fs.writeFileSync(path.join(base, "node_modules", "onnxruntime-common", "package.json"), "{}");
      const staged = (platform, arch) => {
        const out = path.join(base, `out-${platform}-${arch}`);
        const kept = stageOnnxRuntime(path.join(base, "node_modules"), out, platform, arch);
        if (!kept) return null;
        const bins = path.join(out, "onnxruntime-node", "bin", "napi-v6");
        return {
          files: fs.readdirSync(kept).sort(),
          platforms: fs.readdirSync(bins).flatMap((name) => fs.readdirSync(path.join(bins, name)).map((cpu) => `${name}/${cpu}`)),
          common: fs.existsSync(path.join(out, "onnxruntime-common")),
        };
      };
      expect(staged("darwin", "arm64")).toEqual({ files: ["libonnxruntime.1.dylib", "onnxruntime_binding.node"], platforms: ["darwin/arm64"], common: true });
      expect(staged("win32", "x64")).toEqual({ files: ["onnxruntime.dll", "onnxruntime_binding.node"], platforms: ["win32/x64"], common: true });
      expect(staged("darwin", "x64")).toBeNull();
      expect(stageOnnxRuntime(path.join(base, "missing"), path.join(base, "none"), "linux", "x64")).toBeNull();
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
});
