import { mkdtempSync, rmSync } from "node:fs";
import type { LookupAddress } from "node:dns";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  createSiteIcons,
  encodePng,
  iconPng,
  iconUrlAllowed,
  isPublicAddress,
  normalizeAppSlug,
  normalizeSiteDomain,
  rasterInfo,
  selfContainedSvg,
  type IconAnswer,
  type IconFetcher,
} from "./site-icons.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const RED = encodePng(2, 2, Buffer.from(Array.from({ length: 4 }, () => [255, 0, 0, 255]).flat()));
const v4 = (address: string): LookupAddress => ({ address, family: 4 });

function harness(dns: Record<string, string[]>, answers: Record<string, Partial<IconAnswer>>) {
  const dir = mkdtempSync(join(tmpdir(), "madani-site-icons-"));
  dirs.push(dir);
  const fetched: string[] = [];
  const fetcher: IconFetcher = async (url, address) => {
    fetched.push(`${url.href} @${address.address}`);
    const answer = answers[url.href] ?? { status: 404 };
    return { status: 200, location: null, type: "", body: Buffer.alloc(0), ...answer };
  };
  const icons = createSiteIcons({
    dir,
    resolve: async (host) => (dns[host] ?? []).map(v4),
    fetcher,
    encode: (_type, bytes) => (bytes.equals(RED) ? RED : null),
  });
  return { icons, fetched };
}

describe("site icon addresses", () => {
  it("takes site names only, never an address or a local name", () => {
    expect(normalizeSiteDomain(" GitHub.com. ")).toBe("github.com");
    expect(normalizeSiteDomain("127.0.0.1")).toBeNull();
    expect(normalizeSiteDomain("localhost")).toBeNull();
    expect(normalizeSiteDomain("https://github.com")).toBeNull();
  });

  it("calls only public addresses public, mapped and translated IPv4 included", () => {
    expect(isPublicAddress("93.184.215.14")).toBe(true);
    for (const address of ["127.0.0.1", "10.1.2.3", "192.168.1.5", "172.20.0.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1", "64:ff9b::a00:1"]) {
      expect(isPublicAddress(address), address).toBe(false);
    }
  });

  it("asks over https on its own port with no credentials", () => {
    expect(iconUrlAllowed(new URL("https://example.com/favicon.ico"))).toBe(true);
    expect(iconUrlAllowed(new URL("http://example.com/favicon.ico"))).toBe(false);
    expect(iconUrlAllowed(new URL("https://example.com:8443/favicon.ico"))).toBe(false);
    expect(iconUrlAllowed(new URL("https://user:pw@example.com/favicon.ico"))).toBe(false);
  });
});

describe("fetching a site's icon", () => {
  it("never connects when the name resolves to a private address", async () => {
    const { icons, fetched } = harness({ "intranet.example": ["10.0.0.7"] }, {});
    expect(await icons.get("intranet.example")).toBeNull();
    expect(fetched).toEqual([]);
  });

  it("refuses a name with one private answer among public ones", async () => {
    const { icons, fetched } = harness({ "rebind.example": ["93.184.215.14", "127.0.0.1"] }, {});
    expect(await icons.get("rebind.example")).toBeNull();
    expect(fetched).toEqual([]);
  });

  it("stops at a redirect to a private address, and connects only to the address it checked", async () => {
    const { icons, fetched } = harness(
      { "site.example": ["93.184.215.14"], "inside.example": ["192.168.1.1"] },
      {
        "https://site.example/": { status: 302, location: "https://inside.example/" },
        "https://site.example/favicon.ico": { status: 301, location: "https://inside.example/favicon.ico" },
      },
    );
    expect(await icons.get("site.example")).toBeNull();
    expect(fetched).toEqual(["https://site.example/ @93.184.215.14", "https://site.example/favicon.ico @93.184.215.14"]);
  });

  it("stops at a redirect to plain http or another port", async () => {
    const { icons, fetched } = harness(
      { "site.example": ["93.184.215.14"] },
      {
        "https://site.example/": { status: 302, location: "http://site.example/" },
        "https://site.example/favicon.ico": { status: 302, location: "https://site.example:8080/favicon.ico" },
      },
    );
    expect(await icons.get("site.example")).toBeNull();
    expect(fetched).toHaveLength(2);
  });

  it("follows a public redirect to the page's linked icon and remembers it", async () => {
    const { icons, fetched } = harness(
      { "site.example": ["93.184.215.14"], "www.site.example": ["93.184.215.15"], "cdn.example": ["93.184.215.16"] },
      {
        "https://site.example/": { status: 301, location: "https://www.site.example/" },
        "https://www.site.example/": { type: "text/html", body: Buffer.from('<link rel="icon" href="https://cdn.example/i.png" sizes="64x64">') },
        "https://cdn.example/i.png": { type: "image/png", body: RED },
      },
    );
    expect(await icons.get("site.example")).toEqual(RED);
    const asked = fetched.length;
    expect(await icons.get("site.example")).toEqual(RED);
    expect(fetched).toHaveLength(asked);
  });
});

describe("an app's logo", () => {
  it("is asked of Composio's logo address only, by a plain app id, and kept once drawn", async () => {
    const { icons, fetched } = harness({ "logos.composio.dev": ["93.184.215.20"] }, { "https://logos.composio.dev/api/gmail": { type: "image/svg+xml", body: RED } });
    expect(await icons.app("gmail")).toEqual(RED);
    expect(await icons.app("gmail")).toEqual(RED);
    expect(fetched).toEqual(["https://logos.composio.dev/api/gmail @93.184.215.20"]);
    expect(await icons.app("../etc")).toBeNull();
    expect(fetched).toHaveLength(1);
    expect(normalizeAppSlug("Google_Sheets")).toBe("google_sheets");
    expect(normalizeAppSlug("a/b")).toBeNull();
  });
});

describe("re-encoding", () => {
  it("draws a raster as a 96px PNG", () => {
    const png = iconPng("image/png", RED);
    expect(png && rasterInfo(png)).toMatchObject({ mime: "image/png", width: 96, height: 96 });
  });

  it("refuses an image whose header claims a huge canvas", () => {
    const huge = Buffer.from(RED);
    huge.writeUInt32BE(50_000, 16);
    huge.writeUInt32BE(50_000, 20);
    expect(rasterInfo(huge)).toBeNull();
  });

  it("refuses an SVG that points at anything outside itself", () => {
    const shape = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><defs><linearGradient id="g"/></defs><rect fill="url(#g)" width="10" height="10"/></svg>';
    expect(selfContainedSvg(shape)).toBe(shape);
    expect(selfContainedSvg('<svg><image href="/etc/secret.png"/></svg>')).toBeNull();
    expect(selfContainedSvg('<svg xmlns:x="http://www.w3.org/1999/xlink"><image x:href="&#47;etc/secret.png"/></svg>')).toBeNull();
    expect(selfContainedSvg('<svg><rect style="fill:url(file.svg#a)"/></svg>')).toBeNull();
    expect(selfContainedSvg('<!DOCTYPE svg [<!ENTITY a "b">]><svg/>')).toBeNull();
    const embedded = '<svg xmlns="http://www.w3.org/2000/svg"><image href="data:image/png;base64,iVBORw0KGgo="/></svg>';
    expect(selfContainedSvg(embedded)).toBe(embedded);
    expect(selfContainedSvg('<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">\n<svg></svg>')).toBe("\n<svg></svg>");
    expect(selfContainedSvg('<svg><image href="data:image/svg+xml;base64,PHN2Zz4="/></svg>')).toBeNull();
  });
});
