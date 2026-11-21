// A new Cloud's welcome in the real app, on an isolated fake-engine server. Only what makes it a Cloud is
// answered here: the owner's session and config say cloudHome. POST /__fixture/engines?mode=signed-in|signed-out
// picks whether the person's own Claude is signed in (signed out by default).
// Run: node --experimental-strip-types scripts/verify-cloud-welcome.ts
import type { IncomingMessage, ServerResponse } from "node:http";
import { launchVerificationServer } from "./control-madani.ts";
import { mountPreview, parkUntilSignal, type MountedPreview } from "./testing/preview-fixture.ts";

type Mode = "signed-in" | "signed-out";
let mode: Mode = "signed-out";

const fixture = await launchVerificationServer();
let ui: MountedPreview | undefined;

async function relay(req: IncomingMessage, res: ServerResponse, change: (body: Record<string, unknown>) => Record<string, unknown>) {
  const response = await fetch(`${fixture.info.url}${req.url}`, { headers: { accept: "application/json", cookie: req.headers.cookie ?? "" } });
  const body = await response.json() as Record<string, unknown>;
  res.statusCode = response.status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(response.ok ? change(body) : body));
}

function engines(body: Record<string, unknown>) {
  const instances = (body.instances as Array<Record<string, any>>).map((instance) => instance.driverKind === "claudeAgent"
    ? { ...instance, snapshot: { ...instance.snapshot, authenticated: mode === "signed-in" } } : instance);
  return { ...body, instances };
}

try {
  ui = await mountPreview(fixture, {
    entry: "/scripts/testing/cloud-welcome-preview.tsx", route: "/__cloud-welcome.html", title: "Isolated Cloud welcome",
    extraRoutes: [
      { path: "/api/auth/session", method: "GET", handler: (req, res) => relay(req, res, (body) => ({ ...body, cloudHome: true })) },
      { path: "/api/config", method: "GET", handler: (req, res) => relay(req, res, (body) => ({ ...body, cloudHome: true })) },
      { path: "/api/instances", method: "GET", handler: (req, res) => relay(req, res, engines) },
      { path: "/__fixture/engines", method: "POST", handler: (req, res) => {
        const asked = new URL(req.url ?? "/", "http://fixture").searchParams.get("mode");
        if (asked === "signed-in" || asked === "signed-out") mode = asked;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ mode }));
      } },
    ],
  });
  console.log(JSON.stringify({ ...fixture.info, previewUrl: ui.previewUrl }, null, 2));
  await parkUntilSignal();
} finally {
  await ui?.close();
  await fixture.close();
}
