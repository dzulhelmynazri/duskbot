// GitHub Copilot's and Cursor's own sign-in run in the background by the app, against the offline fake login CLI in a
// disposable HOME: no real CLI, no network, no credentials.
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { codelessSignIn, deviceSignInLink, deviceSignInPrompt } from "../../../shared/device-sign-in.ts";
import { removeTempDir } from "../../testing/cleanup.ts";
import { DeviceAuthController } from "../device-auth.ts";
import { COPILOT_DEVICE_SIGN_IN } from "./copilot.ts";
import { CURSOR_SIGN_IN } from "./cursor.ts";

const FAKE = fileURLToPath(new URL("../../testing/fake-login-cli.ts", import.meta.url));
const CURSOR_LINK = "https://cursor.com/loginDeepControl?challenge=fakechallenge&uuid=fake-uuid&mode=login&redirectTarget=cli";

describe("reading the prompt", () => {
  it("reads GitHub's page and code from Copilot's one line", () => {
    expect(deviceSignInPrompt("copilot", "To authenticate, visit https://github.com/login/device and enter code AB12-CD34\nWaiting for authorization...\n"))
      .toEqual({ authorizationUrl: "https://github.com/login/device", userCode: "AB12-CD34" });
    expect(deviceSignInPrompt("copilot", "To authenticate, visit https://github.com/login/device and enter code AB12-CD")).toBeNull();
  });

  it.each([
    "https://github.com.evil.test/login/device",
    "https://github.com/login/oauth/authorize?client_id=x&redirect_uri=http%3A%2F%2F127.0.0.1%3A1%2Fcallback",
    "http://github.com/login/device",
  ])("never turns another page into a GitHub link: %s", (page) => {
    expect(deviceSignInPrompt("copilot", `To authenticate, visit ${page} and enter code AB12-CD34\n`)).toBeNull();
  });

  it("reads Cursor's one-time link, which needs no code", () => {
    expect(codelessSignIn("cursor")).toBe(true);
    expect(deviceSignInPrompt("cursor", `Open a browser and navigate to this link: ${CURSOR_LINK}\n`)).toEqual({ authorizationUrl: CURSOR_LINK });
    expect(deviceSignInLink("cursor", "https://cursor.com/loginDeepControl?uuid=x&token=secret")).toBeNull();
    expect(deviceSignInLink("cursor", "https://cursor.com.evil.test/loginDeepControl?uuid=x")).toBeNull();
    expect(deviceSignInLink("cursor", "https://cursor.com/settings?uuid=x")).toBeNull();
  });
});

describe.skipIf(process.platform === "win32")("signing in in the background", () => {
  let home: string;
  let controllers: DeviceAuthController[];
  const controller = (spec: typeof COPILOT_DEVICE_SIGN_IN, env: Record<string, string>) => {
    const made = new DeviceAuthController(spec, {
      cli: FAKE, environment: () => ({ PATH: process.env.PATH, HOME: home, USERPROFILE: home, ...env }), startupTimeoutMs: 5_000,
    });
    controllers.push(made);
    return made;
  };

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "madani-provider-sign-in-"));
    controllers = [];
  });
  afterEach(async () => {
    await Promise.all(controllers.map((made) => made.dispose()));
    await removeTempDir(home);
  });

  it("shows GitHub's code from `copilot login --device-code` and connects when GitHub accepts it", async () => {
    const dump = join(home, "login.json");
    const copilot = controller(COPILOT_DEVICE_SIGN_IN, { FAKE_LOGIN_PROVIDER: "copilot", FAKE_LOGIN_OUTCOME: "approve", FAKE_LOGIN_MS: "300", FAKE_LOGIN_DUMP: dump });
    const start = await copilot.start();
    expect(start).toMatchObject({ phase: "waiting", authorizationUrl: "https://github.com/login/device", userCode: "FAKE-1234" });
    await expect.poll(async () => (await copilot.get(start.flowId!)).phase, { timeout: 5_000 }).toBe("succeeded");
    expect(JSON.parse(readFileSync(dump, "utf8")).argv).toEqual(["login", "--device-code"]);
  });

  it("says plainly when the person declines on GitHub", async () => {
    const copilot = controller(COPILOT_DEVICE_SIGN_IN, { FAKE_LOGIN_PROVIDER: "copilot", FAKE_LOGIN_OUTCOME: "deny", FAKE_LOGIN_MS: "200" });
    const start = await copilot.start();
    await expect.poll(async () => copilot.get(start.flowId!), { timeout: 5_000 })
      .toMatchObject({ phase: "failed", message: "GitHub sign-in was declined in the browser. Start sign-in again to try once more." });
  });

  it("runs `cursor-agent login` without opening a browser on the server, and shows its link", async () => {
    const dump = join(home, "login.json");
    const cursor = controller(CURSOR_SIGN_IN, { FAKE_LOGIN_PROVIDER: "cursor", FAKE_LOGIN_OUTCOME: "approve", FAKE_LOGIN_MS: "300", FAKE_LOGIN_DUMP: dump });
    const start = await cursor.start();
    expect(start).toMatchObject({ phase: "waiting", authorizationUrl: CURSOR_LINK });
    expect(start.userCode).toBeUndefined();
    await expect.poll(async () => (await cursor.get(start.flowId!)).phase, { timeout: 5_000 }).toBe("succeeded");
    expect(JSON.parse(readFileSync(dump, "utf8"))).toEqual({ argv: ["login"], NO_OPEN_BROWSER: "1" });
  });

  it("stops a login nobody finishes when cancelled", async () => {
    const copilot = controller(COPILOT_DEVICE_SIGN_IN, { FAKE_LOGIN_PROVIDER: "copilot" });
    const start = await copilot.start();
    await copilot.cancel();
    expect((await copilot.get(start.flowId!)).phase).toBe("cancelled");
  });
});
