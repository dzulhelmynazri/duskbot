// The bot computer image (deploy/bot-desktop). One line each: deploy/bot-desktop/build.sh and
// .github/workflows/bot-desktop-image.yml read these two constants. A bump publishes the image from main (amd64 + arm64);
// servers switch to it only once it is on the host, and keep running the version before until then.
export const BOT_DESKTOP_VERSION = "6";
export const BOT_DESKTOP_IMAGE = "ghcr.io/madanibotai/madani-desktop:v6";

/** Image label carrying BOT_DESKTOP_VERSION; containers made from the image carry it too. */
export const BOT_DESKTOP_LABEL = DOCKER_NAMES.label("bot-desktop");
/** The Docker network every bot desktop on a host joins: no inter-container traffic, fenced by the host or by each box. */
export const BOT_DESKTOP_NETWORK = DOCKER_NAMES.desktopNetwork;
export const BOT_DESKTOP_NETWORK_LABEL = DOCKER_NAMES.label("vps-network");
/** The network's bridge interface on the host: deploy/bot-desktop/host-fence.sh keys every rule on this name. */
export const BOT_DESKTOP_BRIDGE = "omb-desk0";
/** "free" (host-fenced, sudo inside) or "strict" (self-fenced, read-only, no sudo); see server/bot-desktop.ts. */
export const BOT_DESKTOP_MODE_LABEL = DOCKER_NAMES.label("bot-desktop-mode");
/** The only mount: a named volume holding the bot's home (saved files, browser profile, terminal history). */
export const BOT_DESKTOP_HOME = "/home/cua";
import { DOCKER_NAMES } from "../electron/legacy-names.mjs";
