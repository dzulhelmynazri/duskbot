// A shell exporting DUSK_* / DUSK_* leaks them into every child and import-time env snapshot.

const AMBIENT_PREFIXES = ["DUSK_", "DUSK_"] as const;

export function isAmbientDuskKey(key: string): boolean {
  return AMBIENT_PREFIXES.some((prefix) => key.startsWith(prefix));
}

export function stripDuskEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (!isAmbientDuskKey(key)) clean[key] = value;
  }
  return clean;
}

export function childEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { ...stripDuskEnv(process.env), ...overrides };
}
