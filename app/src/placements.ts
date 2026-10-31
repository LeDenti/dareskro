/**
 * The desk's view of the placement service (placements/server.mjs, 127.0.0.1:8789):
 * campaigns BottomRadar pays creators for, each backed by one presence escrow
 * the oracle releases only if the publication is still there at the date.
 */
import type { WatchedEscrow } from "./oracle";

const PLACEMENTS_URL = "http://127.0.0.1:8789";

export type Observation = {
  at: string;
  url: string;
  mustContain: string | null;
  platform: "x" | "youtube" | "web";
  method: string;
  status: number;
  finalUrl?: string;
  redirected?: boolean;
  live: boolean;
  textFound: boolean | null;
  ok: boolean;
  why: string;
  author?: string | null;
  excerpt?: string;
  jsRendered?: boolean;
  bodySha256?: string | null;
  bytes?: number;
  ms?: number;
  /** "watch" before the date, "decision" at the date (set by the oracle). */
  phase?: "watch" | "decision";
};

export type Contract = {
  version: string;
  id: string;
  advertiser: { name: string; address: string | null };
  creator: { name: string | null; handle: string | null; address: string };
  publication: { url: string; urlSha256: string; platform: "x" | "youtube" | "web"; mustContain: string };
  amountXrp: string;
  periodEnd: string;
  deadline: string;
  oracle: string | null;
  created: string;
  note?: string;
};

export type CampaignStatus = "draft" | "locked" | "watching" | "deciding" | "released" | "refunded" | "gone" | "failed" | "invalid";

export type Campaign = {
  id: string;
  created: string;
  status: CampaignStatus;
  publicUrl: boolean;
  contract: Contract;
  contractSha256: string;
  finishAfter: number;
  cancelAfter: number;
  deliveryId: string;
  condition: string;
  proof: { url: string; mustContain?: string };
  probeEveryS: number;
  memos: { type: string; data: string }[];
  memosCompact: { type: string; data: string }[];
  escrow?: { owner: string; sequence: number; createHash: string; lockedAt: string };
  preChecks?: Observation[];
  oracle: WatchedEscrow | null;
  observations?: Observation[];
  links: { creator: string; api: string; escrow: string | null; release: string | null; refund: string | null; creatorAccount: string; oracleAccount: string | null };
};

export type NewCampaign = {
  advertiser?: { name?: string; address?: string };
  creator: { address: string; handle?: string; name?: string };
  url: string;
  mustContain: string;
  amountXrp: string;
  /** ISO date, or "<n>s" for n seconds from now (rehearsals). */
  periodEnd: string;
  deadline?: string;
  publicUrl?: boolean;
  probeEveryS?: number;
  note?: string;
};

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${PLACEMENTS_URL}${path}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: unknown = {};
  try {
    json = JSON.parse(text);
  } catch {
    /* no body */
  }
  if (!res.ok) throw new Error(`placements ${method} ${path}: ${res.status} ${(json as { error?: string }).error ?? text.slice(0, 200)}`);
  return json as T;
}

/** false when no service answers: the desk then says how to start it. */
export async function alive(): Promise<boolean> {
  try {
    const res = await fetch(`${PLACEMENTS_URL}/campaigns`);
    return res.ok;
  } catch {
    return false;
  }
}

export const list = () => call<{ campaigns: Campaign[] }>("GET", "/campaigns").then((r) => r.campaigns);
export const get = (id: string) => call<Campaign>("GET", `/campaigns/${id}`);
export const create = (body: NewCampaign) => call<Campaign>("POST", "/campaigns", body);
export const observeNow = (url: string, mustContain: string) => call<Observation>("POST", "/observe", { url, mustContain });
export const observeCampaign = (id: string) => call<Observation>("POST", `/campaigns/${id}/observe`);
export const locked = (id: string, body: { owner: string; sequence: number; createHash: string }) =>
  call<{ ok: boolean; note?: string; campaign: Campaign }>("POST", `/campaigns/${id}/locked`, body);
