/**
 * The pay desk's view of the oracle: a local service (oracle/oracle.mjs watch)
 * that finishes escrows at their date. If it is not running, the page says so
 * and the release stays manual — the escrow does not depend on it.
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

export type WatchedEscrow = {
  owner: string;
  sequence: number;
  finishAfter: number;
  destination: string;
  amountXrp?: string;
  statementSha256?: string;
  createHash?: string;
  /** "crypto": the employee keeps the XRP the ledger releases; "usd": dollars (RLUSD) through Mastercard AP4M once released. */
  payout?: "crypto" | "usd";
  amount?: string;
  currency?: string;
  payoutResult?: {
    paid_at: string; amount_rlusd: string; scale: number; redemption_explorer: string; payout_tx: string | null; receipt_url: string | null; payout_wallet?: string;
  } | { error: string };
  status: "waiting" | "finished" | "failed" | "gone";
  registered: string;
  attempts?: number;
  lastResult?: string;
  lastHash?: string;
  lastTry?: string;
  finishedAt?: string;
  finishHash?: string;
  note?: string;
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
