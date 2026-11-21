import { registerHooks } from "node:module";

const directory = process.env.MADANI_DATA_DIR;
if (!directory || directory !== process.env.HOME || process.env.MADANI_TEST_VPS_IDLE_CLOCK !== "1") {
  throw new Error("The VPS idle clock requires an explicitly isolated fixture");
}
const idle = new URL("../vps-idle.ts", import.meta.url).href;
const from = "const value = deps.idleMs();";
const lifecycle = new URL("../vps-lifecycle.ts", import.meta.url).href;
const duration = "return policy[`${stage}IdleMinutes`] * 60_000;";
registerHooks({
  load(url, context, nextLoad) {
    const result = nextLoad(url, context);
    if (url !== idle && url !== lifecycle) return result;
    const source = String(result.source);
    if (url === lifecycle) {
      if (source.split(duration).length !== 2) throw new Error("VPS lifecycle clock seam changed");
      return { ...result, source: source.replace(duration, "return policy[`${stage}IdleMinutes`] === 0 ? 0 : ({browser:750,screen:1500,computer:3000})[stage];") };
    }
    if (source.split(from).length !== 2) throw new Error("VPS idle clock seam changed");
    return { ...result, source: source.replace(from, "const value = deps.idleMs() === 0 ? 0 : 750;") };
  },
});
