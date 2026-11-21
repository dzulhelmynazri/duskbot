import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { CheckoutItem } from "../../../../shared/billing-api.ts";
import { AuthError } from "../auth/index.ts";
import { CloudError, paidCloud } from "../clouds/service.ts";
import type { BillingContext } from "./index.ts";
import { BillingError } from "./service.ts";
import { body, cartInput, cloudName, color, invalid, json, rawBody, survey, text } from "./http.ts";

/** the operator's funnel read: a bearer token from MADANI_OPS_TOKEN, compared in constant time */
function opsAllowed(header: string | undefined, token: string) {
  const given = Buffer.from(header?.startsWith("Bearer ") ? header.slice(7) : "");
  const wanted = Buffer.from(token);
  return given.length === wanted.length && timingSafeEqual(given, wanted);
}
const messages: Record<string, string> = { signed_out: "Sign in to continue.", invalid_request: "Invalid request.", not_found: "Not found.", unavailable: "Billing is unavailable.", bad_signature: "Invalid webhook signature.", checkout_open: "A checkout is already open.", csrf: "Refresh the page and try again.", cap: "Cloud limit reached.", rate_limited: "Try again later.", checkout_soon: "Paid plans open soon. Checkout is not live yet.", discount_used: "This account already used its discount.", discount_unavailable: "The discount is only for a monthly plan that renews.", plan_change_unavailable: "That switch can't be made right now. Nothing changed. Try again in a minute.", change_in_progress: "Your last plan switch is still going through. Give it a few seconds.", payment_failed: "The payment didn't go through, so nothing changed. Check your card and try again.", already_on_plan: "You're already on this plan.", price_changed: "The price changed. Check it and confirm again.", not_subscribed: "There is no active plan to change.",
  seats_full: "Every seat on this team is taken. Add a seat first.", forbidden: "You can't do that.",
  invite_invalid: "This invite link is used up, cancelled or expired. Ask for a new one.", invite_other_email: "This invite was sent to another email address. Sign in with that one to join.",
  already_in_team: "That person is already in a team." };
export function createBillingRoutes(ctx: BillingContext) {
  const { service, clouds } = ctx;
  return async (req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> => {
    const path = url.pathname, method = req.method ?? "GET";
    if (!path.startsWith("/v1/billing/") && path !== "/v1/clouds" && !path.startsWith("/v1/clouds/") && path !== "/v1/team" && !path.startsWith("/v1/team/")) return false;
    if (path === "/v1/billing/fake/complete" && (!ctx.fake || !["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress ?? ""))) return false;
    const webhook = path === "/v1/billing/webhooks/dodo" && method === "POST";
    try {
      if (path === "/v1/billing/catalog" && method === "GET") {
        const wake = ctx.wakeStats();
        // the trial is offered per account: a signed-in one that already had a plan sees the plain prices
        const account = ctx.config.trial ? await Promise.resolve(ctx.accounts.fromCookie(req)).catch(() => null) : null;
        json(res, 200, { ...service.catalog(account), ...(Object.keys(wake).length ? { wake } : {}), ...(ctx.checkoutOpen ? {} : { checkoutOpen: false }) }); return true;
      }
      if (path === "/v1/billing/quote" && method === "POST") { json(res, 200, service.quote(cartInput((await body(req)).cart))); return true; }
      if (path === "/v1/billing/ops/funnel" && method === "GET") {
        if (!ctx.opsToken || !opsAllowed(req.headers.authorization, ctx.opsToken)) throw new BillingError(404, "not_found");
        const days = Number(url.searchParams.get("days") ?? "30");
        if (!Number.isInteger(days) || days < 1 || days > 365) invalid();
        json(res, 200, service.funnel(ctx.now() - days * 86_400_000, ctx.now())); return true;
      }
      if (path === "/v1/billing/ops/grant" && method === "POST") {
        if (!ctx.opsToken || !(ctx.grants || ctx.testPurchases) || !opsAllowed(req.headers.authorization, ctx.opsToken)) throw new BillingError(404, "not_found");
        const data = await body(req), owner = ctx.findAccount(text(data.email).trim().toLowerCase());
        if (!owner) throw new BillingError(404, "not_found");
        if (typeof data.bundle !== "string") invalid();
        // dodo in test mode cannot complete a plan in process: the grant is a real test-mode checkout, marked as the
        // operator's (never revenue), that the harness pays with a test card (scripts/smoke/test-purchase.mjs)
        if (!ctx.grants) {
          const bundle = ctx.config.bundles.find(item => item.id === data.bundle && item.id !== "free");
          if (!bundle) invalid();
          const answer = await service.checkout(owner, { kind: "cart", cart: service.quote({ ...bundle.cart, interval: data.interval === "year" ? "year" : "month" }).cart,
            ...(data.name === undefined ? {} : { name: cloudName(data.name) }) }, { operator: { source: "ops_grant" } });
          json(res, 202, { ok: true, pay: "test_card", checkoutId: answer.checkoutId, checkoutUrl: answer.checkoutUrl, cloudId: answer.cloudId }); return true;
        }
        const { checkoutId } = await ctx.grant(owner, { bundle: data.bundle, interval: data.interval === "year" ? "year" : "month", source: "ops_grant", ...(data.name === undefined ? {} : { name: cloudName(data.name) }) });
        json(res, 200, { ok: true, checkoutId, subscriptions: service.subscriptions(owner.id).map(sub => ({ id: sub.id, status: sub.status, cloudId: sub.cloudId })) }); return true;
      }
      if (path === "/v1/billing/ops/review" && method === "POST") {
        if (!ctx.opsToken || !ctx.reviewEmail || !opsAllowed(req.headers.authorization, ctx.opsToken)) throw new BillingError(404, "not_found");
        const data = await body(req), email = text(data.email).trim().toLowerCase();
        // only App Review's own address: an ops token alone can never make another account's cloud free for good
        if (email !== ctx.reviewEmail) throw new BillingError(403, "forbidden");
        const owner = ctx.findAccount(email);
        if (data.review !== undefined && typeof data.review !== "boolean" || data.grant !== undefined && data.grant !== true) invalid();
        if (!owner) throw new BillingError(404, "not_found");
        // the grant never goes through the payment provider, so it works with billing off, in test mode and live
        const granted = data.grant === true ? service.grantReview(owner, { bundle: data.bundle === undefined ? "starter" : text(data.bundle), name: data.name === undefined ? "Demo Cloud" : cloudName(data.name) }) : null;
        if (granted?.created) void clouds.reconcile().catch(() => {});
        json(res, 200, { ok: true, accountId: owner.id, ...(granted ? { granted } : {}), ...service.markReview(owner.id, data.review !== false) }); return true;
      }
      const purge = /^\/v1\/billing\/ops\/clouds\/(c[0-9a-f]{24})\/delete$/.exec(path);
      if (purge && method === "POST") {
        const managed = clouds.managed, cloud = clouds.get(purge[1]!);
        if (!ctx.opsToken || !opsAllowed(req.headers.authorization, ctx.opsToken) || !managed || !cloud?.managed) throw new BillingError(404, "not_found");
        const reason = text((await body(req)).reason);
        if (!/^[a-z_]{3,40}$/.test(reason)) invalid();
        managed.operatorDelete(cloud, reason);
        void clouds.reconcile().catch(() => {});
        json(res, 200, { ok: true }); return true;
      }
      const endTrial = /^\/v1\/billing\/ops\/clouds\/(c[0-9a-f]{24})\/end-trial$/.exec(path);
      if (endTrial && method === "POST") {
        const managed = clouds.managed, cloud = clouds.get(endTrial[1]!);
        if (!ctx.opsToken || !ctx.endTrials || !opsAllowed(req.headers.authorization, ctx.opsToken) || !managed?.endTrial || !cloud?.managed) throw new BillingError(404, "not_found");
        const reason = text((await body(req)).reason);
        if (!/^[a-z_]{3,40}$/.test(reason)) invalid();
        const answer = managed.endTrial(cloud, reason);
        if ("refused" in answer) { json(res, 409, { error: answer.refused === "no_trial" ? "No package is on trial on this cloud." : "Its self-test has not passed yet.", code: answer.refused }); return true; }
        void clouds.reconcile().catch(() => {});
        json(res, 200, { ok: true, settled: answer.ended }); return true;
      }
      if (!ctx.enabled) throw new BillingError(503, "unavailable");
      if (webhook) {
        service.handleWebhook(req.headers, await rawBody(req, 64 * 1024));
        json(res, 200, { ok: true }); return true;
      }
      const account = await ctx.accounts.fromCookie(req);
      if (!account) throw new BillingError(401, "signed_out");
      const send = (data: unknown) => { json(res, 200, data); return true; };
      if (method === "GET") {
        if (path === "/v1/billing/overview") return send(service.overview(account));
        if (path === "/v1/billing/invoices") return send(service.invoices(account.id, url.searchParams.get("cursor")));
        if (path === "/v1/billing/license") return send(service.licenseCheck(account));
        if (path === "/v1/clouds") return send({ clouds: clouds.list(account.id).filter(paidCloud).map(clouds.view) });
        const invoice = /^\/v1\/billing\/invoices\/([^/]+)\/download$/.exec(path);
        if (invoice) {
          const result = await service.invoiceDownload(account.id, invoice[1]);
          if (result.redirect) { res.writeHead(302, { location: result.redirect, "cache-control": "no-store" }); res.end(); }
          else { res.writeHead(200, { "content-type": "application/pdf", "content-disposition": `attachment; filename="invoice.pdf"`, "cache-control": "no-store" }); res.end(result.pdf!.body); }
          return true;
        }
      }
      if (method === "POST") {
        if (path === "/v1/billing/checkout") {
          if (!ctx.checkoutOpen) throw new BillingError(503, "checkout_soon");
          const data = await body(req); let item: CheckoutItem;
          if (data.kind === "cart") {
            const parsed = service.quote(cartInput(data.cart)).cart;
            const name = data.name === undefined ? undefined : cloudName(data.name), swatch = data.color === undefined ? undefined : color(data.color);
            if (swatch === null) invalid();
            item = { kind: "cart", cart: parsed, ...(name === undefined ? {} : { name }), ...(swatch === undefined ? {} : { color: swatch }) };
          } else return invalid();
          return send(await service.checkout(account, item, { source: data.source }));
        }
        if (path === "/v1/billing/fake/complete" && ctx.fake) {
          const data = await body(req), id = text(data.checkoutId);
          const checkout = ctx.store.state.checkouts.find(c => c.id === id && c.accountId === account.id);
          if (!checkout?.providerSessionId) throw new BillingError(404, "not_found");
          const deliveries = ctx.fake.complete(checkout.providerSessionId);
          for (const delivery of deliveries) service.handleWebhook(delivery.headers, delivery.body);
          void clouds.reconcile().catch(() => {});
          return send({ ok: true, deliveries: deliveries.length });
        }
      }
      const subscription = /^\/v1\/billing\/subscriptions\/([^/]+)\/(preview|change|cancel|keep|retention|discount|card)$/.exec(path);
      if (subscription && method === "POST") {
        if (!service.subscriptions(account.id).some(sub => sub.id === subscription[1])) throw new BillingError(404, "not_found");
        const data = await body(req), id = subscription[1];
        if (subscription[2] === "preview") return send(await service.previewChange(account, id, cartInput(data.cart)));
        if (subscription[2] === "change") return send(await service.change(account, id, text(data.confirmation)));
        if (subscription[2] === "cancel") return send({ subscription: await service.cancel(account, id, data.survey === undefined ? undefined : survey(data.survey)) });
        if (subscription[2] === "retention") return send(service.retentionStep(account, id, data));
        if (subscription[2] === "discount") return send(await service.retentionDiscount(account, id, data.reason));
        if (subscription[2] === "card") { if (!ctx.checkoutOpen) throw new BillingError(503, "checkout_soon"); return send(await service.updateCard(account, id)); }
        return send({ subscription: await service.keep(account, id) });
      }
      if (path === "/v1/team" && method === "GET") return send({ team: ctx.teams.get(account) });
      if (path === "/v1/team/invites" && method === "POST") return send({ team: ctx.teams.invite(account, (await body(req)).email) });
      if (path === "/v1/team/join" && method === "POST") return send({ team: ctx.teams.join(account, (await body(req)).token) });
      const team = /^\/v1\/team\/(invites|members)\/([^/]+)$/.exec(path);
      if (team && method === "DELETE") {
        await body(req);
        let key: string; try { key = decodeURIComponent(team[2]!); } catch { return invalid(); }
        return send({ team: team[1] === "invites" ? ctx.teams.cancel(account, key) : ctx.teams.remove(account, key) });
      }
      const member = /^\/v1\/billing\/licenses\/([^/]+)\/members(?:\/([^/]+))?$/.exec(path);
      if (member && ((method === "POST" && !member[2]) || (method === "DELETE" && member[2]))) {
        if (!ctx.store.state.licenses.some(l => l.id === member[1] && l.ownerAccountId === account.id)) throw new BillingError(404, "not_found");
        if (method === "POST") return send({ license: service.addMember(account, member[1], text((await body(req)).email)) });
        await body(req);
        let email: string; try { email = decodeURIComponent(member[2]); } catch { return invalid(); }
        return send({ license: service.removeMember(account, member[1], email) });
      }
      const cloudMatch = /^\/v1\/clouds\/([^/]+)(\/power)?$/.exec(path);
      if (cloudMatch) {
        const cloud = clouds.owned(account.id, cloudMatch[1]);
        if (!cloud) throw new BillingError(404, "not_found");
        if (!cloudMatch[2] && method === "GET") return send({ cloud: clouds.view(cloud) });
        if (!cloudMatch[2] && method === "PATCH") {
          const data = await body(req);
          return send({ cloud: clouds.view(clouds.rename(account.id, cloud.id, { ...(data.name === undefined ? {} : { name: text(data.name) }), ...(data.color === undefined ? {} : { color: color(data.color) }) })) });
        }
        if (cloudMatch[2] && method === "POST") {
          const data = await body(req); if (data.action !== "on" && data.action !== "off") invalid();
          return send({ cloud: clouds.view(await clouds.power(account.id, cloud.id, data.action)) });
        }
      }
      throw new BillingError(404, "not_found");
    } catch (error) {
      const known = error instanceof BillingError || error instanceof CloudError || error instanceof AuthError;
      const code = known ? error.code : "failed";
      const status = webhook ? code === "bad_signature" ? 401 : known && error.status === 400 ? 400 : 500 : known ? error.status : 500;
      json(res, status, { error: messages[code] ?? "Request failed.", code, ...(error instanceof BillingError && error.url ? { checkoutUrl: error.url } : {}) });
      return true;
    }
  };
}
