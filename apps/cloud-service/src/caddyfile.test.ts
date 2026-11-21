import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";

// InstaBox's port proxy replaces the public edge's X-Forwarded-Host with its own hosted name, while a browser sends the
// public name as Origin: unless the server sees the public name, every change a signed-in page makes is refused.
it("presents a request for the provider's hosted name to the server under the public name", () => {
  const caddy = readFileSync(join(import.meta.dirname, "../deploy/Caddyfile"), "utf8");
  const forwarded = caddy.indexOf("request_header @proxied Host {http.request.header.X-Forwarded-Host}");
  const upstream = caddy.search(/^\t@upstream host \{\$MADANI_CLOUD_UPSTREAM_HOST\}\r?\n\trequest_header @upstream Host \{\$MADANI_CLOUD_PUBLIC_HOST\}\r?\n/m);
  expect(forwarded).toBeGreaterThan(-1);
  expect(upstream).toBeGreaterThan(forwarded);
  expect(upstream).toBeLessThan(caddy.indexOf("handle /api/health {"));
  expect(caddy).toMatch(/@home host \{\$MADANI_CLOUD_PUBLIC_HOST\} \{\$MADANI_CLOUD_UPSTREAM_HOST\}/);
});
