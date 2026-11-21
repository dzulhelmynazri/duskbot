import { createServer, type AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";

import { insideWsl, windowsHostAddress, wslPortShareWarning } from "./wsl-port-share.ts";

const ROUTE = "Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\n"
  + "eth0\t0010A8C0\t00000000\t0001\t0\t0\t0\t00F0FFFF\n"
  + "eth0\t00000000\t0100007F\t0003\t0\t0\t0\t00000000\n";
const wsl = (path: string) => {
  if (path === "/proc/net/route") return ROUTE;
  if (path === "/proc/sys/kernel/osrelease") return "6.6.87.2-microsoft-standard-WSL2";
  throw new Error("ENOENT");
};

describe("a Windows program sharing the port through WSL", () => {
  it("knows WSL by its kernel or its distro name", () => {
    expect(insideWsl({}, wsl)).toBe(true);
    expect(insideWsl({ WSL_DISTRO_NAME: "Ubuntu" }, () => { throw new Error("ENOENT"); })).toBe(true);
    expect(insideWsl({}, () => "6.8.0-45-generic")).toBe(false);
  });

  it("reads the Windows host from the default route", () => {
    expect(windowsHostAddress(wsl)).toBe("127.0.0.1");
    expect(windowsHostAddress(() => "Iface\tDestination\tGateway\n")).toBeNull();
  });

  it("warns, naming the way out, when the Windows host answers on the same port", async () => {
    const other = createServer().listen(0, "127.0.0.1");
    await new Promise((resolve) => other.once("listening", resolve));
    const { port } = other.address() as AddressInfo;
    try {
      const warning = await wslPortShareWarning(port, { env: {}, read: wsl });
      expect(warning).toContain(`also listens on port ${port}`);
      expect(warning).toContain("MADANI_PORT=");
    } finally { other.close(); }
    expect(await wslPortShareWarning(port, { env: {}, read: wsl })).toBeNull();
  });

  it("stays quiet outside WSL", async () => {
    expect(await wslPortShareWarning(8799, { env: {}, read: () => "6.8.0-45-generic", probe: async () => true })).toBeNull();
  });
});
