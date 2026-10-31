/**
 * A placement campaign — the contract between an advertiser (BottomRadar) and a
 * creator, paid by one XRPL escrow the oracle releases only if the publication
 * is still online, with the agreed text, at the end of the period.
 *
 * Pure model: no network, no file. server.mjs stores campaigns and talks to the
 * oracle; the desk (app/) and the demo script build the escrow from what this
 * file computes.
 *
 * The escrow shape is the oracle's `presence` kind, measured on testnet 24/10:
 *   Condition   (PREIMAGE-SHA-256 issued by the oracle, which keeps the secret)
 *   FinishAfter = the end of the period: even with the secret, nobody can pay before
 *   CancelAfter = the deadline: past it, the advertiser is refunded, by anyone
 *
 * What goes on the ledger (memos), readable by anyone on the explorer:
 *   dareskro/case              placement
 *   dareskro/placement-sha256  SHA-256 of the contract below (the campaign id is in it)
 *   dareskro/proof             the agreed URL and text — or, before the publication
 *                              exists, only the SHA-256 of the URL (`publicUrl: false`),
 *                              so the creator and the slot are not announced on-chain
 *   dareskro/oracle            the oracle's address
 * Never on the ledger: names, handles, anything the creator did not publish.
 */
import { createHash, randomBytes } from "node:crypto";
import { platformOf } from "./presence.mjs";

export const RIPPLE_EPOCH = 946684800;
export const rippleTime = (d) => Math.floor(new Date(d).getTime() / 1000) - RIPPLE_EPOCH;
export const fromRippleTime = (t) => new Date((t + RIPPLE_EPOCH) * 1000);
export const sha256hex = (s) => createHash("sha256").update(s).digest("hex");

const XRPL_ADDRESS = /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/;
const isHttpUrl = (s) => {
  try {
    const u = new URL(s);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
};

/** ISO date, or "<n>s" / a number: that many seconds from now (for tests and demos). */
export function toDate(v, now = Date.now()) {
  if (v instanceof Date) return v;
  if (typeof v === "number") return new Date(now + v * 1000);
  if (typeof v === "string" && /^\d+s$/.test(v)) return new Date(now + Number(v.slice(0, -1)) * 1000);
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) throw new Error(`not a date: ${v}`);
  return d;
}

/**
 * Validate the terms and build the campaign. Throws on a bad field. `oracle` is
 * the oracle's address (part of the contract: who decides). The condition and
 * the deliveryId are added by server.mjs once the oracle has issued them.
 */
export function newCampaign(input, { oracle, now = Date.now() } = {}) {
  const errors = [];
  const advertiser = { name: String(input.advertiser?.name ?? "BottomRadar").trim(), address: String(input.advertiser?.address ?? "").trim() || null };
  const creator = { name: String(input.creator?.name ?? "").trim() || null, handle: String(input.creator?.handle ?? "").trim() || null, address: String(input.creator?.address ?? "").trim() };
  const url = String(input.url ?? "").trim();
  const mustContain = String(input.mustContain ?? "").trim();
  const amountXrp = String(input.amountXrp ?? "").trim();
  if (!creator.address || !XRPL_ADDRESS.test(creator.address)) errors.push("creator.address must be an XRPL address (r…)");
  if (advertiser.address && !XRPL_ADDRESS.test(advertiser.address)) errors.push("advertiser.address must be an XRPL address (r…)");
  if (!isHttpUrl(url)) errors.push("url must be an http(s) URL");
  if (!mustContain) errors.push("mustContain is required: the text the publication must carry (e.g. bottomradar.com)");
  if (!(Number(amountXrp) > 0)) errors.push("amountXrp must be a positive number");
  let periodEnd, deadline;
  try {
    periodEnd = toDate(input.periodEnd, now);
  } catch (e) {
    errors.push(`periodEnd: ${e.message}`);
  }
  try {
    deadline = input.deadline === undefined && periodEnd ? new Date(periodEnd.getTime() + 7 * 86400 * 1000) : toDate(input.deadline, now);
  } catch (e) {
    errors.push(`deadline: ${e.message}`);
  }
  if (periodEnd && periodEnd.getTime() <= now + 30 * 1000) errors.push("periodEnd must be in the future (at least 30 s)");
  if (periodEnd && deadline && deadline.getTime() <= periodEnd.getTime()) errors.push("deadline must be after periodEnd");
  if (errors.length) {
    const err = new Error(errors.join("; "));
    err.status = 400;
    throw err;
  }
  const id = randomBytes(5).toString("hex");
  const created = new Date(now).toISOString();
  // The contract: everything both sides agreed to, in a canonical order, hashed into the memo.
  const contract = {
    version: "dareskro/placement/1",
    id,
    advertiser,
    creator,
    publication: { url, urlSha256: sha256hex(url), platform: platformOf(url), mustContain },
    amountXrp: String(Number(amountXrp)),
    periodEnd: periodEnd.toISOString(),
    deadline: deadline.toISOString(),
    oracle: oracle ?? null,
    created,
    note: String(input.note ?? "").trim() || undefined,
  };
  const contractJson = JSON.stringify(contract);
  return {
    id,
    created,
    status: "draft",
    publicUrl: Boolean(input.publicUrl),
    contract,
    contractSha256: sha256hex(contractJson),
    // what the escrow needs, as ripple times
    finishAfter: rippleTime(periodEnd),
    cancelAfter: rippleTime(deadline),
  };
}

/** The memos of the EscrowCreate. `compact` (a real Ledger device): three memos, no proof line — the contract hash binds it. */
export function memosFor(c, { compact = false } = {}) {
  const p = c.contract.publication;
  const proof = c.publicUrl ? `url:${p.url};must:${p.mustContain}` : `url-sha256:${p.urlSha256};must:${p.mustContain}`;
  const memos = [
    { type: "dareskro/case", data: "placement" },
    { type: "dareskro/placement-sha256", data: c.contractSha256 },
    ...(compact ? [] : [{ type: "dareskro/proof", data: proof }]),
    ...(c.contract.oracle ? [{ type: "dareskro/oracle", data: c.contract.oracle }] : []),
  ];
  return memos;
}

/** What /watch needs, from a campaign the ledger now holds. */
export function watchBody(c, { owner, sequence, createHash }) {
  return {
    kind: "presence",
    deliveryId: c.deliveryId,
    owner,
    sequence,
    destination: c.contract.creator.address,
    amountXrp: c.contract.amountXrp,
    checkAfter: c.finishAfter,
    finishAfter: c.finishAfter,
    cancelAfter: c.cancelAfter,
    proof: c.proof ?? { url: c.contract.publication.url, mustContain: c.contract.publication.mustContain },
    createHash,
    campaignId: c.id,
    probeEveryS: c.probeEveryS,
  };
}

/** One word for where the campaign stands, from the campaign and the oracle's entry. */
export function statusOf(c, entry) {
  if (!c.escrow) return c.deliveryId ? "draft" : "invalid";
  if (!entry) return "locked";
  switch (entry.status) {
    case "waiting":
      return Date.now() / 1000 - RIPPLE_EPOCH < c.finishAfter ? "watching" : "deciding";
    case "finished":
      return "released";
    case "expired-refunded":
      return "refunded";
    case "gone":
      return "gone";
    default:
      return entry.status;
  }
}

export const explorerTx = (h) => `https://testnet.xrpl.org/transactions/${h}`;
export const explorerAccount = (a) => `https://testnet.xrpl.org/accounts/${a}`;
