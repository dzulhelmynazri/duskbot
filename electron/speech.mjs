// macOS privacy enforcement requires the code calling Speech/AVFoundation to launch with its own Info.plist identity.
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { app } from "electron";
import { tailFile } from "./speech-output.mjs";
import { createSpeechTranscript } from "./speech-transcript.mjs";

import {
  buildSpeechHelper,
  speechHelperBinary,
  speechHelperBundle,
} from "./build-speech-helper.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(__dirname, "resources", "speech-helper.swift");
const INFO = path.join(__dirname, "resources", "speech-helper-Info.plist");
// A signed app bundle must never be rewritten: lazy compilation would break its seal.
const BUNDLE = app.isPackaged
  ? path.join(process.resourcesPath, "Madani Bot Speech.app")
  : speechHelperBundle;
const BIN = app.isPackaged
  ? path.join(BUNDLE, "Contents", "MacOS", "speech-helper")
  : speechHelperBinary;
// Windows listens through System.Speech in the Windows PowerShell that ships with Windows; powershell cannot read inside app.asar.
const WINDOWS_SCRIPT = "windows-speech.ps1";
const windowsSpeechScript = () => app.isPackaged
  ? path.join(process.resourcesPath, WINDOWS_SCRIPT)
  : path.join(__dirname, "resources", WINDOWS_SCRIPT);
const windowsPowerShell = () =>
  path.win32.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
// the script exits on its stop file within 50ms; a powershell that hangs while starting up still lets the microphone go
const WINDOWS_STOP_GRACE_MS = 1_500;

let child = null;

function ensureBuilt() {
  if (app.isPackaged) return;
  const binaryMtime = existsSync(BIN) ? statSync(BIN).mtimeMs : 0;
  const stale = binaryMtime < Math.max(statSync(SRC).mtimeMs, statSync(INFO).mtimeMs);
  if (!stale) return;
  buildSpeechHelper();
}

const SPEECH_LOCALE = /^[A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{2,8}){0,3}$/;
const RELEASE_MODIFIERS = ["control", "option", "shift", "command"];
const PAGE_GONE = ["render-process-gone", "did-navigate"];

function speechTarget(target) {
  if (typeof target?.transcript === "function") return {
      owner: target,
      transcript: (line) => target.transcript(line),
      level: (value) => target.level?.(value),
      end: (info) => target.end(info),
      replaced: () => target.replaced(),
      whenGone: () => () => {},
    };
  const send = (channel, body) => {
    if (!target.isDestroyed()) target.webContents.send(channel, body);
  };
  return {
    owner: target,
    transcript: (line) => send("speech:transcript", line),
    level: (value) => send("speech:level", value),
    end: (info) => send("speech:end", info),
    replaced: () => {},
    whenGone: (listener) => {
      // Electron: a destroyed BrowserWindow throws when its webContents is read.
      const contents = target.webContents;
      target.on("closed", listener);
      for (const event of PAGE_GONE) contents.on(event, listener);
      return () => {
        target.removeListener("closed", listener);
        for (const event of PAGE_GONE) contents.removeListener(event, listener);
      };
    },
  };
}

export function speechBusy() {
  return child !== null;
}

export function startSpeech(target, options = {}) {
  const running = child;
  stopSpeech();
  running?.target.replaced();
  const sink = speechTarget(target);
  const windows = process.platform === "win32";
  if (process.platform !== "darwin" && !windows) {
    sink.end({ code: 2, reason: "unsupported-platform" });
    return;
  }
  const requested = Number(options?.endpointMs);
  const endpointMs = Number.isFinite(requested) && requested > 0
    ? Math.min(5_000, Math.max(250, Math.round(requested)))
    : 0;
  const args = endpointMs ? ["--endpoint-ms", String(endpointMs)] : [];
  const release = [...new Set(Array.isArray(options?.finishOnRelease) ? options.finishOnRelease : [])]
    .filter((name) => RELEASE_MODIFIERS.includes(name));
  if (release.length) args.push("--finish-on-release", release.join(","));
  const locale = typeof options?.locale === "string" ? options.locale.trim() : "";
  if (SPEECH_LOCALE.test(locale)) args.push("--locale", locale);

  if (windows) {
    startWindowsSpeech(sink, { endpointMs, locale: SPEECH_LOCALE.test(locale) ? locale : "" });
    return;
  }

  try {
    ensureBuilt();
  } catch {
    sink.end({ code: 1, reason: "helper-build-failed" });
    return;
  }

  // A direct spawn loses the bundle identity and TCC kills it; LaunchServices keeps it. `open` sends stdout/stderr to files, tailed here.
  const sessionDir = mkdtempSync(path.join(app.getPath("temp"), "madanibot-speech-"));
  const outputPath = path.join(sessionDir, "stdout.ndjson");
  const errorPath = path.join(sessionDir, "stderr.log");
  const stopPath = path.join(sessionDir, "stop");
  const finishPath = path.join(sessionDir, "finish");
  writeFileSync(outputPath, "");
  writeFileSync(errorPath, "");

  let proc;
  try {
    proc = spawn(
      "/usr/bin/open",
      [
        "-n",
        "-g",
        "-W",
        "-o",
        outputPath,
        "--stderr",
        errorPath,
        BUNDLE,
        "--args",
        ...args,
        "--stop-file",
        stopPath,
        "--finish-file",
        finishPath,
      ],
      { stdio: "ignore" },
    );
  } catch {
    rmSync(sessionDir, { recursive: true, force: true });
    sink.end({ code: 1, reason: "helper-start-failed" });
    return;
  }

  let feed = () => {};
  const output = tailFile(outputPath, (fresh) => feed(fresh));
  feed = trackSession(sink, proc, {
    stopPath, finishPath, sessionDir,
    flush: output.flush,
    release: output.close,
  });
}

function startWindowsSpeech(sink, { endpointMs, locale }) {
  const sessionDir = mkdtempSync(path.join(app.getPath("temp"), "madanibot-speech-"));
  const stopPath = path.join(sessionDir, "stop");
  const finishPath = path.join(sessionDir, "finish");
  const args = [
    "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
    "-File", windowsSpeechScript(),
    ...(endpointMs ? ["-EndpointMs", String(endpointMs)] : []),
    ...(locale ? ["-Locale", locale] : []),
    "-StopFile", stopPath,
    "-FinishFile", finishPath,
  ];
  let proc;
  try {
    proc = spawn(windowsPowerShell(), args, { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
  } catch {
    rmSync(sessionDir, { recursive: true, force: true });
    sink.end({ code: 1, reason: "helper-start-failed" });
    return;
  }
  const halt = () => {
    const timer = setTimeout(() => {
      if (proc.exitCode === null && proc.signalCode === null) proc.kill();
    }, WINDOWS_STOP_GRACE_MS);
    timer.unref?.();
  };
  const feed = trackSession(sink, proc, { stopPath, finishPath, sessionDir, halt });
  proc.stdout?.setEncoding("utf8");
  proc.stdout?.on("data", feed);
}

// One helper run, on either transport: its NDJSON lines reach the sink as transcripts and levels, and its exit as speech:end.
function trackSession(sink, proc, { stopPath, finishPath, sessionDir, halt, flush = () => {}, release = () => {} }) {
  const speechSession = {
    proc, stopPath, finishPath, sessionDir, halt,
    owner: sink.owner, target: sink,
  };
  child = speechSession;
  const forgetWindow = sink.whenGone(() => stopSpeech(sink.owner));
  let buf = "";
  let reportedError = null;
  let completed = false;
  const transcript = createSpeechTranscript();

  const feed = (chunk) => {
    buf += chunk;
    let nl;
    let level = null;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try {
        const parsed = JSON.parse(line);
        // loudness for the waveform: one message per read, the loudest of its lines
        if (typeof parsed.level === "number" && Number.isFinite(parsed.level)) {
          level = Math.max(level ?? 0, Math.min(1, Math.max(0, parsed.level)));
          continue;
        }
        if (typeof parsed.error === "string") reportedError = parsed.error;
        if (parsed.partial === false && typeof parsed.text === "string") completed = true;
        // A stopped or replaced helper can flush one last chunk: never into the session that replaced it.
        if (child === speechSession) sink.transcript(transcript(parsed));
      } catch {
      }
    }
    if (level !== null && child === speechSession) sink.level(level);
  };

  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    forgetWindow();
    release();
    rmSync(sessionDir, { recursive: true, force: true });
  };
  proc.on("close", (code) => {
    flush();
    cleanup();
    // stopSpeech() clears child before the stop marker, so intentional TTS muting never looks like the end of a spoken turn.
    if (child !== speechSession) return;
    child = null;
    if (reportedError) {
      sink.end({ code: 1, reason: reportedError });
    } else if (completed && code === 0) {
      sink.end({ code: 0, reason: "completed" });
    } else {
      sink.end({ code: 1, reason: "helper-exited" });
    }
  });
  proc.on("error", () => {
    cleanup();
    if (child !== speechSession) return;
    child = null;
    sink.end({ code: 1, reason: "helper-start-failed" });
  });
  return feed;
}

const ownedBy = (owner) => child !== null && (owner === undefined || child.owner === owner);

export function stopSpeech(owner) {
  if (!ownedBy(owner)) return;
  const speechSession = child;
  child = null;
  try {
    writeFileSync(speechSession.stopPath, "stop");
  } catch {}
  speechSession.halt?.();
}

export function finishSpeech(owner) {
  if (!ownedBy(owner)) return;
  try {
    writeFileSync(child.finishPath, "finish");
  } catch {}
}
