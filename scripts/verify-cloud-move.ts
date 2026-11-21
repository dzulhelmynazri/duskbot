// The move offer in the real app, on an isolated fake-engine server, with the desktop bridge played in the page
// (scripts/testing/cloud-move-preview.tsx). POST /__fixture/cloud?home=1 answers the config as a Cloud home's, for the
// done sheet on My Cloud's page. Run: node --experimental-strip-types scripts/verify-cloud-move.ts
import type { IncomingMessage, ServerResponse } from "node:http";
import { launchVerificationServer } from "./control-madani.ts";
import { mountPreview, parkUntilSignal, type MountedPreview } from "./testing/preview-fixture.ts";

let home = false;
const fixture = await launchVerificationServer();
let ui: MountedPreview | undefined;

async function relay(req: IncomingMessage, res: ServerResponse) {
  const response = await fetch(`${fixture.info.url}${req.url}`, { headers: { accept: "application/json", cookie: req.headers.cookie ?? "" } });
  const body = await response.json() as Record<string, unknown>;
  res.statusCode = response.status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(response.ok && home ? { ...body, cloudHome: true } : body));
}

try {
  ui = await mountPreview(fixture, {
    entry: "/scripts/testing/cloud-move-preview.tsx", route: "/__cloud-move.html", title: "Isolated move to madani cloud",
    extraRoutes: [
      { path: "/api/config", method: "GET", handler: relay },
      { path: "/api/auth/session", method: "GET", handler: relay },
      { path: "/__fixture/cloud", method: "POST", handler: (req, res) => {
        home = new URL(req.url ?? "/", "http://fixture").searchParams.get("home") === "1";
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ home }));
      } },
    ],
  });
  console.log(JSON.stringify({ ...fixture.info, previewUrl: ui.previewUrl }, null, 2));
  await parkUntilSignal();
} finally {
  await ui?.close();
  await fixture.close();
}
