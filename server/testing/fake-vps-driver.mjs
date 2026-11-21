// stands in for `docker exec <desktop> cua mcp` behind the vps bridge: answers mcp over stdio, and before each tools/call
// asks the turn's control gate as the real bridge does. calls are appended to MADANI_TEST_VPS_DRIVER_LOG when set.
import { appendFileSync } from 'node:fs';

const [, , , alias, ownerId, containerId] = process.argv;
const TOOLS = [
  { name: 'screenshot', description: 'Capture the desktop.', inputSchema: { type: 'object', properties: {} } },
  { name: 'launch_app', description: 'Open an app or URL.', inputSchema: { type: 'object', properties: { url: { type: 'string' } } } },
];
const write = (frame) => process.stdout.write(`${JSON.stringify(frame)}\n`);
const gate = async () => {
  const url = process.env.MADANI_CONTROL_URL, token = process.env.MADANI_CONTROL_TOKEN;
  if (!url || !token) return { held: false };
  const response = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  return response.ok ? response.json() : { held: true, blockedReason: `gate answered ${response.status}` };
};
const answer = async (frame) => {
  if (frame.method === 'initialize') return { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'fixture-vps-mcp', version: '1' } };
  if (frame.method === 'tools/list') return { tools: TOOLS };
  if (frame.method !== 'tools/call') return null;
  const state = await gate();
  if (process.env.MADANI_TEST_VPS_DRIVER_LOG) appendFileSync(process.env.MADANI_TEST_VPS_DRIVER_LOG, `${JSON.stringify({ alias, ownerId, containerId, call: frame.params, held: Boolean(state.held) })}\n`);
  if (state.held) return { isError: true, content: [{ type: 'text', text: state.blockedReason ?? 'held' }] };
  return { content: [{ type: 'text', text: `fixture ${frame.params?.name} on ${ownerId}` }] };
};
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  for (let at = buffer.indexOf('\n'); at !== -1; at = buffer.indexOf('\n')) {
    const frame = JSON.parse(buffer.slice(0, at));
    buffer = buffer.slice(at + 1);
    if (frame.id === undefined) continue;
    void answer(frame).then((result) => write(result === null
      ? { jsonrpc: '2.0', id: frame.id, error: { code: -32601, message: 'Method not found' } }
      : { jsonrpc: '2.0', id: frame.id, result }));
  }
});
