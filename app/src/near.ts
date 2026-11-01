/**
 * The desk's view of the NEAR rail: a local service (near/desk/desk_near.mjs, 127.0.0.1:8794)
 * that holds the testnet keys of the demo roles and talks to the dareskro contract
 * (dareskro.testnet): escrows, sealed payslips, and the shared deposit decided 2 of 3.
 * If the service is not running, the NEAR tab says so and nothing else changes.
 */
const DESK_URL = "http://127.0.0.1:8794";

export type Role = "tenant" | "landlord" | "mediator" | "stranger" | "employee" | "employer";
export type Identity = {
  network: string;
  contract: string;
  contractExplorer: string;
  chainNowMs: number;
  roles: Record<Role, { account: string; balanceNear: string; explorer: string }>;
  counts: { escrows: number; vaults: number; payslips: number };
};
export type Outcome = { ok: boolean; hash: string; explorer: string; error: string | null };
export type Escrow = {
  id: string;
  owner: string;
  destination: string;
  amountNear: string;
  finish_after: string | null;
  cancel_after: string | null;
  condition: string | null;
  memos: string[];
  status: "Locked" | "Finished" | "Cancelled";
  closed_by: string | null;
  fulfillment: string | null;
};
export type LockRecord = Outcome & { id: string; destination: string; finishAfterMs: number; memos: string[]; amountNear: string; lockedAt: string };
export type Attempt = Outcome & { id: string; what: "early-finish" | "cancel" | "finish"; who: string; refused: boolean; at: string };
export type Vote = { party: string; toBeneficiaryNear: string };
export type VaultEvent = Outcome & { id: string; action: "create" | "vote" | "timeout"; by: string; toBeneficiaryNear?: string; decided?: boolean; refused?: boolean; status: string | null; at: string };
export type Vault = {
  id: string;
  owner: string;
  beneficiary: string;
  amountNear: string;
  parties: string[];
  threshold: number;
  votes: Vote[];
  deadline: string | null;
  memos: string[];
  status: "Locked" | "Finished" | "Cancelled";
  paidToBeneficiaryNear: string;
  closed_by: string | null;
  history: VaultEvent[];
};
export type Payslip = { token_id: string; owner_id: string; metadata: { title: string; description: string; reference_hash: string }; extra: { readers?: string[]; sealed_bytes?: number; escrow_id?: string } };

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
export const escrows = async () => (await get<{ escrows: Escrow[] }>("/escrows")).escrows;
export const vaults = async () => (await get<{ vaults: Vault[] }>("/vaults")).vaults;
export const payslips = async (owner?: string) => (await get<{ owner: string; payslips: Payslip[] }>(`/payslips${owner ? `?owner=${owner}` : ""}`)).payslips;
export const lock = (r: { statementSha256: string; fiat: { amount: string; currency: string }; finishAfterS: number; nearAmount: number; validatedBy?: string }) => post<LockRecord>("/lock", r);
export const attempt = (id: string, what: Attempt["what"]) => post<Attempt>("/attempt", { id, what });
export const vaultCreate = (r: { owner: Role; beneficiary: Role; parties: Role[]; threshold: number; deadlineS?: number; nearAmount: number; memos: string[] }) => post<VaultEvent>("/vault/create", r);
export const vaultVote = (id: string, as: Role, toBeneficiaryNear: string) => post<VaultEvent>("/vault/vote", { id, as, toBeneficiaryNear });
export const vaultTimeout = (id: string, as: Role) => post<VaultEvent>("/vault/timeout", { id, as });
