/** The app works without an account: where bots live comes first, and an account is asked for only where something needs
 * one (madani cloud's checkout, a server's link, a sign-in the person asks for), in the browser. MADANI_REQUIRE_ACCOUNT=1 puts
 * the sign-in back in front of the app, for an install that must have one. */
export const accountGateRequired = ({ env, remote }) => !remote && env.MADANI_REQUIRE_ACCOUNT === "1";
export const gateBlocks = state => !(state?.account && ["connected", "unavailable"].includes(state.status));
const plain = value => typeof value === "string" ? value : "";

/** `plainStorage()`: no system keyring, so a sign-in is kept in a file guarded only by this computer's user account. */
export function installAccountGate({ ipcMain, guard, client, required, window, restored = async () => {}, plainStorage = () => false }) {
  const view = state => {
    const needed = required();
    return { required: needed, blocked: needed && gateBlocks(state), status: state?.status ?? "signed-out",
      ...(state?.message === undefined ? {} : { message: state.message }), ...(state?.enrollment ? { enrollment: { userCode: state.enrollment.userCode, expiresAt: state.enrollment.expiresAt } } : {}),
      ...(state?.status === "connecting" && state.browser ? { browser: state.browser } : {}), ...(state?.status === "connecting" && state.magic ? { magic: state.magic } : {}), ...(plainStorage() ? { plainStorage: true } : {}) };
  };
  const state = () => view(client().state());
  const handle = (method, handler) => ipcMain.handle(`account-gate:${method}`, guard(`account-gate:${method}`, handler));
  // a kept sign-in is still being read at launch: answer after it, so a signed-in window never flashes the gate
  handle("state", async () => { if (client().state()?.message === "restoring") await restored(); return state(); });
  handle("signInStart", (_event, email, options) => client().emailStart(plain(email), { recover: options?.recover === true }));
  handle("options", () => client().signInOptions());
  handle("signInVerify", async (_event, code) => {
    const result = await client().emailVerify(plain(code));
    return { outcome: result.outcome, ...(result.triesLeft === undefined ? {} : { triesLeft: result.triesLeft }) };
  });
  handle("signInCancel", () => { client().emailCancel(); });
  handle("browser", async (_event, provider) => { await client().begin(null, { provider: plain(provider) }); return state(); });
  // the email way: a magic link to the website, and this app waits on the same sign-in code as the browser's
  handle("magicLink", async (_event, email) => { await client().begin(null, { email: plain(email) }); return state(); });
  handle("cancel", async () => { await client().cancel(); return state(); });
  handle("reopen", async () => { await client().reopen(); return state(); });
  return { changed(value) { const target = window(); if (target && !target.isDestroyed()) target.webContents.send("account-gate:changed", view(value)); } };
}
