import { useEffect, useState } from "react";

const bridge = () => (typeof window === "undefined" ? undefined : window.madaniDesktop?.rail);

/** On the rail's own page: whether the page beside it draws the window's frame, as main hears from each of its documents.
 * The window opens framed. */
export function useBesideFramed(): boolean {
  const [framed, setFramed] = useState(true);
  useEffect(() => bridge()?.onFramed?.(setFramed), []);
  return framed;
}

/** Whether the page beside the rail draws the window's frame: main puts the traffic lights in its top bar, or back where
 * the window keeps them without it. */
export function sayFrameDrawn(drawn = true): void {
  void bridge()?.drawsFrame?.(drawn)?.catch(() => {});
}
