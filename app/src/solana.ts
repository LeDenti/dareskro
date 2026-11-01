/**
 * The desk's view of the Solana rail: a local service (solana/desk/desk_solana.mjs,
 * 127.0.0.1:8790) that holds the employer's devnet key and talks to the
 * dareskro_escrow program, plus the Solana oracle behind it (8791). If the
 * service is not running, the Solana tab says so and nothing else changes.
 */
const DESK_URL = "http://127.0.0.1:8790";

export type Identity = {
  cluster: string;
  programId: string;
  programExplorer: string;
  employer: { address: string; balanceSol: number | null; explorer: string };
  employee: { address: string; balanceSol: number | null; explorer: string };
  oracle: { name: string; address: string; cluster: string; explorer: string; balanceSol: number | null; watching: number } | null;
  rate: { usdPerSol: number; source: string; at: string } | null;
};

export type LockRequest = {
  statementSha256: string;
  statementId?: string;
  fiat: { amount: string; currency: string };
  destination?: string;
  finishAfterS?: number;
  kind?: "payroll" | "delivery";
  proof?: { url: string; sha256: string };
  cancelAfterS?: number;
  scale?: number;
  validatedBy?: string;
};

export type LockRecord = {
  id: string;
  escrow: string;
  signature: string;
  kind: "payroll" | "delivery";
  cluster: string;
  lamports: number;
  sol: number;
  fiat: { amount: number; currency: string };
  rate: { usdPerSol: number; source: string; at: string };
  scale: number;
  statementSha256: string;
  statementId: string | null;
  destination: string;
  finishAfter: number | null;
  cancelAfter: number | null;
  condition: string | null;
  memos: string[];
  explorer: string;
  escrowExplorer: string;
  lockedAt: string;
  oracle: string | null;
  watched: boolean;
  watchError?: string;
};

export type Attempt = {
  what: "early-finish" | "cancel" | "wrong-destination" | "finish";
  who: string;
  expected: string;
  got: string;
  message?: string | null;
  signature: string;
  explorer: string;
  refused: boolean;
  at: string;
};

export type OnChainEscrow = {
  address: string;
  owner: string;
  destination: string;
  mint: string | null;
  amount: string;
  finishAfter: number | null;
  cancelAfter: number | null;
  condition: string | null;
  memos: string[];
  status: "locked" | "finished" | "cancelled";
  createdAt: number;
  closedAt: number | null;
  closedBy: string | null;
  fulfillment: string | null;
  id: string;
  explorer: string;
  oracle: { status: string; attempts?: number; lastResult?: string; finishExplorer?: string; refundExplorer?: string; lastWhy?: string; checks?: number } | null;
  lock: LockRecord | null;
};

export type FundToken = { assetId: string; symbol: string; blockchain: string; decimals: number; price: number };
export type FundQuote = {
  dry: boolean; amountIn: string; amountInUsd: string; amountOut: string; timeEstimate: number; deadline: string;
  depositAddress: string | null; depositMemo: string | null; withdrawFee: string; minAmountIn: string;
};
export type FundProof = {
  at: string; payer: string; recipient: string; amountIn: string; amountOut: string; seconds: number;
  xrpl: { hash: string; result: string; explorer: string }; solanaTx: string; solanaExplorer: string; usdcBefore: number; usdcAfter: number;
};

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${DESK_URL}${path}`);
  if (!res.ok) throw new Error(`desk ${path}: ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}
async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${DESK_URL}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const json = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new Error(json.error ?? `desk ${path}: ${res.status}`);
  return json;
}

/** undefined when the service does not answer: the tab then says how to start it. */
export async function identity(): Promise<Identity | undefined> {
  try {
    return await get<Identity>("/identity");
  } catch {
    return undefined;
  }
}
export const lock = (r: LockRequest) => post<LockRecord>("/lock", r);
export const attempt = (escrow: string, what: Attempt["what"]) => post<Attempt>("/attempt", { escrow, what });
export const escrows = async () => (await get<{ escrows: OnChainEscrow[] }>("/escrows")).escrows;
export const fundTokens = async () => (await get<{ tokens: FundToken[]; count: number }>("/fund/tokens"));
export const fundQuote = (originAsset: string, usdc: number, refundTo: string, dry = true) => post<FundQuote>("/fund/quote", { originAsset, usdc, refundTo, dry });
export const fundProof = async () => {
  try {
    return await get<FundProof>("/fund/proof");
  } catch {
    return undefined;
  }
};
