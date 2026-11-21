// What `madanibot serve` and `madanibot pair` print for a pairing code. A browser on this computer is no longer the
// owner just by being here, so it signs in once with the link printed for it.
import qrcode from "qrcode-terminal";

import { universalPairLink, type MobilePairingResponse } from "../shared/mobile-link.ts";

/** `url` opens the web app (browsers, the iOS app); `inviteUrl` (madanibot://) is the only thing the Android app scans;
 * `localUrl` signs in a browser on this computer. */
export function pairingBlock(input: {
  code: string;
  url: string | null;
  inviteUrl?: string | null;
  localUrl?: string | null;
  expiresAt: number;
  hint?: string | null;
  phone?: "ios" | "android";
}): string {
  const lines = [`pairing code:  ${input.code}`, `expires:       ${new Date(input.expiresAt).toLocaleTimeString()} (single use)`];
  if (input.localUrl) lines.push(`this computer: ${input.localUrl}`);
  if (!input.url && !input.inviteUrl) {
    lines.push(`open:          /pair on the address you use for this server, and type the code`);
    if (input.hint) lines.push(`               (${input.hint})`);
    return lines.join("\n");
  }
  const scanInvite = input.phone === "android" && !!input.inviteUrl;
  if (input.url) lines.push(scanInvite ? `web browser:   ${input.url}` : `open or scan:  ${input.url}`);
  if (input.inviteUrl) lines.push(`phone app:     ${input.inviteUrl}`);
  const target = scanInvite ? input.inviteUrl! : input.url;
  if (target) {
    lines.push("");
    lines.push(qrToString(target));
    lines.push("");
    if (scanInvite) {
      lines.push(`Scan that in the madani bot app. For a browser instead, open the web`);
      lines.push(`address above and type the code.`);
    } else if (input.phone === "android") {
      lines.push(`That QR opens the web app. The Android app needs the phone-app link,`);
      lines.push(`which this server cannot build without a public address: set`);
      lines.push(`MADANI_PUBLIC_URL, or open the web address above and type the code.`);
    } else if (input.inviteUrl) {
      lines.push(`Scan that with Camera for the browser, or paste the phone-app link`);
      lines.push(`above into the madani bot app.`);
    }
  }
  return lines.join("\n");
}

/** The madani bot phone app's own pairing: a QR its camera scan opens, and the code it can type instead. It reaches this
 * server over the link relay, so it needs no public address. */
export function phoneAppBlock(pairing: MobilePairingResponse): string {
  const lines = ["Scan this with your phone's camera, or in the madani bot app:", "", qrToString(universalPairLink(pairing.link, pairing.code)), ""];
  if (pairing.code) lines.push(`or type this code in the app:  ${pairing.code}`);
  lines.push(`expires:       ${new Date(pairing.expiresAt).toLocaleTimeString()} (single use)`, "Keep this code private.");
  return lines.join("\n");
}

type LoopbackPost = (path: string, init: { method: string; body: string; timeoutMs: number }) => Promise<{ status: number; body: any }>;

/** The phone app's pairing over the link relay, printed; null when this server has no relay for phones. */
export async function phoneAppPairing(post: LoopbackPost, label?: string): Promise<string | null> {
  const got = await post("/api/mobile/pairing", { method: "POST", body: JSON.stringify(label ? { label } : {}), timeoutMs: 30_000 }).catch(() => null);
  const relayed = got?.status === 200 && typeof got.body?.link === "string" && Array.isArray(got.body?.payload?.via)
    && got.body.payload.via.some((route: { kind?: unknown }) => route?.kind === "relay");
  return relayed ? phoneAppBlock(got.body as MobilePairingResponse) : null;
}

/** The guided start's one sign-in, for the browser it opens on this computer. */
export function browserSignInLines(localUrl: string, code: string, expiresAt: number): string {
  return [
    "Sign in from a browser on this computer with this link (single use, until",
    `${new Date(expiresAt).toLocaleTimeString()}): ${localUrl}`,
    `or type the code ${code} on the sign-in page. Later: madanibot pair`,
  ].join("\n");
}

export function qrToString(text: string): string {
  let out = "";
  qrcode.generate(text, { small: true }, (rendered: string) => {
    out = rendered;
  });
  return out;
}
