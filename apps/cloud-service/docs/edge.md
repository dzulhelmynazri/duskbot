# The public edge and its hook queue

`edge/worker.js` is the Cloudflare Worker in front of every managed home (`https://<label>.<MADANI_MANAGED_PUBLIC_DOMAIN>`).
It asks the account service (`GET /v1/managed/edge/route`, `POST /v1/managed/edge/wake`, both behind
`MADANI_MANAGED_EDGE_TOKEN`) where a label goes and whether that home is awake.

## Who wakes a sleeping home

- A webhook: any request under `/hooks/*`.
- A signed-in client acting: a non-GET with `authorization` or a cookie, unless it carries `x-madani-background: 1` (the
  app's focus pings and other hints).
- Nothing else. Reads and anonymous traffic get a 503 with `retry-after: 5`.

Each wake is a provider start, so the service caps them per home per hour (`MADANI_MANAGED_EDGE_WAKES_PER_HOUR`); over the
cap the sender gets 429 with `retry-after: 300`. A body over 2 MB gets 413.

## Webhooks for a sleeping home are queued

GitHub waits 10 s and never retries, and a long-asleep home can take 20 to 25 s to answer. So with the queue bound:

1. The Worker reads the body (413 over 2 MB) and works out the delivery id (below).
2. It hands the request to the `HookQueue` Durable Object for that label (`edge/hook-queue.js`). The object seals it and
   stores it, or answers that the id is already queued or was delivered in the last 24 hours.
3. The Worker asks for the wake. If the wake is refused (429 over the cap, 409 no longer wakeable) the stored hook is
   forgotten and the sender hears 429 or 503, exactly as before. Otherwise the sender gets **202** at once, with the id
   in `x-madani-delivery`.
4. The object's alarm looks at the home a second later and then backs off (1, 2, 4 ... 30 s), asking for the wake again
   while it waits (free while a wake is under way). When the home is up it delivers each hook oldest first, with the
   original method, path, query, headers (signature headers included) and the body byte for byte, plus
   `x-forwarded-host`. A home answering 502, 503, 504 or 521 to 523 is not up yet; any other answer counts as delivered.
5. A hook not delivered within 30 minutes is dropped; so is every queued hook of a label that no longer maps to a home
   or can no longer be woken. Each outcome is one JSON log line in the Worker's logs, with the label, the id, the
   reason or status, the attempts and the age, never the payload:
   `{"event":"edge_hook_delivered",...}` and `{"event":"edge_hook_dropped","reason":"expired"|"no_home"|"not_wakeable"|"unsealable",...}`.

The alarm and the storage outlive the isolate that took the hook. A label keeps at most 50 hooks and 16 MB; past that
new hooks get 503 and the sender retries (or not).

An awake home is never queued for: its webhooks are forwarded directly, as always. A client's action is still held
until the home answers (up to 25 s), since the app shows its own waking state.

### Delivery id

The sender's own id where it sends one: `X-GitHub-Delivery`, then Standard Webhooks' `webhook-id`, then `svix-id`, then
the `id` of a Stripe event body (`evt_...`, read only when `stripe-signature` is present). Anything else is identified
by a SHA-256 of method and body. The id is hashed again with the path and query, so the same id on two hook paths are
two hooks. One consequence of the fallback: a sender with no id that posts the same body to the same path twice within
a queue's lifetime gets it delivered once.

### Sealing

Each hook is sealed with AES-256-GCM (fresh IV, the id as associated data) under a key derived per label (HKDF-SHA-256)
from `HOOK_SEAL_KEY`, a secret only the Worker holds. The object's storage holds the ciphertext in 96 KB chunks, the
IV, the hash id, the time and the size; never the path, the headers or the body in the clear. The account service never
sees a queued hook at all.

This is weaker than sealing to the home's own public key: the Worker can open what it stored. Sealing to the home would
need the home to publish an encryption key and accept sealed deliveries on a new endpoint in its webhook ingress, so the
edge could no longer forward the original request as sent. That is a later step if the threat model asks for it.

## Bindings the Worker needs

```jsonc
{
  "main": "apps/cloud-service/edge/worker.js",
  "vars": { "ROUTE_URL": "https://<account service>", "PUBLIC_DOMAIN": "<wildcard parent>" },
  "durable_objects": { "bindings": [{ "name": "HOOK_QUEUE", "class_name": "HookQueue" }] },
  "migrations": [{ "tag": "hook-queue-v1", "new_sqlite_classes": ["HookQueue"] }]
}
```

One edge can front several account services on the same public domain (preview and production): `ROUTE_URL` lists
their origins comma-separated, and `EDGE_TOKEN` holds one token for all or one per origin in the same order. A label
belongs to one service; the edge asks them in order, sends the wake to the one that answered, and never treats a label
as missing while a service that might know it is down.

Secrets: `wrangler secret put EDGE_TOKEN` (same value as `MADANI_MANAGED_EDGE_TOKEN`) and `wrangler secret put
HOOK_SEAL_KEY` (32 random bytes, base64url; 32 characters at least). Rotating `HOOK_SEAL_KEY` makes hooks queued at that
moment unsealable: they are dropped with `reason: "unsealable"`, so rotate while few hooks are queued.

Without `HOOK_QUEUE` or `HOOK_SEAL_KEY` the Worker keeps the older behaviour: the webhook is held until the home answers
(up to 25 s).

## Tests

`src/edge-wake.test.ts` covers both paths against the real service routes and a fake provider; `src/fake-hook-queue.ts`
is the Durable Object namespace the tests and `scripts/e2e.ts --fake` (step 6d) use.
