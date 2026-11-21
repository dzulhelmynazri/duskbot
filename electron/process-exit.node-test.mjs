import assert from "node:assert/strict";
import test from "node:test";
import { createStderrTail, exitCodeText, serviceWord } from "./process-exit.mjs";

test("exit codes read the way Windows names them", () => {
  assert.equal(exitCodeText(-36861, "win32"), "-36861 0xFFFF7003");
  assert.equal(exitCodeText(-1073741819, "win32"), "0xC0000005 access violation");
  assert.equal(exitCodeText(3221226505, "win32"), "0xC0000409 fail-fast");
  assert.equal(exitCodeText(1, "win32"), "1");
  assert.equal(exitCodeText(-36861, "linux"), "-36861");
  assert.equal(exitCodeText(undefined, "win32"), "none");
});

test("a process name becomes one analytics word", () => {
  assert.equal(serviceWord("Network Service"), "network_service");
  assert.equal(serviceWord("madani bot server"), "madani_bot_server");
  assert.equal(serviceWord(""), null);
  assert.equal(serviceWord(undefined), null);
});

test("the stderr tail keeps the latest failure line, scrubbed", () => {
  const tail = createStderrTail(5);
  tail.push("listening on 8811\nError: boom\n");
  tail.push("libc++abi: terminating due to uncaught exception of type std::system_error: mutex lock failed\nbye\n");
  assert.equal(tail.problem(), "libc++abi: terminating due to uncaught exception of type std::system_error: mutex lock failed");
  const quiet = createStderrTail(2);
  quiet.push("Error: early\na\nb\n");
  assert.equal(quiet.problem(), null);
  const pathy = createStderrTail();
  pathy.push("Error: cannot open C:\\Users\\Ravi\\notes.txt for ravi@example.com");
  assert.equal(pathy.problem(), "Error: cannot open ~\\notes.txt for [email]");
});
