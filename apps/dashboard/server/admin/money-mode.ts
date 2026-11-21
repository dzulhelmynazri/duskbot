export type MoneyMode = "test" | "live";
export type MoneyView = MoneyMode | "all";

interface MoneyRecords {
  subscriptions: ReadonlyArray<{ id: string; mode?: MoneyMode }>;
  invoices: ReadonlyArray<{ providerPaymentId: string; subscriptionId: string | null; mode?: MoneyMode }>;
  refunds?: ReadonlyArray<{ paymentId: string }>;
  ledger?: ReadonlyArray<{ subscriptionId: string | null; providerPaymentId: string | null }>;
  checkouts: ReadonlyArray<{ subscriptionId: string | null }>;
}

/** which money the panel counts, from the x-madani-admin-money header: live unless it asks for test or all */
export const moneyViewOf = (value: unknown): MoneyView => value === "test" || value === "all" ? value : "live";

/** the records made in one mode: a record without a stamp was made in the server's provider mode (preview's dodo is test),
 *  and test money never counts toward live numbers, or the other way. a read-only copy; nothing in the store changes */
export function moneyIn<T extends MoneyRecords>(state: T, want: MoneyView, serverMode: MoneyMode): T {
  if (want === "all") return state;
  const subMode = new Map(state.subscriptions.map(sub => [sub.id, sub.mode ?? serverMode]));
  const payMode = new Map(state.invoices.map(row => [row.providerPaymentId, row.mode ?? (row.subscriptionId ? subMode.get(row.subscriptionId) : undefined) ?? serverMode]));
  const of = (subscriptionId: string | null | undefined, paymentId?: string | null) =>
    (subscriptionId ? subMode.get(subscriptionId) : undefined) ?? (paymentId ? payMode.get(paymentId) : undefined) ?? serverMode;
  return { ...state, subscriptions: state.subscriptions.filter(sub => subMode.get(sub.id) === want),
    invoices: state.invoices.filter(row => payMode.get(row.providerPaymentId) === want),
    ...(state.refunds ? { refunds: state.refunds.filter(row => (payMode.get(row.paymentId) ?? serverMode) === want) } : {}),
    ...(state.ledger ? { ledger: state.ledger.filter(row => of(row.subscriptionId, row.providerPaymentId) === want) } : {}),
    checkouts: state.checkouts.filter(row => of(row.subscriptionId) === want) };
}

/** a plan, checkout or cloud the operator gave (an ops grant, an admin comp, App Review's cloud), never something bought */
const OPS_SOURCES = new Set(["ops_grant", "admin_comp"]);
export const isOpsMade = (row: { source?: string | null; review?: boolean }) => row.review === true || OPS_SOURCES.has(row.source ?? "");

interface OpsRecords {
  subscriptions: ReadonlyArray<{ id: string; checkoutId: string; source?: string | null; review?: boolean }>;
  checkouts: ReadonlyArray<{ id: string; source: string | null; subscriptionId: string | null }>;
  invoices: ReadonlyArray<{ providerPaymentId: string; subscriptionId: string | null; checkoutId: string | null }>;
  refunds?: ReadonlyArray<{ paymentId: string }>;
  ledger?: ReadonlyArray<{ subscriptionId: string | null; providerPaymentId: string | null }>;
}
/** the records without anything the operator made and the payments, refunds and ledger rows that hang off it, so a grant
 *  is never revenue, mrr, a customer or a conversion in any mode. a read-only copy */
export function withoutOps<T extends OpsRecords>(state: T): T {
  const subs = new Set(state.subscriptions.filter(isOpsMade).map(row => row.id));
  const checkouts = new Set(state.checkouts.filter(row => isOpsMade(row) || (row.subscriptionId !== null && subs.has(row.subscriptionId))).map(row => row.id));
  for (const row of state.subscriptions) if (checkouts.has(row.checkoutId)) subs.add(row.id);
  if (!subs.size && !checkouts.size) return state;
  const opsPayment = (row: OpsRecords["invoices"][number]) => (row.subscriptionId !== null && subs.has(row.subscriptionId)) || (row.checkoutId !== null && checkouts.has(row.checkoutId));
  const payments = new Set(state.invoices.filter(opsPayment).map(row => row.providerPaymentId));
  return { ...state, subscriptions: state.subscriptions.filter(row => !subs.has(row.id)), checkouts: state.checkouts.filter(row => !checkouts.has(row.id)),
    invoices: state.invoices.filter(row => !payments.has(row.providerPaymentId)),
    ...(state.refunds ? { refunds: state.refunds.filter(row => !payments.has(row.paymentId)) } : {}),
    ...(state.ledger ? { ledger: state.ledger.filter(row => !(row.subscriptionId && subs.has(row.subscriptionId)) && !(row.providerPaymentId && payments.has(row.providerPaymentId))) } : {}) };
}

/** a billing event the analytics log holds for something the operator made: its ledger row ("billing", at the row's time)
 *  or its paid receipt ("checkout_paid", by amount when no bought payment of that amount exists) */
type Invoice = { accountId: string; amountCents: number; providerPaymentId: string; subscriptionId: string | null; checkoutId: string | null };
type Ledger = { accountId: string | null; at: number; subscriptionId: string | null; providerPaymentId: string | null };
export function opsEventOf(state: Omit<OpsRecords, "invoices" | "ledger"> & { invoices: readonly Invoice[]; ledger?: readonly Ledger[] }) {
  const kept = withoutOps(state);
  if (kept === state) return () => false;
  const keptPayments = new Set(kept.invoices.map(row => row.providerPaymentId)), keptLedger = new Set<Ledger>(kept.ledger ?? []);
  const opsLedger = new Set((state.ledger ?? []).filter(row => !keptLedger.has(row) && row.accountId).map(row => `${row.accountId}|${row.at}`));
  const bought = new Set(state.invoices.filter(row => keptPayments.has(row.providerPaymentId)).map(row => `${row.accountId}|${row.amountCents}`));
  const granted = new Set(state.invoices.filter(row => !keptPayments.has(row.providerPaymentId)).map(row => `${row.accountId}|${row.amountCents}`));
  return (event: { name: string; at: number; accountId: string | null; props: Record<string, unknown> }) => {
    if (!event.accountId) return false;
    if (event.name === "billing") return opsLedger.has(`${event.accountId}|${event.at}`);
    if (event.name === "checkout_paid") { const key = `${event.accountId}|${Number(event.props.amountCents) || 0}`; return granted.has(key) && !bought.has(key); }
    return false;
  };
}
