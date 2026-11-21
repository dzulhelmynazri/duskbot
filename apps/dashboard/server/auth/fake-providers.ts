import { createServer } from "node:http";
import { createHash, generateKeyPairSync, randomBytes, sign, verify } from "node:crypto";
import type { OAuthProvider } from "../../../../shared/account-api.ts";
import type { ProviderConfigs, ProviderProfile } from "./providers.ts";
import { decodeJws } from "./jwt.ts";

export interface FakeProfile extends ProviderProfile { emailVerified?: boolean | "true" | "false"; hd?: string }
interface Authorization { provider: OAuthProvider; redirectUri: string; challenge: string | null; nonce: string | null; profile: FakeProfile; expiresAt: number }
const random = () => randomBytes(32).toString("base64url");
const escape = (value: string) => value.replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
export async function startFakeProviders({ port = 0 }: { port?: number } = {}) {
  const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const apple = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = { ...rsa.publicKey.export({ format: "jwk" }), kid: "fixture-rsa", alg: "RS256", use: "sig" };
  const users: Record<OAuthProvider, FakeProfile> = {
    google: { subject: "google-sid", email: "sid@madanibot.test", emailVerified: true, hd: "madanibot.test", label: "Sid Fixture", name: "Sid Fixture" },
    apple: { subject: "apple-sid", email: "sid@privaterelay.appleid.test", emailVerified: "true", label: "Apple Fixture", name: "Apple Fixture" },
  };
  const denied = new Set<OAuthProvider>(), seenApple = new Set<string>();
  /** Apple refresh tokens issued (with the client id that got them), and those revoked through /apple/revoke */
  const appleRefresh = new Map<string, string>(), revoked: string[] = [];
  /** codes an iphone got with its identity token: redeemed with the bundle id as client id and no redirect uri */
  const nativeCodes = new Map<string, { clientId: string; subject: string }>();
  const codes = new Map<string, Authorization>();
  let url = "";
  const signToken = (claims: Record<string, unknown>) => {
    const input = [{ alg: "RS256", kid: jwk.kid }, claims].map(value => Buffer.from(JSON.stringify(value)).toString("base64url")).join(".");
    return `${input}.${sign("sha256", Buffer.from(input), rsa.privateKey).toString("base64url")}`;
  };
  const appleSecretOk = (secret: string, clientId: string, settings: ProviderConfigs["apple"]) => {
    const { header, claims, input, signature } = decodeJws(secret);
    const time = Date.now() / 1000;
    return header.alg === "ES256" && header.kid === settings!.apple!.keyId && claims.iss === settings!.apple!.teamId && claims.sub === clientId && claims.aud === "https://appleid.apple.com"
      && typeof claims.exp === "number" && claims.exp > time && claims.exp <= time + 660 && typeof claims.iat === "number" && claims.iat <= time + 60
      && verify("sha256", input, { key: apple.publicKey, dsaEncoding: "ieee-p1363" }, signature);
  };
  const config: ProviderConfigs = {};
  const server = createServer((req, res) => {
    void (async () => {
      const address = new URL(req.url ?? "/", url), match = /^\/(google|apple)\/(authorize|token|revoke|jwks)$/.exec(address.pathname);
      const json = (value: unknown, status = 200) => { res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(value)); };
      if (!match) return json({ error: "not_found" }, 404);
      const id = match[1] as OAuthProvider, route = match[2], settings = config[id]!;
      if (route === "jwks" && req.method === "GET") return json({ keys: [jwk] });
      if (route === "authorize" && req.method === "GET") {
        const query = address.searchParams, redirectUri = query.get("redirect_uri"), state = query.get("state"), nonce = query.get("nonce"), challenge = query.get("code_challenge");
        if (!redirectUri || !state || !/^[A-Za-z0-9_-]{43}$/.test(state) || query.get("client_id") !== settings.clientId || query.get("response_type") !== "code") throw new Error();
        const callback = new URL(redirectUri);
        if (!["http:", "https:"].includes(callback.protocol) || !["127.0.0.1", "localhost"].includes(callback.hostname) || callback.username || callback.password || callback.search || callback.hash
          || callback.pathname !== `/v1/auth/oauth/${id}/callback`) throw new Error();
        if (id !== "apple" && (!challenge || !/^[A-Za-z0-9_-]{43}$/.test(challenge) || query.get("code_challenge_method") !== "S256")) throw new Error();
        if ((!nonce || !/^[A-Za-z0-9_-]{43}$/.test(nonce))) throw new Error();
        if (id === "apple" && query.get("response_mode") !== "form_post") throw new Error();
        const fields = new URLSearchParams({ state });
        if (denied.delete(id)) fields.set("error", "access_denied");
        else {
          const code = random(), profile = { ...users[id] };
          codes.set(code, { provider: id, redirectUri, challenge, nonce, profile, expiresAt: Date.now() + 600_000 });
          fields.set("code", code);
          if (id === "apple" && !seenApple.has(profile.subject)) {
            seenApple.add(profile.subject);
            const [firstName, ...rest] = (profile.name ?? "").split(" ");
            fields.set("user", JSON.stringify({ name: { firstName, lastName: rest.join(" ") }, email: profile.email }));
          }
        }
        if (id === "apple") {
          res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
          res.end(`<!doctype html><html><body><form method="post" action="${escape(redirectUri)}">${[...fields].map(([name, value]) => `<input type="hidden" name="${name}" value="${escape(value)}">`).join("")}<button>Continue</button></form><script>document.forms[0].submit()</script></body></html>`);
        } else { callback.search = fields.toString(); res.writeHead(302, { location: callback.href }); res.end(); }
        return;
      }
      if (route === "revoke" && id === "apple" && req.method === "POST") {
        let raw = "";
        for await (const chunk of req) { raw += String(chunk); if (raw.length > 65_536) throw new Error(); }
        const body = new URLSearchParams(raw), token = body.get("token") ?? "";
        const clientId = body.get("client_id") ?? "";
        if (!appleSecretOk(body.get("client_secret") ?? "", clientId, settings) || body.get("token_type_hint") !== "refresh_token" || appleRefresh.get(token) !== clientId) throw new Error();
        appleRefresh.delete(token); revoked.push(token);
        res.writeHead(200); res.end(); return;
      }
      if (route === "token" && req.method === "POST") {
        let raw = "";
        for await (const chunk of req) { raw += String(chunk); if (raw.length > 65_536) throw new Error(); }
        const body = new URLSearchParams(raw), code = body.get("code") ?? "", issued = codes.get(code), native = id === "apple" ? nativeCodes.get(code) : undefined;
        codes.delete(code); nativeCodes.delete(code);
        if (native) {
          if (body.get("grant_type") !== "authorization_code" || body.get("client_id") !== native.clientId || body.has("redirect_uri") || !appleSecretOk(body.get("client_secret") ?? "", native.clientId, settings)) throw new Error();
          const refresh = random(), iat = Math.floor(Date.now() / 1000); appleRefresh.set(refresh, native.clientId);
          return json({ id_token: signToken({ iss: `${url}/apple`, aud: native.clientId, sub: native.subject, iat, exp: iat + 600 }), refresh_token: refresh, token_type: "bearer" });
        }
        if (!issued || issued.provider !== id || issued.expiresAt <= Date.now() || body.get("grant_type") !== "authorization_code" || body.get("redirect_uri") !== issued.redirectUri) throw new Error();
        if (body.get("client_id") !== settings.clientId) throw new Error();
        if (id === "google" && body.get("client_secret") !== settings.clientSecret) throw new Error();
        if (id !== "apple") {
          const verifier = body.get("code_verifier");
          if (!verifier || !/^[A-Za-z0-9_-]{43,128}$/.test(verifier) || createHash("sha256").update(verifier).digest("base64url") !== issued.challenge) throw new Error();
        } else if (!appleSecretOk(body.get("client_secret") ?? "", settings.clientId, settings)) throw new Error();
        const iat = Math.floor(Date.now() / 1000), profile = issued.profile;
        const claims = { iss: `${url}/${id}`, aud: settings.clientId, sub: profile.subject, email: profile.email, email_verified: profile.emailVerified ?? true,
          ...(id === "google" ? { name: profile.name, ...(profile.hd ? { hd: profile.hd } : {}), ...(profile.picture ? { picture: profile.picture } : {}) } : {}), nonce: issued.nonce, iat, exp: iat + 600 };
        const refresh = id === "apple" ? random() : null;
        if (refresh) appleRefresh.set(refresh, settings.clientId);
        return json({ id_token: signToken(claims), token_type: "bearer", ...(refresh ? { refresh_token: refresh } : {}) });
      }
      json({ error: "not_found" }, 404);
    })().catch(() => { if (!res.headersSent) res.writeHead(400, { "content-type": "application/json" }); res.end(JSON.stringify({ error: "invalid_request" })); });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fake providers failed to start.");
  url = `http://127.0.0.1:${address.port}`;
  for (const id of ["google", "apple"] as const) config[id] = { clientId: `fixture-${id}`, clientSecret: `fixture-${id}-secret`, authorizeUrl: `${url}/${id}/authorize`, tokenUrl: `${url}/${id}/token`, scopes: id === "google" ? "openid email profile" : "name email",
    jwksUrl: `${url}/${id}/jwks`, issuers: [`${url}/${id}`],
    ...(id === "apple" ? { revokeUrl: `${url}/apple/revoke`, nativeClientIds: ["fixture.mobile"], apple: { teamId: "fixture-team", keyId: "fixture-apple-key", privateKey: apple.privateKey.export({ type: "pkcs8", format: "pem" }).toString() } } : {}) };
  const timer = setInterval(() => {
    for (const [key, value] of codes) if (value.expiresAt <= Date.now()) codes.delete(key);
  }, 60_000);
  timer.unref();
  return { url, config,
    /** Apple refresh tokens revoked so far, oldest first */
    revoked: () => [...revoked],
    /** Apple refresh tokens issued and still live */
    appleTokens: () => [...appleRefresh.keys()],
    /** what an iphone hands the service after sign in with apple: an identity token for `clientId` and a one-time code */
    nativeApple({ clientId = "fixture.mobile", subject = users.apple.subject, email = users.apple.email, nonce, privateEmail = false, issuedAt = Math.floor(Date.now() / 1000) }: { clientId?: string; subject?: string; email?: string | null; nonce: string; privateEmail?: boolean; issuedAt?: number }) {
      const authorizationCode = `c${random().slice(0, 40)}.0.n.${random().slice(0, 12)}`;
      nativeCodes.set(authorizationCode, { clientId, subject });
      const identityToken = signToken({ iss: `${url}/apple`, aud: clientId, sub: subject, ...(email ? { email, email_verified: "true", is_private_email: privateEmail ? "true" : "false" } : {}),
        nonce: createHash("sha256").update(nonce).digest("hex"), nonce_supported: true, iat: issuedAt, exp: issuedAt + 600 });
      return { identityToken, authorizationCode };
    },
    setUser(provider: OAuthProvider, profile: FakeProfile) { users[provider] = { ...profile }; },
    deny(provider: OAuthProvider) { denied.add(provider); },
    async close() { clearInterval(timer); await new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); }); },
  };
}
