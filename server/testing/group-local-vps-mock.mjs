export {
  VPS_IMAGE, VPS_MANAGED_LABEL, VPS_CONTAINER_LABEL, VPS_ENVIRONMENT_LABEL, VPS_VIEWER_LABEL, VPS_CONTAINER_PREFIX,
  vpsDesktopProbeArgs, vpsLifecycleBusy, vpsComputerPreparing, vpsStartsForTurn, vpsUnavailableHint, vpsContainerName,
  vpsDockerArgs, vpsSshTunnelArgs, vpsContainerRunArgs, vpsContainerMcpArgs,
  closeVpsDesktopTunnel, closeAllVpsDesktopTunnels, closeVpsScreenConnections, vpsDesktopConnection,
} from '../vps-computer.ts?actual';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { writeFileAtomic } from '../atomic.ts';
import { vpsContainerName } from '../vps-computer.ts?actual';

const file = process.env.MADANI_TEST_VPS_STATE;
if (!file) throw new Error('An explicit isolated VPS state file is required');
const read = () => JSON.parse(readFileSync(file, 'utf8'));

export async function vpsComputerStatus(cfg, ownerId) {
  const state = read();
  const alias = cfg.vps?.sshAlias || null;
  const container = state.containers?.[ownerId] ?? 'missing';
  // unreachable: the VPS answers no ssh, so its desktop can be neither inspected nor started
  const reachable = Boolean(alias) && !state.unreachable;
  const ready = reachable && container === 'running';
  return {
    configured: Boolean(alias), sshAlias: alias, desktop: 'cua', daemonUp: reachable, image: true, imageMatches: true,
    managed: container !== 'missing', container, network: 'private', mounts: 'none', security: 'hardened',
    desktopReady: ready, desktop_error: null, ready, problem: ready ? null : state.unreachable || 'Fixture VPS computer is not running',
    container_name: vpsContainerName(ownerId), container_id: container === 'missing' ? null : createHash('sha256').update(ownerId).digest('hex'),
    image_id: 'sha256:fixture-image', image_ref: 'fixture-desktop', base_image_ref: 'fixture-base', driver_version: 'fixture',
  };
}

export async function vpsComputerAction(action, cfg, ownerId) {
  const before = await vpsComputerStatus(cfg, ownerId);
  if (!before.configured) throw new Error('Connect a VPS first');
  if (!before.daemonUp) throw new Error(before.problem);
  if (action === 'provision' && before.ready) return before;
  const state = read();
  const operation = action === 'provision' ? before.container === 'missing' ? 'create' : 'start' : action;
  state.containers = { ...state.containers, [ownerId]: operation === 'stop' ? 'stopped' : operation === 'remove' ? 'missing' : 'running' };
  state.actions = [...(state.actions ?? []), { action: operation, ownerId }];
  writeFileAtomic(file, JSON.stringify(state), { durable: false });
  return vpsComputerStatus(cfg, ownerId);
}

export async function removeManagedVpsComputer(_cfg, owners, name, confirmed) {
  if (name !== confirmed) throw new Error('Fixture computer confirmation does not match');
  const state = read();
  const ownerId = Object.keys(state.containers ?? {}).find(owner => vpsContainerName(owner) === name);
  if (!ownerId || owners.find(owner => owner.botId === ownerId)?.inUse) throw new Error('Fixture computer is missing or busy');
  delete state.containers[ownerId];
  state.actions = [...(state.actions ?? []), { action: 'remove', ownerId }];
  writeFileAtomic(file, JSON.stringify(state), { durable: false });
  return { removed: true, name };
}

// a vm_exec on a fixture desktop answers like the real wrapper (the exit marker on stderr); any other command is refused
export async function defaultRunner(args) {
  if (!args.includes('madani-exec')) throw new Error('Unexpected real VPS command in isolated fixture');
  const [command, marker] = args.slice(-2);
  const state = read();
  state.execs = [...(state.execs ?? []), command];
  writeFileAtomic(file, JSON.stringify(state), { durable: false });
  return { stdout: `fixture ran ${command}\n`, stderr: `\n${marker}0\n` };
}

export const inspectVpsForAuto = vpsComputerStatus;
export async function reuseVps(cfg, ownerId) { const status = await vpsComputerStatus(cfg, ownerId); return status.ready ? status : null; }
export async function vpsBoxChrome() { return null; }
export function vpsComputerMcp(cfg, ownerId, containerId) {
  return { command: process.execPath, args: [fileURLToPath(new URL('./fake-vps-driver.mjs', import.meta.url)), 'fixture-vps-mcp', cfg.vps.sshAlias, ownerId, containerId], env: {} };
}
export async function vpsComputerScreenshot() {
  return { png: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+X2ioAAAAASUVORK5CYII=', format: 'png' };
}
export async function vpsComputerJoin(cfg, ownerId) {
  const status = await vpsComputerStatus(cfg, ownerId);
  if (!status.ready) throw new Error('Fixture VPS computer is not ready');
  return { joinUrl: 'http://127.0.0.1:1/vnc.html', ...status };
}
export async function listManagedVpsComputers(cfg, owners) {
  const state = read();
  const alias = cfg.vps?.sshAlias || null;
  return { configured: Boolean(alias), available: Boolean(alias), vpsAliases: alias ? [alias] : [], problem: null,
    instances: Object.entries(state.containers ?? {}).filter(([, status]) => status !== 'missing').map(([ownerId, status]) => ({
      name: vpsContainerName(ownerId), state: status === 'running' ? 'running' : 'exited', vpsAlias: alias,
      ownerBotId: ownerId, ownerName: owners.find(owner => owner.botId === ownerId)?.name ?? null, orphaned: false, inUse: false,
    })) };
}
