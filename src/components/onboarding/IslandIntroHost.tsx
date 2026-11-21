import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { IslandIntro } from "./IslandIntro";
import { trapTab } from "./WelcomeFlow";

const OPEN = "madani:island-intro";
let waiting: (() => void)[] = [];

/** Plays the notch and dock step again over the app (Settings → Appearance); resolves once it closes. */
export function openIslandIntro(): Promise<void> {
  return new Promise((resolve) => {
    waiting.push(resolve);
    window.dispatchEvent(new Event(OPEN));
  });
}

declare global {
  interface Window {
    /** dev builds only: plays the notch and dock step from the console */
    madaniIslandIntro?: () => Promise<void>;
  }
}

export function IslandIntroHost() {
  const [run, setRun] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const open = () => setRun((now) => (now > 0 ? now : Date.now()));
    window.addEventListener(OPEN, open);
    if (import.meta.env.DEV) window.madaniIslandIntro = openIslandIntro;
    return () => window.removeEventListener(OPEN, open);
  }, []);
  useEffect(() => { if (run) root.current?.focus({ preventScroll: true }); }, [run]);
  if (!run) return null;
  const close = () => {
    setRun(0);
    const done = waiting;
    waiting = [];
    done.forEach((resolve) => resolve());
  };
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
      return;
    }
    trapTab(event, root.current);
  };
  return (
    <div ref={root} role="dialog" aria-modal aria-labelledby="island-intro-title" tabIndex={-1} onKeyDown={onKeyDown}
      className="fixed inset-0 z-[85] flex overflow-y-auto outline-none">
      <IslandIntro key={run} titleId="island-intro-title" onDone={close} />
    </div>
  );
}
