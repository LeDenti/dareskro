/**
 * The desk's view of the PayPal rail: a local service (paypal/service.mjs, 127.0.0.1:8796) that
 * holds the sandbox app's credentials and the seat's key, and talks to PayPal: a hold (an order
 * with intent AUTHORIZE, approved by the payer on PayPal's page), a capture — partial if the rule
 * says so — a void, a payout. Seven shapes, one rule table each (paypal/kinds.mjs); the AI seat
 * (paypal/seat.mjs) reads and writes a memo, it never moves money. If the service is not running,
 * the PayPal tab says so and nothing else changes. Hosted (Render), the service serves this desk itself
 * and the tab talks to its own origin.
 */
// VITE_PAYPAL_DESK_URL: the service's origin; empty = the page's own origin (the hosted desk, served by service.mjs)
const DESK_URL = (import.meta.env.VITE_PAYPAL_DESK_URL as string | undefined) ?? "http://127.0.0.1:8796";

export type Kind = "payroll" | "delivery" | "presence" | "affiliate" | "pool" | "vault" | "advance";
export const KINDS: Kind[] = ["payroll", "delivery", "presence", "affiliate", "pool", "vault", "advance"];
export type State = "drafted" | "offered" | "locked" | "delivered" | "reviewed" | "validated" | "released" | "repaid" | "refused" | "expired";

export type Identity = {
  mode: "sandbox" | "mock";
  seat: string;
  holdDays: number;
  feeBps: number;
  base: string;
  counts: Record<State, number>;
};
export type Payer = {
  name: string;
  email: string;
  amount: number;
  trimmedTo?: number;
  orderId?: string;
  orderStatus?: string;
  approveUrl?: string;
  intent?: "AUTHORIZE" | "CAPTURE";
  authorizationId?: string;
  authorizationStatus?: string;
  held?: { currency_code: string; value: string };
  expiresAt?: string;
  captureId?: string;
  captured?: string;
  releasedToPayer?: string;
  paidFrom?: string;
};
export type Reason = { check: string; ok: boolean; why: string };
export type Release = {
  at: string;
  captures: { payer: string; captureId: string; captured: string; releasedToPayer?: string }[];
  payout: { batchId: string; status: string; items: { receiver: string; amount: string; label: string }[] } | null;
  fee: { bps: number; total: string };
  gate: Reason[];
};
export type Memo = {
  sha256: string;
  file: string;
  recommendation: "release" | "hold" | "refuse";
  model: string;
  at: string;
  deliverableUrl?: string;
  deliverableSha256?: string;
  criteriaMet?: number;
  criteriaTotal?: number;
};
export type MemoFull = {
  summary: string;
  evidence: { fact: string; source: string }[];
  criteria: { criterion: string; met: boolean; why: string }[];
  recommendation: "release" | "hold" | "refuse";
  unverified: string[];
  model: string;
};
export type Mission = {
  id: string;
  kind: Kind;
  state: State;
  title: string;
  currency: string;
  amount?: number;
  target?: number;
  invoiceAmount?: number;
  payers: Payer[];
  payees?: { label: string; email: string; amount: number }[];
  finishAfter?: string;
  checkAfter?: string;
  deadlineAt?: string;
  dueAt?: string;
  deliverable?: { url: string; sha256: string | null; bytes: number | null; ok: boolean; why: string | null; at: string };
  memo?: Memo;
  validation?: { by: string; decision: "release" | "refuse"; at: string; memoSha256?: string };
  lastSeen?: { at: string; ok: boolean; why: string; decision: boolean };
  proof?: { url: string; mustContain?: string };
  confirmation?: { at: string; orderRef?: string; orderSha256?: string };
  parties?: string[];
  threshold?: number;
  votes?: { party: string; toBeneficiary: number; at: string }[];
  custody?: boolean;
  policy?: { ok: boolean; checks: Reason[]; at: string };
  signatures?: { ai: boolean; policy: boolean; operator: boolean; count: number };
  repayment?: { orderId: string; approveUrl: string; amount: number; dueAt?: string; captureId?: string; status?: string; at?: string };
  release?: Release;
  refund?: { batchId: string; status: string };
  history: { at: string; what: string; [k: string]: unknown }[];
  confirmToken?: string; // only on the draft's answer, once
  [k: string]: unknown;
};
export type Answer<T = Mission> = { ok: boolean; status: number; body: T & { error?: string; reasons?: Reason[]; errors?: string[] } };

async function call<T = Mission>(method: "GET" | "POST", path: string, body?: unknown): Promise<Answer<T>> {
  const res = await fetch(`${DESK_URL}${path}`, body === undefined ? { method } : { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const json = (await res.json().catch(() => ({ error: `desk ${path}: ${res.status}` }))) as Answer<T>["body"];
  return { ok: res.ok, status: res.status, body: json };
}

/** undefined when the service does not answer: the tab then says how to start it. */
export async function identity(): Promise<Identity | undefined> {
  try {
    const r = await call<Identity>("GET", "/identity");
    return r.ok ? r.body : undefined;
  } catch {
    return undefined;
  }
}
export const missions = async () => (await call<Mission[]>("GET", "/missions")).body;
export const mission = async (id: string) => (await call("GET", `/missions/${id}`)).body;
export const memo = async (id: string) => (await call<MemoFull>("GET", `/missions/${id}/memo`)).body;
export const draft = (body: Record<string, unknown>) => call("POST", "/missions", body);
export type Action = "offer" | "fund" | "lock" | "deliver" | "review" | "policy" | "validate" | "confirm" | "probe" | "vote" | "release" | "void" | "repay" | "repaid";
export const act = (id: string, action: Action, body: Record<string, unknown> = {}) => call<Mission & { mission?: Mission; payer?: Payer; release?: Release }>("POST", `/missions/${id}/${action}`, body);
/** The mock rail's "click on PayPal's page": the approve link is the desk's own. */
export const mockApprove = async (approveUrl: string) => (await fetch(approveUrl)).ok;
export const fixture = (file: string) => `${DESK_URL}/fixtures/${file}`;
