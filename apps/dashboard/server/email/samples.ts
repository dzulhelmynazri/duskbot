import { accountDeletedEmail, cancelledEmail, cloudBackEmail, cloudDeletedEmail, cloudDeletionEmail, cloudReadyEmail, codeEmail, paymentFailedEmail, promoEmail, receiptEmail,
  recoveryEmail, welcomeEmail } from "./templates.ts";
import type { EmailConfig, Rendered } from "./templates.ts";

const at = Date.UTC(2026, 10, 11, 14, 30);
const DAY = 86_400_000;
const cloud = { name: "night shift", plan: "plus", machine: "2 vcpu, 4 gb memory, 40 gb disk", region: "oregon" };

/** one filled-in copy of every email, for the tests and the previews */
export function samples(cfg: EmailConfig): Array<{ id: string; trigger: string; email: Rendered }> {
  return ([
    { id: "01-code", trigger: "sign-in or sign-up code (POST /v1/auth/start, app sign-in start)", email: codeEmail(cfg, { code: "48213097" }) },
    { id: "01b-recovery", trigger: "can't sign in (auth start with recover: true)", email: recoveryEmail(cfg, { code: "48213097", link: `${cfg.app}/sign-in?attempt=x#code=48213097`, ways: ["email", "google"] }) },
    { id: "01c-recovery-none", trigger: "can't sign in, no account uses the address", email: recoveryEmail(cfg, { code: "48213097", ways: null }) },
    { id: "02-welcome", trigger: "first sign-up (auth.onAccountCreated)", email: welcomeEmail(cfg, { cloudFromCents: 2000 }) },
    { id: "03-cloud-ready", trigger: "a cloud's first time running (clouds service save)", email: cloudReadyEmail(cfg, cloud) },
    { id: "04-receipt", trigger: "a paid invoice (billing webhook payment.succeeded)", email: receiptEmail(cfg, { amountCents: 2000, currency: "USD", description: "madani cloud plus", paidAt: at,
      receiptId: "inv_7Qm2xK9", periodStart: at, periodEnd: at + 30 * DAY, renews: true, first: true, cloud: true }) },
    { id: "05-payment-failed", trigger: "subscription on_hold or failed (billing webhook)", email: paymentFailedEmail(cfg, { amountCents: 2000, currency: "USD", description: "madani cloud plus", cloudName: cloud.name, fixBy: at + 7 * DAY }) },
    { id: "06-cancelled", trigger: "plan set to end at period end (cancel route or webhook)", email: cancelledEmail(cfg, { description: "madani cloud plus", cloudName: cloud.name, endsAt: at + 20 * DAY, keepDays: 30, keptPaused: true }) },
    { id: "08-cloud-deleted", trigger: "cloud deleted (managed notice deleted, or generic lifecycle)", email: cloudDeletedEmail(cfg, { name: cloud.name, at }) },
    { id: "09-account-deleted", trigger: "account deleted (auth.onAccountDeleted)", email: accountDeletedEmail(cfg, { email: "sam@example.com" }) },
    { id: "10-promo", trigger: "template only: launches and feature news", email: promoEmail(cfg, {
      subject: "rooms are here", preheader: "put a few bots in one chat and let them pass work along.", eyebrow: "new", title: "bots can work together now",
      intro: "rooms are group chats for your bots. give each one a job, drop them in a room, and they hand work to each other while you watch, or don't.",
      features: [{ title: "hand-offs", text: "the researcher finds it, the writer drafts it, the reviewer checks it. one message from you." },
        { title: "jump in any time", text: "type in the room like any group chat. every bot reads along." }],
      cta: { label: "open the app", href: `${cfg.site}/download` }, unsubscribe: "https://madani.bot/unsubscribe?t=sample" }) },
    { id: "07-deletion-warning", trigger: "managed notice left_7: 7 days before a paused cloud is deleted", email: cloudDeletionEmail(cfg, { kind: "warning", name: cloud.name, at: at + 7 * DAY, daysLeft: 7 }) },
    { id: "07a-deletion-last-day", trigger: "managed notice left_1: the day before a paused cloud is deleted", email: cloudDeletionEmail(cfg, { kind: "warning", name: cloud.name, at: at + DAY, daysLeft: 1 }) },
    { id: "07b-deletion-confirm", trigger: "managed notice delete_requested: the owner asked to delete a cloud", email: cloudDeletionEmail(cfg, { kind: "confirm", name: cloud.name, at: null, link: `${cfg.app}/clouds/c1/delete#token` }) },
    { id: "07c-deletion-scheduled", trigger: "managed notice delete_scheduled: the owner confirmed", email: cloudDeletionEmail(cfg, { kind: "scheduled", name: cloud.name, at: at + 7 * DAY }) },
    { id: "03b-cloud-back", trigger: "managed notice recovered: its machine was set up again from a backup", email: cloudBackEmail(cfg, { name: cloud.name, at: at - DAY }) },
  ] as Array<{ id: string; trigger: string; email: Rendered }>).sort((a, b) => a.id.localeCompare(b.id));
}
