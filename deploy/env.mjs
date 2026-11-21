#!/usr/bin/env node
// builds one app's env file from the operator's single secrets file, ~/.config/madanibot/madani.env (MADANI_ENV overrides).
//   node deploy/env.mjs <preview|production|landing> <out>     writes the app's env (mode 600) to <out>
//   node deploy/env.mjs compare <target> <old env file>        names + match/mismatch per value, never the values
// madani.env is split into sections by "# [name]" lines:
//   [account]     plain names, sent to both account services (preview and production)
//   [preview]     NAME_PREVIEW, sent to preview as NAME (same for [production] and [landing])
//   [local]       used on the Mac only (cloudflare, mongo admin, ...), never sent anywhere
// a value written exactly as ${NAME} reuses another entry (define it higher up so `. madani.env` resolves it too).
// values are copied as written (quotes included), so the deploy CLI reads them the same way it read the old files.
import { createHash } from "node:crypto";
import { chmodSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const TARGETS = { preview: ["account", "preview"], production: ["account", "production"], landing: ["landing"] };
const SECTIONS = new Set(["account", "preview", "production", "landing", "local"]);
const source = process.env.MADANI_ENV || join(homedir(), ".config/madanibot/madani.env");

const fail = (msg) => {
  console.error(`env: ${msg}`);
  process.exit(1);
};

function readSource() {
  let mode;
  try {
    mode = statSync(source).mode & 0o777;
  } catch {
    fail(`missing ${source}`);
  }
  if (mode !== 0o600) fail(`${source} must be mode 600`);
  const entries = [];
  const raw = new Map();
  let section = null;
  for (const [i, line] of readFileSync(source, "utf8").split(/\r?\n/).entries()) {
    const head = line.match(/^#\s*\[([a-z]+)\]/);
    if (head) {
      if (!SECTIONS.has(head[1])) fail(`line ${i + 1}: unknown section [${head[1]}]`);
      section = head[1];
      continue;
    }
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const m = t.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!m) fail(`line ${i + 1}: not NAME=value`);
    if (!section) fail(`line ${i + 1}: ${m[1]} is outside a section`);
    if (raw.has(m[1])) fail(`${m[1]} is set twice`);
    raw.set(m[1], m[2]);
    entries.push({ section, name: m[1], value: m[2] });
  }
  return { entries, raw };
}

function build(target) {
  const sections = TARGETS[target];
  if (!sections) fail(`unknown target ${target} (preview, production or landing)`);
  const { entries, raw } = readSource();
  const out = new Map();
  for (const { section, name, value } of entries) {
    if (!sections.includes(section)) continue;
    let key = name;
    if (section !== "account") {
      const suffix = `_${section.toUpperCase()}`;
      if (!name.endsWith(suffix)) fail(`${name} in [${section}] must end with ${suffix}`);
      key = name.slice(0, -suffix.length);
    }
    if (out.has(key)) fail(`${key} is set in [account] and [${section}]`);
    const ref = value.match(/^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/);
    if (ref && !raw.has(ref[1])) fail(`${name} points at ${ref[1]}, which is not in ${source}`);
    out.set(key, ref ? raw.get(ref[1]) : value);
  }
  return out;
}

// the deploy CLI's own parser (~/.local/bin/deploy parseEnvFile), so the comparison sees what the server gets
function parse(text) {
  const env = {};
  for (let line of text.split(/\r?\n/)) {
    line = line.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"') && v.length >= 2) || (v.startsWith("'") && v.endsWith("'") && v.length >= 2)) {
      const dq = v.startsWith('"');
      v = v.slice(1, -1);
      if (dq) v = v.replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    } else {
      v = v.replace(/\s+#.*$/, "");
    }
    env[m[1]] = v;
  }
  return env;
}

const text = (env) => [...env].map(([k, v]) => `${k}=${v}\n`).join("");
const [cmd, ...args] = process.argv.slice(2);
if (cmd === "compare") {
  const [target, oldFile] = args;
  if (!target || !oldFile) fail("usage: env.mjs compare <target> <old env file>");
  const now = parse(text(build(target)));
  const old = parse(readFileSync(oldFile, "utf8"));
  const hash = (v) => (v === undefined ? null : createHash("sha256").update(v).digest("hex"));
  let bad = 0;
  for (const name of new Set([...Object.keys(old), ...Object.keys(now)])) {
    const state = !(name in old) ? "only in new" : !(name in now) ? "only in old" : hash(old[name]) === hash(now[name]) ? "match" : "MISMATCH";
    if (state !== "match") bad++;
    console.log(`${name.padEnd(42)} ${state}`);
  }
  console.log(`${target}: ${Object.keys(now).length} names, ${bad ? `${bad} differ` : "all match"}`);
  process.exit(bad ? 1 : 0);
} else if (TARGETS[cmd] && args[0]) {
  writeFileSync(args[0], text(build(cmd)), { mode: 0o600 });
  chmodSync(args[0], 0o600);
} else {
  fail("usage: env.mjs <preview|production|landing> <out> | compare <target> <old env file>");
}
