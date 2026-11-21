// Stdio bridge to the Cua MCP server in a VPS container; auth is the user's SSH config and agent, and nothing is stored here.
import { runMcpBridge } from "./mcp-bridge.ts";
import { vpsContainerMcpArgs, vpsDockerArgs } from "./vps-computer.ts";
import { DATA_DIR } from "./config.ts";
import { augmentedPath } from "./env-path.ts";
import { prepareVpsSsh } from "./vps-ssh.ts";
import { sandboxComputerResultLine } from "./sandbox-computer-guidance.ts";
import { createSandboxComputerSession } from "./sandbox-computer-session.ts";
import { createBotPointerReporter } from "./bot-pointer.ts";

const [alias, containerName, screenJson] = process.argv.slice(2);
const sshAlias = alias ?? "";
let args: string[];
try {
  args = vpsContainerMcpArgs(sshAlias, containerName ?? "", screenJson ? JSON.parse(screenJson) : undefined);
} catch {
  process.stderr.write("invalid VPS MCP connection\n");
  process.exit(2);
}

// The driving pair rides in env, not argv: argv is world-readable through `ps`.
const controlUrl = process.env.MADANI_CONTROL_URL ?? "";
const controlToken = process.env.MADANI_CONTROL_TOKEN ?? "";
const ssh = prepareVpsSsh(DATA_DIR, augmentedPath());
const session = createSandboxComputerSession();

runMcpBridge({
  command: "docker",
  args,
  env: { ...process.env, PATH: ssh.path },
  label: "VPS Cua Driver",
  // Probe the transport, not the driver: a busy desktop mid-tool-call must never look dead.
  liveness: { command: "docker", args: vpsDockerArgs(sshAlias, ["version", "--format", "{{.Server.Version}}"]) },
  rewriteRequest: session.request,
  relay: session.relay,
  rewriteResponse: (line) => session.response(sandboxComputerResultLine(line)),
  ...(controlUrl && controlToken ? { gate: { url: controlUrl, token: controlToken }, observe: createBotPointerReporter({ url: controlUrl, token: controlToken }) } : {}),
});
