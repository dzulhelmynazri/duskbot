import { createContext } from "react";

/** the id of the workspace connection the app is showing ("same-origin" in a browser on the workspace itself) */
export const ActiveConnection = createContext<string | null>(null);

/** where a connection's unsent messages wait (src/mobile/outbox.ts) */
export const outboxKey = (connection: string) => `madani.mobile.outbox.${connection}`;
