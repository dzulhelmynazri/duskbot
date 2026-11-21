// the link service runs on its own, so it keeps its own copy of the names from before the rename (the app's is
// electron/legacy-names.mjs): old env names are read as MADANI_*, and the old well-known path answers as the new one.
const OLD_ENV = ["OMB_", "OPENMAUSBOT_"];
const OLD_WELL_KNOWN = "/.well-known/openmausbot";

export function aliasLegacyEnv(env) {
  for (const key of Object.keys(env)) {
    const prefix = OLD_ENV.find((p) => key.toUpperCase().startsWith(p));
    if (!prefix) continue;
    if (env[`MADANI_${key.slice(prefix.length)}`] === undefined) env[`MADANI_${key.slice(prefix.length)}`] = env[key];
    delete env[key];
  }
  return env;
}

export const fromLegacyPath = (path) =>
  path === OLD_WELL_KNOWN || path.startsWith(`${OLD_WELL_KNOWN}/`) ? `/.well-known/madanibot${path.slice(OLD_WELL_KNOWN.length)}` : path;

aliasLegacyEnv(process.env);
