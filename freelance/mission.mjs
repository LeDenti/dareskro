/**
 * The mission: what a client and a freelancer agree on before any money moves,
 * and what the ledger then enforces.
 *
 * A mission is one or more MILESTONES. Each milestone becomes one escrow on the
 * XRP Ledger: Amount to the freelancer's address, a PREIMAGE-SHA-256 Condition
 * whose secret the oracle holds, and a CancelAfter = the milestone's deadline.
 * Two outcomes, and only two: the oracle reveals the secret and the freelancer
 * is paid, or the deadline passes and the client is refunded by the ledger.
 *
 * TWO MODES OF PROOF, each honest about who decides:
 *
 *   "hash"       The deliverable is known at the order: the client and the
 *                freelancer agree on a URL and the SHA-256 of the exact file.
 *                The oracle reads the URL by itself and reveals the secret when
 *                the published file has the agreed hash. Nobody decides: a fact
 *                does. The client cannot refuse a conforming file; the
 *                freelancer cannot be paid for another one. Dispute: none
 *                possible on the fact; if the freelancer publishes nothing
 *                matching before the deadline, the ledger refunds the client.
 *
 *   "acceptance" The deliverable is not known in advance (a logo, a text, a
 *                design). The CLIENT decides: it signs an acceptance on the
 *                ledger — a transaction from its own account naming the escrow
 *                — and the oracle, having verified that signature, reveals the
 *                secret. The freelancer's protection is the lock itself: the
 *                money left the client's balance at the order and the client
 *                cannot take it back before the deadline; its exposure is the
 *                client's silence, which the ledger settles as a REFUND at the
 *                deadline. There is no arbiter and we do not pretend otherwise:
 *                a client who receives the work and does not sign keeps its
 *                money after the deadline, and the freelancer keeps the proof
 *                that the money was locked, the delivery was made (if public),
 *                and the client did not sign. That is a smaller dispute than
 *                today's "the invoice is unpaid", not a solved one.
 *
 * WHAT THE FREELANCER NEEDS: an XRPL address. No account here, no password.
 * The share link shows what to deliver, where, before when, the escrow on
 * the explorer, and what the address will receive.
 */
import { randomBytes } from "node:crypto";

export const RIPPLE_EPOCH = 946684800;
export const rippleTime = (date) => Math.floor(new Date(date).getTime() / 1000) - RIPPLE_EPOCH;
export const fromRippleTime = (t) => new Date((t + RIPPLE_EPOCH) * 1000);

export const ADDRESS = /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/;
export const HEX64 = /^[0-9a-fA-F]{64}$/;

export const PROOF_MODES = {
  hash: {
    label: "Agreed file hash",
    oracleKind: "delivery",
    whoDecides: "a fact: the file at the agreed URL has the agreed SHA-256; the oracle only reads it",
    dispute: "none possible on the fact. Nothing matching published before the deadline: the ledger refunds the client.",
    needs: "the URL where the file will be published and the SHA-256 of the exact file, both agreed at the order",
  },
  acceptance: {
    label: "Client's signed acceptance",
    oracleKind: "acceptance",
    whoDecides: "the client, by signing an acceptance on the ledger from the account that locked the money",
    dispute: "no arbiter. The client cannot take the money back before the deadline; the client's silence past the deadline is a refund. The freelancer keeps the on-chain proof of the lock and of the silence.",
    needs: "nothing but the deadline; optionally where the delivery will be made",
  },
};

/** Escrow memos the client reads on its signer before locking, and anyone reads on the explorer after. Never the deliverable itself. */
export function memosFor(mission, milestone, oracleAddress) {
  const proof = milestone.proof.mode === "hash"
    ? `sha256:${milestone.proof.sha256};url:${milestone.proof.url}`
    : `acceptance-by:${mission.client}${milestone.proof.url ? `;url:${milestone.proof.url}` : ""}`;
  return [
    { type: "dareskro/case", data: "freelance" },
    { type: "dareskro/mission", data: `${mission.id}/${milestone.id}` },
    { type: "dareskro/proof", data: proof },
    ...(milestone.fiat ? [{ type: "dareskro/fiat", data: `${milestone.fiat.amount} ${milestone.fiat.currency} @ ${milestone.fiat.rate} ${milestone.fiat.source}` }] : []),
    ...(oracleAddress ? [{ type: "dareskro/oracle", data: oracleAddress }] : []),
  ];
}

const id = (n) => randomBytes(n).toString("hex");

function bad(msg) {
  const e = new Error(msg);
  e.status = 400;
  return e;
}

/** Validate one milestone as typed on the screen; returns the stored shape. */
export function newMilestone(input, i, { now = Date.now(), minDeadlineS = 60 } = {}) {
  const title = String(input.title ?? "").trim() || (i === 0 ? "Delivery" : `Milestone ${i + 1}`);
  const amount = Number(input.amountXrp);
  if (!(amount > 0) || !/^\d+(\.\d{1,6})?$/.test(String(input.amountXrp).trim())) throw bad(`milestone ${i + 1}: amount must be a positive number of XRP (6 decimals at most)`);
  const deadline = new Date(input.deadline);
  if (Number.isNaN(deadline.getTime())) throw bad(`milestone ${i + 1}: deadline must be a date`);
  if (deadline.getTime() < now + minDeadlineS * 1000) throw bad(`milestone ${i + 1}: deadline must be at least ${minDeadlineS} s from now`);
  const mode = input.proof?.mode ?? input.proofMode ?? "hash";
  if (!PROOF_MODES[mode]) throw bad(`milestone ${i + 1}: proof mode must be hash or acceptance`);
  const url = String(input.proof?.url ?? input.url ?? "").trim();
  const sha256 = String(input.proof?.sha256 ?? input.sha256 ?? "").trim().toLowerCase();
  let proof;
  if (mode === "hash") {
    let u;
    try { u = new URL(url); } catch { throw bad(`milestone ${i + 1}: the proof URL must be a full http(s) URL`); }
    if (u.protocol !== "http:" && u.protocol !== "https:") throw bad(`milestone ${i + 1}: the proof URL must be http or https`);
    if (!HEX64.test(sha256)) throw bad(`milestone ${i + 1}: the agreed SHA-256 must be 64 hex characters`);
    proof = { mode, url, sha256 };
  } else {
    if (url) {
      try { new URL(url); } catch { throw bad(`milestone ${i + 1}: the delivery URL must be a full URL or empty`); }
    }
    proof = url ? { mode, url } : { mode };
  }
  return {
    id: id(3),
    title,
    description: String(input.description ?? "").trim(),
    amountXrp: String(input.amountXrp).trim(),
    deadline: deadline.toISOString(),
    cancelAfter: rippleTime(deadline),
    proof,
    status: "draft",
  };
}

/** A mission as typed on the client's screen → the stored record. Throws 400-errors with a sentence. */
export function newMission(input, opts = {}) {
  const title = String(input.title ?? "").trim();
  if (!title) throw bad("the mission needs a title");
  const client = String(input.client ?? "").trim();
  const freelancer = String(input.freelancer ?? "").trim();
  if (!ADDRESS.test(client)) throw bad("the client's XRPL address is not valid (r…)");
  if (!ADDRESS.test(freelancer)) throw bad("the freelancer's XRPL address is not valid (r…)");
  if (client === freelancer) throw bad("client and freelancer cannot be the same address");
  // flat fields = one milestone; its title is "Delivery", the mission keeps the title and description
  const raw = Array.isArray(input.milestones) && input.milestones.length ? input.milestones : [{ ...input, title: input.milestoneTitle, description: input.deliverable }];
  if (raw.length > 12) throw bad("twelve milestones at most");
  const milestones = raw.map((m, i) => newMilestone(m, i, opts));
  return {
    id: id(6),
    shareToken: id(16),
    createdAt: new Date().toISOString(),
    title,
    description: String(input.description ?? "").trim(),
    client,
    freelancer,
    clientLabel: String(input.clientLabel ?? "").trim(),
    freelancerLabel: String(input.freelancerLabel ?? "").trim(),
    milestones,
  };
}

/** Total locked across milestones, as a string of XRP. */
export const totalXrp = (m) => (m.milestones.reduce((s, x) => s + Math.round(Number(x.amountXrp) * 1e6), 0) / 1e6).toString();

/**
 * Milestone status, from the mission's own record and the oracle's registry entry:
 *   draft → prepared (condition issued, tx built) → locked (on the ledger, oracle watching)
 *   → paid (EscrowFinish validated) | refunded (EscrowCancel after the deadline)
 *   → failed (the oracle gave up: anyone can still cancel after the deadline) | gone (someone else finished or cancelled)
 * plus, while locked: delivered? (hash mode: the oracle's last word) / accepted? (acceptance mode).
 */
export function milestoneView(ms, watched) {
  const v = { ...ms };
  if (watched) {
    v.oracle = {
      status: watched.status,
      checks: watched.checks,
      lastWhy: watched.lastWhy,
      lastCheck: watched.lastCheck,
      finishHash: watched.finishHash,
      refundHash: watched.refundHash,
      accepted: watched.accepted,
      acceptHash: watched.acceptHash,
      attempts: watched.attempts,
      lastResult: watched.lastResult,
      note: watched.note,
      registered: watched.registered,
    };
    if (watched.status === "finished") v.status = "paid";
    else if (watched.status === "expired-refunded") v.status = "refunded";
    else if (watched.status === "failed") v.status = "failed";
    else if (watched.status === "gone") v.status = "gone";
    else if (ms.status === "locked") v.status = "locked";
  }
  return v;
}

/** What the freelancer's share link shows: everything the freelancer needs, nothing about the client's desk. */
export function freelancerView(mission, views) {
  return {
    id: mission.id,
    title: mission.title,
    description: mission.description,
    client: mission.client,
    clientLabel: mission.clientLabel,
    freelancer: mission.freelancer,
    createdAt: mission.createdAt,
    milestones: views.map((v) => ({
      id: v.id, title: v.title, description: v.description, amountXrp: v.amountXrp, fiat: v.fiat,
      deadline: v.deadline, proof: v.proof, status: v.status, escrow: v.escrow, oracle: v.oracle,
      // what the ledger holds now, and what the oracle saw: the freelancer's two reasons to trust the page
      ledger: v.ledger, journal: v.journal,
    })),
  };
}
