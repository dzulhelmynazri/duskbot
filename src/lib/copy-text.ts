import { useCallback, useEffect, useRef, useState } from "react";
import { phoneBridge } from "./phone-bridge";

export type CopyResult = "copied" | "empty" | "failed";
export type CopyFeedback = "idle" | "copied" | "failed";

export const COPY_FEEDBACK_MS = 1200;

/** Bounds a web write that never settles; Chromium rejects an unfocused write at once. */
export const WEB_WRITE_TIMEOUT_MS = 3000;

function writeWeb(write: () => Promise<void> | undefined): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), WEB_WRITE_TIMEOUT_MS);
    try {
      const pending = write();
      if (!pending) return finish(false);
      Promise.resolve(pending).then(() => finish(true), () => finish(false));
    } catch {
      finish(false);
    }
  });
}

/** The web Clipboard API rejects unfocused, denied and insecure-context writes; then the desktop bridge runs. Never throws. */
export async function copyText(text: string): Promise<CopyResult> {
  if (!text.trim()) return "empty";
  return felt(await writePlain(text) ? "copied" : await copyThroughDesktop(text));
}

/** On the phone a copy is felt as well as shown. */
function felt(result: CopyResult): CopyResult {
  phoneBridge()?.haptic(result === "copied" ? "success" : "error");
  return result;
}

const writePlain = (text: string) => writeWeb(() => navigator.clipboard?.writeText?.(text));

/** text/html beside text/plain, so mail and documents paste formatting; the desktop bridge takes the plain text alone. */
export async function copyRichText(text: string, html: string): Promise<CopyResult> {
  if (!text.trim()) return "empty";
  const rich = () => typeof ClipboardItem === "function" && navigator.clipboard?.write
    ? navigator.clipboard.write([new ClipboardItem({ "text/html": new Blob([html], { type: "text/html" }), "text/plain": new Blob([text], { type: "text/plain" }) })])
    : undefined;
  return felt(await writeWeb(rich) || await writePlain(text) ? "copied" : await copyThroughDesktop(text));
}

async function copyThroughDesktop(text: string): Promise<CopyResult> {
  try {
    if (typeof window !== "undefined" && (await window.madaniDesktop?.copyText?.(text)) === true) return "copied";
  } catch {
  }
  return "failed";
}

interface CopyFeedbackOptions {
  copy: (text: string) => Promise<CopyResult>;
  onChange: (state: CopyFeedback) => void;
  resetMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export function createCopyFeedback({
  copy,
  onChange,
  resetMs = COPY_FEEDBACK_MS,
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}: CopyFeedbackOptions) {
  let pending = false;
  let disposed = false;
  let timer: unknown;

  const clear = () => {
    if (timer !== undefined) clearTimer(timer);
    timer = undefined;
  };

  return {
    async click(text: string): Promise<CopyResult | "busy"> {
      if (pending) return "busy";
      pending = true;
      let result: CopyResult;
      try {
        result = await copy(text);
      } catch {
        result = "failed";
      } finally {
        pending = false;
      }
      if (disposed || result === "empty") return result;
      clear();
      onChange(result === "copied" ? "copied" : "failed");
      timer = setTimer(() => {
        timer = undefined;
        onChange("idle");
      }, resetMs);
      return result;
    },
    dispose() {
      disposed = true;
      clear();
    },
  };
}

export function useCopyFeedback(text: string, copy: (text: string) => Promise<CopyResult> = copyText) {
  const [state, setState] = useState<CopyFeedback>("idle");
  const controller = useRef<ReturnType<typeof createCopyFeedback> | null>(null);
  const copier = useRef(copy);
  copier.current = copy;
  useEffect(() => {
    const next = createCopyFeedback({ copy: (value) => copier.current(value), onChange: setState });
    controller.current = next;
    return () => {
      next.dispose();
      controller.current = null;
    };
  }, []);
  const click = useCallback(() => void controller.current?.click(text), [text]);
  return { state, copy: click };
}
