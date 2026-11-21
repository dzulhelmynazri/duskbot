// Windows Hello through WinRT's UserConsentVerifier, with no native addon or helper exe to build and sign: the built-in
// Windows PowerShell 5.1 compiles a few lines of C# that call the WinRT ABI directly (raw vtable slots), so the packaged
// app needs nothing extra and no admin. The prompt is parented to the app's window through IUserConsentVerifierInterop;
// if that interop fails before any prompt, the unparented RequestVerificationAsync is the second path.
import { spawn as nodeSpawn } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";

// UserConsentVerifierAvailability and UserConsentVerificationResult, as WinRT numbers them.
export const AVAILABILITY = { available: 0, deviceNotPresent: 1, notConfiguredForUser: 2, disabledByPolicy: 3, deviceBusy: 4 };
export const RESULT = { verified: 0, deviceNotPresent: 1, notConfiguredForUser: 2, disabledByPolicy: 3, deviceBusy: 4, retriesExhausted: 5, canceled: 6 };

const WINRT_PINTERFACE_NAMESPACE = "11f47ad5-7b73-42c0-abae-878b1e16adee";
const IASYNC_OPERATION = "9fc2b0bb-e446-44e2-aa61-9cab8f636af2";

/** The IID of a parameterized WinRT interface: SHA-1 over the WinRT namespace GUID and the type signature (a v5 UUID). */
export function winrtPinterfaceIid(signature) {
  const hash = createHash("sha1").update(Buffer.from(WINRT_PINTERFACE_NAMESPACE.replaceAll("-", ""), "hex")).update(signature, "utf8").digest();
  hash[6] = (hash[6] & 0x0f) | 0x50;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// windows.security.credentials.ui.idl and userconsentverifierinterop.h (Windows SDK 10.0.22000+).
export const STATICS_IID = "af4f3f91-564c-4ddc-b8b5-973447627c65";
export const INTEROP_IID = "39e050c3-4e74-441a-8dc0-b81104df949c";

/** IAsyncOperation<UserConsentVerificationResult>, the riid RequestVerificationForWindowAsync is asked for. */
export const VERIFICATION_OPERATION_IID = winrtPinterfaceIid(`pinterface({${IASYNC_OPERATION}};enum(Windows.Security.Credentials.UI.UserConsentVerificationResult;i4))`);

// C# 5: Windows PowerShell's Add-Type compiles with the .NET Framework compiler. Slots count IUnknown (0-2) and
// IInspectable (3-5) first. It prints `availability=`, `parented=` and `result=` lines, or `error=<stage>`; nothing else.
const CSHARP = String.raw`
using System;
using System.Runtime.InteropServices;
using System.Threading;
public static class MadaniHello {
  [DllImport("combase.dll")] static extern int WindowsCreateString([MarshalAs(UnmanagedType.LPWStr)] string s, int length, out IntPtr h);
  [DllImport("combase.dll")] static extern int WindowsDeleteString(IntPtr h);
  [DllImport("combase.dll")] static extern int RoGetActivationFactory(IntPtr classId, ref Guid iid, out IntPtr factory);
  [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int OutPtr(IntPtr self, out IntPtr value);
  [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int OutInt(IntPtr self, out int value);
  [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int NoArgs(IntPtr self);
  [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int MessageOp(IntPtr self, IntPtr message, out IntPtr op);
  [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int ForWindow(IntPtr self, IntPtr hwnd, IntPtr message, ref Guid riid, out IntPtr op);
  class Stage : Exception { public Stage(string stage) : base(stage) {} }
  static T Slot<T>(IntPtr obj, int slot) {
    IntPtr table = Marshal.ReadIntPtr(obj);
    return (T)(object)Marshal.GetDelegateForFunctionPointer(Marshal.ReadIntPtr(table, slot * IntPtr.Size), typeof(T));
  }
  static void Ok(int hr, string stage) { if (hr < 0) throw new Stage(stage + "-" + hr.ToString("x8")); }
  static void Emit(string line) { Console.Out.WriteLine(line); Console.Out.Flush(); }
  static IntPtr Text(string value) { IntPtr h; Ok(WindowsCreateString(value, value.Length, out h), "string"); return h; }
  static IntPtr Factory(string iid, string stage) {
    IntPtr name = Text("Windows.Security.Credentials.UI.UserConsentVerifier");
    try { Guid id = new Guid(iid); IntPtr factory; Ok(RoGetActivationFactory(name, ref id, out factory), stage); return factory; }
    finally { WindowsDeleteString(name); }
  }
  static int Await(IntPtr op, int timeoutMs, string stage) {
    Guid infoIid = new Guid("00000036-0000-0000-C000-000000000046");
    IntPtr info; Ok(Marshal.QueryInterface(op, ref infoIid, out info), stage);
    try {
      DateTime end = DateTime.UtcNow.AddMilliseconds(timeoutMs);
      int status = 0;
      while (true) {
        Ok(Slot<OutInt>(info, 7)(info, out status), stage);
        if (status != 0) break;
        if (DateTime.UtcNow > end) { Slot<NoArgs>(info, 9)(info); throw new Stage(stage + "-timeout"); }
        Thread.Sleep(50);
      }
      if (status != 1) throw new Stage(stage + "-status" + status);
      int value; Ok(Slot<OutInt>(op, 8)(op, out value), stage);
      return value;
    } finally { Marshal.Release(info); }
  }
  static void Work(string mode, long hwnd, string message) {
    IntPtr statics = Factory("${STATICS_IID}", "statics");
    try {
      IntPtr check; Ok(Slot<OutPtr>(statics, 6)(statics, out check), "availability");
      int availability;
      try { availability = Await(check, 30000, "availability"); } finally { Marshal.Release(check); }
      Emit("availability=" + availability);
      if (mode == "check" || (availability != 0 && mode != "force-verify")) return;
      IntPtr text = Text(message);
      try {
        IntPtr op = IntPtr.Zero;
        try {
          IntPtr interop = Factory("${INTEROP_IID}", "interop");
          try { Guid riid = new Guid("${VERIFICATION_OPERATION_IID}"); Ok(Slot<ForWindow>(interop, 6)(interop, new IntPtr(hwnd), text, ref riid, out op), "interop-call"); }
          finally { Marshal.Release(interop); }
          Emit("parented=1");
        } catch (Stage) {
          Emit("parented=0");
          Ok(Slot<MessageOp>(statics, 7)(statics, text, out op), "verify");
        }
        try { Emit("result=" + Await(op, 600000, "verify")); } finally { Marshal.Release(op); }
      } finally { WindowsDeleteString(text); }
    } finally { Marshal.Release(statics); }
  }
  public static void Run(string mode, long hwnd, string message) {
    Exception failure = null;
    Thread worker = new Thread(delegate() { try { Work(mode, hwnd, message); } catch (Exception e) { failure = e; } });
    worker.SetApartmentState(ApartmentState.MTA);
    worker.Start();
    worker.Join();
    if (failure != null) Emit("error=" + (failure is Stage ? failure.Message : "runtime"));
  }
}
`;

/** The script the helper runs; inputs arrive in environment variables, never in the command text. */
export const WINDOWS_HELLO_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "try {",
  `  Add-Type -Language CSharp -TypeDefinition @'${CSHARP}'@`,
  "} catch { [Console]::Out.WriteLine('error=compile'); exit 2 }",
  "[MadaniHello]::Run([string]$env:MADANI_HELLO_MODE, [long]('0' + $env:MADANI_HELLO_HWND), [string]$env:MADANI_HELLO_REASON)",
].join("\n");

export function encodedCommand(script = WINDOWS_HELLO_SCRIPT) {
  return Buffer.from(script, "utf16le").toString("base64");
}

/** The system's own Windows PowerShell, never whichever powershell.exe comes first on PATH. */
export function windowsPowerShell(env = process.env) {
  return path.win32.join(env.SystemRoot || env.windir || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

/** The native window handle Electron gives as a Buffer, as the decimal the helper reads. */
export function windowHandleText(buffer) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) return "0";
  return buffer.length >= 8 ? buffer.readBigUInt64LE(0).toString() : String(buffer.readUInt32LE(0));
}

export function parseHelloOutput(text) {
  const read = (key) => {
    const match = new RegExp(`^${key}=(-?\\d+)\\s*$`, "m").exec(text);
    return match ? Number(match[1]) : null;
  };
  const stage = /^error=([\w-]+)\s*$/m.exec(text)?.[1] ?? null;
  return { availability: read("availability"), result: read("result"), parented: read("parented") === 1, error: /^error=/m.test(text), stage };
}

/**
 * "pass" only for Verified. "unavailable" when Hello is not there to ask (no device, not set up, off by policy, or the
 * helper could not run at all): the caller confirms in the app instead. Anything after Hello was available and asked
 * (cancel, retries exhausted, busy, a timeout, an error mid-prompt) is "fail", so it never drops to the weaker check.
 */
export function helloOutcome({ availability, result }) {
  if (result === RESULT.verified) return "pass";
  if (result === RESULT.deviceNotPresent || result === RESULT.notConfiguredForUser || result === RESULT.disabledByPolicy) return "unavailable";
  if (result !== null && result !== undefined) return "fail";
  if (availability === AVAILABILITY.available || availability === AVAILABILITY.deviceBusy) return "fail";
  return "unavailable";
}

/** Runs the helper once. Resolves its parsed output; never rejects. `mode`: "verify" (check, then ask), "check", or "force-verify" (tests: ask even when unavailable). */
export function runWindowsHello({ hwnd = "0", reason = "", mode = "verify", timeoutMs = 120_000, spawn = nodeSpawn, env = process.env } = {}) {
  return new Promise((resolve) => {
    let stdout = "", timedOut = false, settled = false;
    const finish = (extra = {}) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ...parseHelloOutput(stdout), timedOut, ...extra });
    };
    let child;
    try {
      child = spawn(windowsPowerShell(env), ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encodedCommand()], {
        env: { ...env, MADANI_HELLO_MODE: mode, MADANI_HELLO_HWND: String(hwnd), MADANI_HELLO_REASON: String(reason) },
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
      });
    } catch {
      resolve({ availability: null, result: null, parented: false, error: true, timedOut: false });
      return;
    }
    const timer = setTimeout(() => { timedOut = true; child.kill(); finish(); }, timeoutMs);
    child.stdout?.setEncoding?.("utf8");
    child.stdout?.on("data", (chunk) => { if (stdout.length < 4096) stdout += chunk; });
    child.on("error", () => finish({ error: true }));
    child.on("close", () => finish());
  });
}
