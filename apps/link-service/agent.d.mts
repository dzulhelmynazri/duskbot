/** The link agent's phone hub, as the desktop app and a madani cloud run it in their own process. */
export interface PhoneHubKeys { pub: string; priv: string }
export declare function x25519Pair(): PhoneHubKeys;
export declare function harnessSync(server?: { host: string; port: number }): (input: Record<string, unknown>) => Promise<unknown>;
export declare function createPhoneHub(options: {
  base: string;
  id: string;
  token: string;
  keys: PhoneHubKeys;
  server?: { host: string; port: number };
  sync?: (input: Record<string, unknown>) => Promise<unknown>;
  proxy?: { host: string; port: number } | null;
  log?: (line: string) => void;
  fetchImpl?: typeof fetch;
  waitS?: number;
}): { run(): Promise<void>; stop(): void };
