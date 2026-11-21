import { existsSync } from "node:fs";
import { COMPUTER_UNREACHABLE } from "../shared/computer-unreachable.ts";

/** Root's copy of the installer on a server the link service set up; `--repair` brings its units and docker gate back. */
export const SERVER_REPAIR_SCRIPT = "/usr/local/lib/madanibot/install.sh";
export const SERVER_REPAIR_COMMAND = `sudo sh ${SERVER_REPAIR_SCRIPT} --repair`;

// a Go docker client reports a connection its daemon (or the docker gate in front of it) closed without an answer as
// a bare EOF; a restarting gate or daemon shows as a refused or missing socket for a second or two
const TRANSIENT = /timed out|connection reset by peer|broken pipe|: EOF\b|\bunexpected EOF\b|connect: connection refused|connect: no such file or directory|docker gate: docker (?:is not reachable|closed the connection|could not be asked)/i;

export function isTransientDockerTransport(message: string): boolean {
  return TRANSIENT.test(message);
}

/** Runs a read-only docker call again after a transient transport failure, waiting `delays` ms before each retry. */
export async function retryTransient<T>(run: () => Promise<T>, delays: readonly number[] = [400, 1_500]): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try { return await run(); }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (attempt >= delays.length || !isTransientDockerTransport(message)) throw error;
      await new Promise((resolve) => setTimeout(resolve, delays[attempt]));
    }
  }
}

/** The problem a person reads when docker could not be asked; the raw transport words go to the log only. */
export function dockerUnreachableProblem(
  message: string,
  where: { thisServer: boolean; alias: string | null },
  repairable: () => boolean = () => existsSync(SERVER_REPAIR_SCRIPT),
): string {
  console.warn(`vps computer: docker could not be asked on ${where.thisServer ? "this server" : where.alias ?? "the VPS"}: ${message.replace(/\s+/g, " ").trim().slice(0, 400)}`);
  if (where.thisServer) {
    return repairable() ? `${COMPUTER_UNREACHABLE} If it keeps happening, run ${SERVER_REPAIR_COMMAND} on the server.` : COMPUTER_UNREACHABLE;
  }
  if (/timed out/i.test(message)) {
    return "The VPS didn't answer in time. Check that it is online and reachable over SSH from this computer, then try again. No computer was reset.";
  }
  return "The VPS's Docker can't be reached over SSH right now. Check that the VPS is online and Docker is running on it, then try again.";
}

const GATE_SOCKET = /^unix:\/\/\/run\/(madanibot|openmausbot)-docker\/docker\.sock$/;

/**
 * DOCKER_HOST with the docker gate's socket under whichever name this server has: an install from before the rename
 * listens under /run/openmausbot-docker, a newer one under /run/madanibot-docker, and a server unit can carry either.
 */
export function gateDockerHost(host: string | undefined, socketExists: (path: string) => boolean = existsSync): string | undefined {
  const match = host ? GATE_SOCKET.exec(host.trim()) : null;
  if (!match) return host;
  const path = host!.trim().slice("unix://".length);
  if (socketExists(path)) return host;
  const other = `/run/${match[1] === "madanibot" ? "openmausbot" : "madanibot"}-docker/docker.sock`;
  return socketExists(other) ? `unix://${other}` : host;
}

/** Whether DOCKER_HOST is a docker gate's socket, under either name. */
export function isGateSocket(host: string | undefined): boolean {
  return /\/(?:madanibot|openmausbot)-docker\/docker\.sock$/.test(host?.trim() ?? "");
}
