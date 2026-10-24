/**
 * The pay desk's view of the oracle: a local service (oracle/oracle.mjs watch)
 * that finishes escrows at their date. If it is not running, the page says so
 * and the release stays manual — the escrow does not depend on it.
 *
 * Four kinds of escrow, one account. payroll: FinishAfter only, the oracle
 * decides *when*. delivery, presence, affiliate: Condition + CancelAfter, the
 * oracle holds the secret and decides *whether* — from a public fact (delivery:
 * a file's hash, presence: a post still live) or from a party's word (affiliate:
 * the merchant confirms with a token). Past CancelAfter it refunds the payer.
 */
const ORACLE_URL = "http://127.0.0.1:8787";

export type OracleIdentity = {
  name: string;
  address: string;
  network: string;
  created: string;
  birth: string;
  birthResult: string;
  explorer: string;
  birthExplorer: string;
  watching: number;
};

export type EscrowKind = "payroll" | "delivery" | "presence" | "affiliate";

/** What the oracle agreed to check. delivery: url + sha256; presence: url (+ mustContain); affiliate: orderRef. */
export type Proof = { url?: string; sha256?: string; mustContain?: string; orderRef?: string };

export type WatchedEscrow = {
  /** Absent on the payroll entries registered before the kinds existed. */
  kind?: EscrowKind;
  deliveryId?: string;
  owner: string;
  sequence: number;
  /** Absent on an affiliate escrow (no date, only a deadline). */
  finishAfter?: number;
  cancelAfter?: number;
  /** presence: the oracle decides at this ripple time whether the post is still there. */
  checkAfter?: number;
  destination: string;
  amountXrp?: string;
  proof?: Proof;
  statementSha256?: string;
  createHash?: string;
  /** "crypto": the employee keeps the XRP the ledger releases; "usd": dollars (RLUSD) through Mastercard AP4M once released. */
  payout?: "crypto" | "usd";
  amount?: string;
  currency?: string;
  payoutResult?: {
    paid_at: string; amount_rlusd: string; scale: number; redemption_explorer: string; payout_tx: string | null; receipt_url: string | null; payout_wallet?: string;
  } | { error: string };
  status: "waiting" | "finished" | "failed" | "gone" | "expired-refunded";
  registered: string;
  attempts?: number;
  lastResult?: string;
  lastHash?: string;
  lastTry?: string;
  finishedAt?: string;
  finishHash?: string;
  note?: string;
  /** Conditional kinds: the oracle's last word on the proof, and how many times it looked. */
  lastWhy?: string;
  checks?: number;
  /** presence: the last look at the post before the decision date. */
  lastSeen?: { at: string; live: boolean; why?: string };
  /** affiliate: the merchant's confirmation, carried into the EscrowFinish memo. */
  confirmed?: { orderHash: string; at: string };
  refundHash?: string;
  orderHash?: string;
};

/** undefined when no oracle answers: the page then works without it. */
export async function identity(): Promise<OracleIdentity | undefined> {
  try {
    const res = await fetch(`${ORACLE_URL}/identity`);
    if (!res.ok) return undefined;
    return (await res.json()) as OracleIdentity;
  } catch {
    return undefined;
  }
}

export async function watch(e: Omit<WatchedEscrow, "status" | "registered">): Promise<void> {
  const res = await fetch(`${ORACLE_URL}/watch`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(e),
  });
  if (!res.ok) throw new Error(`oracle /watch: ${res.status} ${await res.text()}`);
}

export async function escrows(): Promise<WatchedEscrow[]> {
  try {
    const res = await fetch(`${ORACLE_URL}/escrows`);
    if (!res.ok) return [];
    return ((await res.json()) as { escrows: WatchedEscrow[] }).escrows;
  } catch {
    return [];
  }
}

export type ConditionRequest = {
  kind: "delivery" | "presence" | "affiliate";
  url?: string;
  sha256?: string;
  mustContain?: string;
  orderRef?: string;
  note?: string;
};

export type ConditionResponse = {
  deliveryId: string;
  /** Uppercase DER hex, goes in EscrowCreate.Condition. */
  condition: string;
  proof: Proof;
  /** affiliate only, given once: the oracle keeps only its SHA-256. */
  confirmToken?: string;
};

/** Ask the oracle for a condition before locking. The oracle keeps the secret; the payer gets the condition and the agreed proof. */
export async function condition(body: ConditionRequest): Promise<ConditionResponse> {
  const res = await fetch(`${ORACLE_URL}/condition`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`oracle /condition: ${res.status} ${await res.text()}`);
  return (await res.json()) as ConditionResponse;
}

/**
 * The merchant's sales system confirms an attributed sale. Returns the status
 * rather than throwing: a 403 (bad token) is a result the desk shows on purpose.
 */
export async function confirmAffiliate(body: {
  deliveryId: string;
  orderHash: string;
  token: string;
}): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${ORACLE_URL}/affiliate/confirm`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  let json: Record<string, unknown> = {};
  try {
    json = (await res.json()) as Record<string, unknown>;
  } catch {
    /* no body */
  }
  return { status: res.status, json };
}
