import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import net from "node:net";
import test from "node:test";

import { createDevServerChild, devOwnServerWanted, portTaken, watchServerSource } from "./dev-server-child.mjs";
import { createLocalComputerGrant, LOCAL_COMPUTER_GRANT } from "./local-computer-grant.mjs";

const READY = { mode: "standalone", socketPath: "/x.sock", mcpCommand: "/cua-driver", mcpArgs: ["mcp"], mcpEnv: {} };

function harness({ taken = false, ...options } = {}) {
  const forked = [];
  const grant = createLocalComputerGrant({ connection: () => READY });
  const fork = (entry, args, forkOptions) => {
    const proc = Object.assign(new EventEmitter(), {
      pid: 100 + forked.length, entry, forkOptions, sent: [], killed: false,
      postMessage(message) { this.sent.push(message); },
      kill() { this.killed = true; queueMicrotask(() => this.emit("exit", 0)); },
    });
    forked.push(proc);
    queueMicrotask(() => proc.emit("spawn"));
    return proc;
  };
  const child = createDevServerChild({
    fork, entry: "/repo/server/dev-server.ts", env: { MADANI_PORT: "8871" }, port: 8871,
    grant: (proc, isCurrent) => grant.attach(proc, isCurrent), taken: async () => taken, restartDelayMs: 1, ...options,
  });
  return { child, forked, grant };
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

test("only in a source checkout that asked for it", () => {
  assert.equal(devOwnServerWanted({ MADANI_DEV_OWN_SERVER: "1" }, false), true);
  assert.equal(devOwnServerWanted({ MADANI_DEV_OWN_SERVER: "1" }, true), false);
  assert.equal(devOwnServerWanted({}, false), false);
});

test("the dev server child the app forks is granted this computer, and a restarted one takes over the grant", async () => {
  const { child, forked, grant } = harness();
  assert.equal(await child.start(), true);
  await tick();
  const [first] = forked;
  assert.equal(first.entry, "/repo/server/dev-server.ts");
  assert.deepEqual(first.forkOptions.execArgv, ["--experimental-strip-types"]);
  assert.deepEqual(first.sent, [{ type: LOCAL_COMPUTER_GRANT, connection: READY }]);

  first.emit("exit", 1);
  await tick();
  const second = forked[1];
  assert.ok(second, "a child that died is started again");
  assert.deepEqual(second.sent, [{ type: LOCAL_COMPUTER_GRANT, connection: READY }]);
  grant.changed();
  assert.equal(first.sent.length, 1, "the dead child hears nothing more");
  assert.equal(second.sent.length, 2);
  assert.equal(child.current(), second);
});

test("a port someone else already serves is reported and nothing is forked", async () => {
  let reported = null;
  const { child, forked } = harness({ taken: true, conflict: (port) => { reported = port; } });
  assert.equal(await child.start(), false);
  assert.equal(reported, 8871);
  assert.equal(forked.length, 0);
});

test("restart swaps the child, and stop leaves none running", async () => {
  const { child, forked } = harness();
  await child.start();
  await tick();
  child.restart();
  await tick();
  assert.equal(forked[0].killed, true);
  assert.equal(child.current(), forked[1]);
  assert.equal(forked[1].sent.length, 1);
  assert.equal(await child.stop(), true);
  await tick();
  assert.equal(forked.length, 2);
  assert.equal(child.current(), null);
});

test("a child that keeps dying right away stops being restarted", async () => {
  let gaveUp = 0;
  const { child, forked } = harness({ gaveUp: (times) => { gaveUp = times; } });
  await child.start();
  for (let round = 0; round < 5; round += 1) {
    await tick();
    forked.at(-1).emit("exit", 1);
  }
  await tick();
  assert.equal(gaveUp, 5);
  assert.equal(forked.length, 5);
  child.restart();
  await tick();
  assert.equal(forked.length, 6, "a later restart tries again");
});

test("a taken port is noticed, a free one is not", async () => {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  assert.equal(await portTaken(port), true);
  await new Promise((resolve) => server.close(resolve));
  assert.equal(await portTaken(port), false);
});

test("source changes restart once after the last save; tests do not", async () => {
  const listeners = [];
  let restarts = 0;
  const close = watchServerSource({
    watch: (_dir, _options, listener) => { listeners.push(listener); return { close() {} }; },
    dirs: ["/repo/server"], restart: () => { restarts += 1; }, delayMs: 1,
  });
  listeners[0]("change", "index.ts");
  listeners[0]("change", "store.ts");
  listeners[0]("change", "store.test.ts");
  await tick();
  assert.equal(restarts, 1);
  listeners[0]("change", "chat.test.ts");
  await tick();
  assert.equal(restarts, 1);
  close();
});
