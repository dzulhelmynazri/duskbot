// Voice input through a speech service the person set up in Settings > Voice. The page sends its microphone's PCM here;
// this process holds the keys, talks to the service (voice-providers.mjs) or runs whisper.cpp, and sends the words back.
// Keys never cross to a page: the page learns only which services have one.
import { spawn as nodeSpawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { homedir as nodeHomedir, tmpdir as nodeTmpdir } from "node:os";
import path from "node:path";
import { VOICE_PROVIDERS, VOICE_PROVIDER_INFO, isVoiceProvider, voiceProviderModel } from "./voice-catalog.mjs";
import { VoiceProviderError, createPieceSession, transcribeClip } from "./voice-providers.mjs";

export const VOICE_KEYS_CREDENTIAL_KEY = "voiceInputKeys";
const KEY_MAX = 4_096;
const SESSION_MAX_MS = 10 * 60_000;
// 10 minutes of 16 kHz 16-bit mono, with a little room
const SESSION_MAX_BYTES = 20_000_000;
const CHUNK_MAX_BYTES = 256 * 1024;
const WHISPER_TIMEOUT_MS = 120_000;
const WHISPER_OUTPUT_MAX = 1_000_000;
const WHISPER_PROGRAMS = new Set(["whisper-cli", "whisper-cpp", "whisper", "main", "whisper-cli.exe", "whisper.exe", "main.exe"]);
const REALTIME_FINISH_MS = 8_000;

const keyless = (provider) => VOICE_PROVIDER_INFO[provider].key === "none";

/** The saved keys, only well-formed entries for known services. */
export function readVoiceKeys(credentials) {
  const saved = credentials?.[VOICE_KEYS_CREDENTIAL_KEY];
  const keys = {};
  if (!saved || typeof saved !== "object" || Array.isArray(saved)) return keys;
  for (const provider of VOICE_PROVIDERS) {
    const key = saved[provider];
    if (!keyless(provider) && typeof key === "string" && key && key.length <= KEY_MAX) keys[provider] = key;
  }
  return keys;
}

/** Which services have a key on this computer: booleans only. */
export function voiceKeyStatus(credentials) {
  const keys = readVoiceKeys(credentials);
  const status = {};
  for (const provider of VOICE_PROVIDERS) if (!keyless(provider)) status[provider] = Object.hasOwn(keys, provider);
  return status;
}

function keyProvider(provider) {
  if (!isVoiceProvider(provider) || keyless(provider)) throw new Error("That speech service does not take a key.");
  return provider;
}

function cleanKey(key) {
  const value = typeof key === "string" ? key.trim() : "";
  if (!value || value.length > KEY_MAX || /\s/.test(value) || [...value].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) throw new Error("That does not look like a key.");
  return value;
}

const text = (value, max, pattern) => {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || value.length > max || (pattern && !pattern.test(value))) throw new Error("Voice input was asked with settings it cannot use.");
  return value;
};

/** The page's session options, checked field by field; anything else is dropped. */
export function sessionOptions(options) {
  if (!options || typeof options !== "object") throw new Error("Voice input was asked with settings it cannot use.");
  const { provider } = options;
  if (!isVoiceProvider(provider)) throw new Error("That speech service is not available.");
  const language = text(options.language, 35, /^[A-Za-z]{2,3}([-_][A-Za-z0-9]{1,8})*$/);
  const model = text(options.model, 100, /^[\w.:/-]+$/);
  const baseUrl = text(options.baseUrl, 2_000);
  let whisperCpp;
  if (provider === "whisper-cpp") {
    const binary = text(options.whisperCpp?.binary, 2_000);
    const modelFile = text(options.whisperCpp?.model, 2_000);
    whisperCpp = { binary: binary ?? "", model: modelFile ?? "" };
  }
  return { provider, language, model, realtime: options.realtime === true, baseUrl, whisperCpp };
}

/** The bytes of one audio message, or null when it is not 16-bit PCM. */
function pcmOf(value) {
  let bytes = null;
  if (value instanceof ArrayBuffer) bytes = new Uint8Array(value);
  else if (ArrayBuffer.isView(value)) bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (!bytes || !bytes.byteLength || bytes.byteLength % 2 || bytes.byteLength > CHUNK_MAX_BYTES) return null;
  // copy: aligned, and owned by this session
  return new Int16Array(bytes.slice().buffer);
}

const isAbsoluteFile = (value) => typeof value === "string" && path.isAbsolute(value) && !value.includes("\0");

/** whisper.cpp's printed words without timestamps or its [BLANK_AUDIO]-style markers. */
export function whisperText(stdout) {
  return String(stdout)
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*\[[\d:.]+\s*-->\s*[\d:.]+\]\s*/, "").replace(/\[[A-Z_ ]+\]|\([a-z ]+\)/g, "").trim())
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

/** whisper.cpp programs and ggml models in the usual places on this computer. */
export async function findWhisperCpp({ env = process.env, homedir = nodeHomedir(), platform = process.platform, fs = { readdir, stat, access } } = {}) {
  const exe = platform === "win32" ? ".exe" : "";
  const pathDirs = String(env.PATH ?? "").split(path.delimiter).filter((dir) => dir && path.isAbsolute(dir));
  const binDirs = [...new Set([...pathDirs, "/opt/homebrew/bin", "/usr/local/bin",
    path.join(homedir, "whisper.cpp", "build", "bin"), path.join(homedir, "whisper.cpp")])];
  const modelDirs = [path.join(homedir, ".cache", "whisper"), path.join(homedir, "whisper.cpp", "models"),
    "/opt/homebrew/share/whisper-cpp", "/usr/local/share/whisper-cpp", "/opt/homebrew/share/whisper.cpp", "/usr/local/share/whisper.cpp"];
  const names = ["whisper-cli", "whisper-cpp"].map((name) => name + exe);
  const binaries = [];
  await Promise.all(binDirs.map(async (dir) => {
    const own = dir.includes("whisper.cpp") ? [...names, `main${exe}`] : names;
    for (const name of own) {
      const file = path.join(dir, name);
      try {
        if ((await fs.stat(file)).isFile()) {
          await fs.access(file, fsConstants.X_OK);
          binaries.push(file);
        }
      } catch {
      }
    }
  }));
  const models = [];
  await Promise.all(modelDirs.map(async (dir) => {
    let entries;
    try {
      entries = await fs.readdir(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (!/^ggml-[\w.-]+\.bin$/.test(name)) continue;
      try {
        if ((await fs.stat(path.join(dir, name))).isFile()) models.push(path.join(dir, name));
      } catch {
      }
    }
  }));
  const order = (list, dirs) => [...new Set(list)].sort((a, b) => dirs.indexOf(path.dirname(a)) - dirs.indexOf(path.dirname(b)) || a.localeCompare(b));
  return { binaries: order(binaries, binDirs), models: order(models, modelDirs) };
}

/** A whisper.cpp program and model the person picked: absolute, a known program name, there and runnable. */
async function checkWhisper({ binary, model }, fs = { stat, access }) {
  const fail = () => new VoiceProviderError("not-set-up", "Pick a whisper.cpp program and model in Settings > Voice first.");
  if (!isAbsoluteFile(binary) || !WHISPER_PROGRAMS.has(path.basename(binary))) throw fail();
  if (!isAbsoluteFile(model) || !/\.bin$/i.test(model)) throw fail();
  try {
    if (!(await fs.stat(binary)).isFile() || !(await fs.stat(model)).isFile()) throw fail();
    await fs.access(binary, fsConstants.X_OK);
  } catch {
    throw fail();
  }
}

/** One piece through whisper.cpp: a temp WAV, the program, its printed words. The temp folder is always removed. */
export function whisperRunner({ binary, model, language, spawn = nodeSpawn, tmpdir = nodeTmpdir, fs = { mkdtemp, writeFile, rm } }) {
  const lang = typeof language === "string" ? language.split(/[-_]/)[0].toLowerCase() : "";
  return async (wav, signal) => {
    const dir = await fs.mkdtemp(path.join(tmpdir(), "madani-voice-"));
    try {
      const file = path.join(dir, "piece.wav");
      await fs.writeFile(file, wav, { mode: 0o600 });
      return await new Promise((resolve, reject) => {
        if (signal?.aborted) return reject(signal.reason ?? new Error("stopped"));
        const child = spawn(binary, ["-m", model, "-f", file, "-l", /^[a-z]{2,3}$/.test(lang) ? lang : "auto", "-nt", "-np"], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
        let out = "", err = "", done = false;
        const finish = (run) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          run();
        };
        const onAbort = () => { child.kill("SIGKILL"); finish(() => reject(signal.reason ?? new Error("stopped"))); };
        const timer = setTimeout(() => { child.kill("SIGKILL"); finish(() => reject(new VoiceProviderError("service", "whisper.cpp took too long."))); }, WHISPER_TIMEOUT_MS);
        signal?.addEventListener("abort", onAbort, { once: true });
        child.stdout.on("data", (chunk) => { if (out.length < WHISPER_OUTPUT_MAX) out += chunk; });
        child.stderr.on("data", (chunk) => { err = (err + chunk).slice(-2_000); });
        child.on("error", (error) => finish(() => reject(error?.code === "ENOENT"
          ? new VoiceProviderError("not-set-up", "The whisper.cpp program was not found.")
          : new VoiceProviderError("service", "whisper.cpp could not start."))));
        child.on("close", (code) => finish(() => (code === 0
          ? resolve(whisperText(out))
          : reject(new VoiceProviderError("service", `whisper.cpp stopped (${code}). ${err.trim().split(/\r?\n/).pop()?.slice(0, 200) ?? ""}`.trim())))));
      });
    } finally {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  };
}

/** ElevenLabs Scribe realtime over a WebSocket, behind the same push/finish/stop as a piece session. The key never goes
 * on the socket: a single-use token is minted with it first. */
export function createRealtimeSession({ key, model, language, onText, onError, fetch = globalThis.fetch, WebSocket = globalThis.WebSocket, finishMs = REALTIME_FINISH_MS }) {
  const committed = [];
  let partial = "";
  let socket = null;
  let pending = [];
  let stopped = false, failed = false, closed = false;
  let finishing = null;
  const live = () => !stopped && !failed;
  const all = () => [...committed, partial].map((part) => part.trim()).filter(Boolean).join(" ");

  const fail = (error) => {
    if (!live()) return;
    failed = true;
    try { socket?.close(); } catch {}
    onError(error);
    finishing?.resolve();
  };

  const sendChunk = (pcm, commit = false) => {
    const audio = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).toString("base64");
    socket.send(JSON.stringify({ message_type: "input_audio_chunk", audio_base_64: audio, commit, sample_rate: 16_000 }));
  };

  const ERRORS = {
    auth_error: "bad-key", quota_exceeded: "rate-limited", rate_limited: "rate-limited", resource_exhausted: "rate-limited",
    queue_overflow: "rate-limited", session_time_limit_exceeded: "service", input_error: "service", chunk_size_exceeded: "service",
    insufficient_audio_activity: "service", transcriber_error: "service", invalid_request: "service", unaccepted_terms: "bad-key", commit_throttled: "service", error: "service",
  };

  const onMessage = (data) => {
    if (!live()) return;
    let message;
    try {
      message = JSON.parse(typeof data === "string" ? data : Buffer.from(data).toString("utf8"));
    } catch {
      return;
    }
    const type = message?.message_type;
    if (type === "partial_transcript") {
      partial = typeof message.text === "string" ? message.text : "";
      const heard = all();
      if (heard) onText(heard, true);
    } else if (type === "committed_transcript" || type === "committed_transcript_with_timestamps") {
      if (type === "committed_transcript_with_timestamps") return;
      if (typeof message.text === "string" && message.text.trim()) committed.push(message.text);
      partial = "";
      const heard = all();
      if (heard) onText(heard, true);
      finishing?.resolve();
    } else if (Object.hasOwn(ERRORS, type) || (typeof type === "string" && type.endsWith("error"))) {
      const detail = typeof message.error === "string" ? message.error.slice(0, 200) : "";
      fail(new VoiceProviderError(ERRORS[type] ?? "service", `ElevenLabs stopped listening.${detail ? ` ${detail}` : ""}`));
    }
  };

  const open = async () => {
    const minted = await fetch("https://api.elevenlabs.io/v1/single-use-token/realtime_scribe", { method: "POST", headers: { "xi-api-key": key } })
      .catch(() => { throw new VoiceProviderError("network", "Could not reach ElevenLabs."); });
    if (minted.status === 401 || minted.status === 403) throw new VoiceProviderError("bad-key", "ElevenLabs did not accept the key.", minted.status);
    if (minted.status === 429) throw new VoiceProviderError("rate-limited", "ElevenLabs is busy or out of credit right now.", 429);
    if (!minted.ok) throw new VoiceProviderError("service", `ElevenLabs answered ${minted.status}.`, minted.status);
    const { token } = await minted.json().catch(() => ({}));
    if (typeof token !== "string" || !token) throw new VoiceProviderError("service", "ElevenLabs did not open a session.");
    if (!live()) return;
    const query = new URLSearchParams({ model_id: model, token, audio_format: "pcm_16000", commit_strategy: "vad" });
    const lang = typeof language === "string" ? language.split(/[-_]/)[0].toLowerCase() : "";
    if (/^[a-z]{2,3}$/.test(lang)) query.set("language_code", lang);
    socket = new WebSocket(`wss://api.elevenlabs.io/v1/speech-to-text/realtime?${query}`);
    socket.binaryType = "arraybuffer";
    socket.addEventListener("open", () => {
      if (!live()) return socket.close();
      for (const pcm of pending.splice(0)) sendChunk(pcm);
      if (closed) commitAndWait();
    });
    socket.addEventListener("message", (event) => onMessage(event.data));
    socket.addEventListener("error", () => fail(new VoiceProviderError("network", "The connection to ElevenLabs failed.")));
    socket.addEventListener("close", (event) => {
      if (live() && !closed) fail(new VoiceProviderError(event.code === 1008 ? "bad-key" : "service", "ElevenLabs closed the connection."));
      finishing?.resolve();
    });
  };

  // a commit with no new audio makes the service send whatever it still holds
  const commitAndWait = () => {
    if (socket?.readyState === 1) sendChunk(new Int16Array(0), true);
  };

  open().catch(fail);

  return {
    push(pcm) {
      if (closed || !live() || !(pcm instanceof Int16Array) || !pcm.length) return;
      if (socket?.readyState === 1) sendChunk(pcm);
      else pending.push(pcm);
    },
    finish() {
      if (closed) return Promise.resolve();
      closed = true;
      if (!live()) return Promise.resolve();
      return new Promise((resolve) => {
        // words still unsettled wait for their commit; otherwise only a moment for a late one
        const timer = setTimeout(() => finishing?.resolve(), partial.trim() || pending.length ? finishMs : Math.min(finishMs, 1_500));
        finishing = {
          resolve: () => {
            if (!finishing) return;
            finishing = null;
            clearTimeout(timer);
            if (live()) {
              if (partial.trim()) {
                committed.push(partial);
                partial = "";
              }
              onText(all(), false);
            }
            stopped = true;
            try { socket?.close(); } catch {}
            resolve();
          },
        };
        // nothing heard yet and no socket: nothing to wait for once it opens and commits
        commitAndWait();
      });
    },
    stop() {
      if (stopped) return;
      stopped = true;
      closed = true;
      pending = [];
      try { socket?.close(); } catch {}
      finishing?.resolve();
    },
  };
}

/**
 * The voice-input IPC for this computer's own page. `readCredentials()` returns the decrypted credential document;
 * `updateCredentials(derive)` is main.mjs's serialized writer (updateSecureCredentialDocument).
 */
export function installVoiceInput({
  ipcMain, localOnly, readCredentials, updateCredentials, log = () => {},
  fetch = globalThis.fetch, WebSocket = globalThis.WebSocket, spawn = nodeSpawn, tmpdir = nodeTmpdir,
  findWhisper = () => findWhisperCpp(), checkWhisperCpp = checkWhisper, maxMs = SESSION_MAX_MS, maxBytes = SESSION_MAX_BYTES,
}) {
  const sessions = new Map();
  const bySender = new Map();
  const watched = new WeakSet();

  const send = (contents, channel, payload) => {
    try {
      if (!contents.isDestroyed()) contents.send(channel, payload);
    } catch (error) {
      log(`voice input ${channel} not delivered: ${error?.message ?? error}`);
    }
  };

  const end = (session, info) => {
    if (session.ended) return;
    session.ended = true;
    clearTimeout(session.timer);
    sessions.delete(session.id);
    if (bySender.get(session.contents) === session.id) bySender.delete(session.contents);
    session.engine.stop();
    send(session.contents, "voice-input:end", { id: session.id, ...info });
  };

  const failure = (error) => {
    const reason = error instanceof VoiceProviderError ? `service-${error.reason}` : "service-failed";
    return { code: 1, reason, message: error instanceof VoiceProviderError ? error.message : undefined };
  };

  const finishSession = async (session, reason = "completed") => {
    if (session.ended || session.finishing) return session.finishing;
    session.finishing = session.engine.finish().then(() => end(session, { code: 0, reason }), (error) => end(session, failure(error)));
    return session.finishing;
  };

  const drop = (session) => {
    if (!session || session.ended) return;
    session.ended = true;
    clearTimeout(session.timer);
    sessions.delete(session.id);
    if (bySender.get(session.contents) === session.id) bySender.delete(session.contents);
    session.engine.stop();
  };

  const watch = (contents) => {
    if (watched.has(contents)) return;
    watched.add(contents);
    contents.once?.("destroyed", () => drop(sessions.get(bySender.get(contents))));
  };

  const owned = (event, id) => {
    const session = typeof id === "string" ? sessions.get(id) : undefined;
    return session && session.contents === event.sender ? session : null;
  };

  ipcMain.handle("voice-input:keys:status", localOnly("voice-input:keys:status", () => voiceKeyStatus(readCredentials())));
  ipcMain.handle("voice-input:keys:set", localOnly("voice-input:keys:set", async (_event, provider, key) => {
    const which = keyProvider(provider);
    const value = cleanKey(key);
    await updateCredentials((credentials) => ({ ...credentials, [VOICE_KEYS_CREDENTIAL_KEY]: { ...readVoiceKeys(credentials), [which]: value } }));
  }));
  ipcMain.handle("voice-input:keys:clear", localOnly("voice-input:keys:clear", async (_event, provider) => {
    const which = keyProvider(provider);
    await updateCredentials((credentials) => {
      const keys = readVoiceKeys(credentials);
      delete keys[which];
      const next = { ...credentials };
      if (Object.keys(keys).length) next[VOICE_KEYS_CREDENTIAL_KEY] = keys;
      else delete next[VOICE_KEYS_CREDENTIAL_KEY];
      return next;
    });
  }));
  ipcMain.handle("voice-input:find-whisper", localOnly("voice-input:find-whisper", () => findWhisper()));

  ipcMain.handle("voice-input:start", localOnly("voice-input:start", async (event, raw) => {
    const options = sessionOptions(raw);
    const contents = event.sender;
    drop(sessions.get(bySender.get(contents)));
    const info = VOICE_PROVIDER_INFO[options.provider];
    const key = readVoiceKeys(readCredentials())[options.provider];
    if (info.key === "required" && !key) throw new Error(`Add your ${info.name} key in Settings > Voice first.`);
    if (options.provider === "whisper-cpp") {
      try {
        await checkWhisperCpp(options.whisperCpp);
      } catch (error) {
        throw new Error(error?.message ?? "Pick a whisper.cpp program and model in Settings > Voice first.");
      }
    }
    if (options.provider === "openai-compatible" && !options.baseUrl) throw new Error("Add the service's address in Settings > Voice first.");
    if (contents.isDestroyed()) throw new Error("The page closed.");

    const id = randomUUID();
    const session = { id, contents, bytes: 0, ended: false, finishing: null, timer: null, engine: null };
    const onText = (heard, partial) => {
      if (session.ended) return;
      if (!partial && !heard.trim()) return;
      send(contents, "voice-input:transcript", { id, text: heard, partial });
    };
    const onError = (error) => {
      if (!session.ended) log(`voice input ${options.provider} failed: ${error?.reason ?? ""} ${error?.status ?? ""}`.trim());
      end(session, failure(error));
    };
    const model = voiceProviderModel(options.provider, options.model);
    if (options.provider === "elevenlabs" && options.realtime) {
      session.engine = createRealtimeSession({ key, model: VOICE_PROVIDER_INFO.elevenlabs.realtimeModel, language: options.language, onText, onError, fetch, WebSocket });
    } else if (options.provider === "whisper-cpp") {
      session.engine = createPieceSession({ transcribe: whisperRunner({ ...options.whisperCpp, language: options.language, spawn, tmpdir }), onText, onError, concurrency: 1, timeoutMs: WHISPER_TIMEOUT_MS + 5_000 });
    } else {
      session.engine = createPieceSession({
        transcribe: (wav, signal) => transcribeClip({ provider: options.provider, wav, key, model, language: options.language, baseUrl: options.baseUrl, signal, fetch }),
        onText, onError,
      });
    }
    sessions.set(id, session);
    bySender.set(contents, id);
    watch(contents);
    session.timer = setTimeout(() => void finishSession(session, "max-duration"), maxMs);
    return { id };
  }));

  ipcMain.handle("voice-input:finish", localOnly("voice-input:finish", async (event, id) => {
    const session = owned(event, id);
    if (session) await finishSession(session);
  }));
  ipcMain.handle("voice-input:stop", localOnly("voice-input:stop", (event, id) => {
    drop(owned(event, id));
  }));

  // a throw inside an ipcMain.on listener reaches no caller, so refusals here are quiet
  const audio = localOnly("voice-input:audio", (event, id, pcm) => {
    const session = owned(event, id);
    if (!session || session.finishing) return;
    const samples = pcmOf(pcm);
    if (!samples) return;
    session.bytes += samples.byteLength;
    if (session.bytes > maxBytes) return void finishSession(session, "max-duration");
    session.engine.push(samples);
  });
  ipcMain.on("voice-input:audio", (event, ...args) => {
    try {
      audio(event, ...args);
    } catch {
    }
  });

  return {
    /** Sessions running now, for quit and tests. */
    active: () => sessions.size,
    close() {
      // drop() removes from the map, so walk a copy
      for (const session of Array.from(sessions.values())) drop(session);
    },
  };
}
