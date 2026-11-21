// unsubscribe links for the news emails: t = base64url(email) "." base64url(hmac-sha256(secret, "unsubscribe:" + email)).
// the email rides in the link so the server needs no lookup table; the mac proves the link came from us.
// the secret is MADANI_UNSUBSCRIBE_SECRET (the [landing] part of madani.env). no secret: every link reads as invalid.
import { createHmac, timingSafeEqual } from 'node:crypto';

const mac = (secret, email) => createHmac('sha256', secret).update(`unsubscribe:${email}`).digest();

export function unsubscribeToken(secret, email) {
  if (!secret) throw new Error('unsubscribe: no secret');
  const clean = String(email).trim().toLowerCase();
  return `${Buffer.from(clean).toString('base64url')}.${mac(secret, clean).toString('base64url')}`;
}

/** the email a token was made for, or null when it is malformed, cut short or not signed with this secret */
export function emailFromToken(secret, token) {
  if (!secret || typeof token !== 'string' || token.length > 600) return null;
  const m = /^([A-Za-z0-9_-]{4,400})\.([A-Za-z0-9_-]{43})$/.exec(token);
  if (!m) return null;
  const email = Buffer.from(m[1], 'base64url').toString('utf8');
  if (!email.includes('@') || email !== email.trim().toLowerCase()) return null;
  const given = Buffer.from(m[2], 'base64url'), want = mac(secret, email);
  return given.length === want.length && timingSafeEqual(given, want) ? email : null;
}
