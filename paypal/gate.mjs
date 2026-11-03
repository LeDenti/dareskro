/**
 * The gate — the rules a mission must pass before the code calls PayPal.
 *
 * The model proposes, the human validates, but neither can get the money out
 * if these facts are not true. Each check is a plain function of the mission
 * record and of what PayPal answered; the service calls them, the memo quotes
 * them, the registry keeps them. No model in this file.
 */
import { createHash } from "node:crypto";

export const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
export const HEX64 = /^[0-9a-f]{64}$/i;

export const STATES = ["drafted", "offered", "locked", "delivered", "reviewed", "validated", "released", "refused", "expired"];

/** What the client agrees to when the mission is drafted. */
export function validateDraft(p) {
  const errors = [];
  if (!p.title || String(p.title).length < 3) errors.push("title (3+ chars)");
  if (!p.brief || String(p.brief).length < 20) errors.push("brief (20+ chars): what must be delivered");
  if (!Array.isArray(p.criteria) || p.criteria.length < 1 || p.criteria.some((c) => typeof c !== "string" || !c.trim())) errors.push("criteria: a non-empty list of acceptance criteria (strings)");
  const amount = Number(p.amount);
  if (!(amount > 0) || Math.round(amount * 100) !== amount * 100) errors.push("amount: a positive number with at most 2 decimals");
  if (!/^[A-Z]{3}$/.test(p.currency ?? "")) errors.push("currency: ISO code (USD, EUR…)");
  if (!p.freelancer?.email || !/^[^@\s]+@[^@\s]+$/.test(p.freelancer.email)) errors.push("freelancer.email: the PayPal account that receives the payout");
  const deadline = Date.parse(p.deadlineAt ?? "");
  if (!Number.isFinite(deadline)) errors.push("deadlineAt: ISO date after which the hold is voided");
  else if (deadline <= Date.now()) errors.push("deadlineAt must be in the future");
  if (p.expectedSha256 !== undefined && !HEX64.test(p.expectedSha256)) errors.push("expectedSha256: 64 hex chars if given");
  return errors;
}

/** The deadline must fit inside PayPal's hold: past the authorization's expiry nobody can capture. */
export function deadlineFitsHold(deadlineAt, expiresAt) {
  const d = Date.parse(deadlineAt);
  const e = Date.parse(expiresAt);
  if (!Number.isFinite(d) || !Number.isFinite(e)) return { ok: false, why: "unreadable dates" };
  return d <= e ? { ok: true, why: `deadline ${deadlineAt} is before the hold's expiry ${expiresAt}` } : { ok: false, why: `deadline ${deadlineAt} is after the hold's expiry ${expiresAt}: shorten the mission or re-authorize` };
}

/** The authorization PayPal holds must be the mission's amount, in the mission's currency, and still open. */
export function holdMatches(mission, auth) {
  if (!auth) return { ok: false, why: "no authorization on file" };
  const value = Number(mission.amount).toFixed(2);
  if (auth.status !== "CREATED") return { ok: false, why: `authorization status is ${auth.status}, not CREATED` };
  if (auth.amount?.value !== value || auth.amount?.currency_code !== mission.currency) return { ok: false, why: `hold is ${auth.amount?.value} ${auth.amount?.currency_code}, mission is ${value} ${mission.currency}` };
  if (Date.parse(auth.expiration_time) < Date.now()) return { ok: false, why: `authorization expired at ${auth.expiration_time}` };
  return { ok: true, why: `PayPal holds ${value} ${mission.currency} (authorization ${auth.id}) until ${auth.expiration_time}` };
}

/** The deliverable: reachable, hashed, and equal to the agreed hash if one was fixed in advance. */
export function deliverableChecks(mission, fetched) {
  const out = [];
  out.push(fetched.ok ? { check: "deliverable reachable", ok: true, why: `${fetched.url} answered ${fetched.status}, ${fetched.bytes} bytes, sha256 ${fetched.sha256.slice(0, 12)}…` } : { check: "deliverable reachable", ok: false, why: `${fetched.url}: ${fetched.why}` });
  if (mission.expectedSha256) {
    const same = fetched.ok && fetched.sha256.toLowerCase() === mission.expectedSha256.toLowerCase();
    out.push({ check: "sha256 agreed in advance", ok: same, why: same ? "the file is byte-for-byte the agreed one" : `expected ${mission.expectedSha256.slice(0, 12)}…, got ${fetched.sha256?.slice(0, 12) ?? "nothing"}` });
  }
  return out;
}

/** Can the code call capture now? Every reason is listed; one false reason is a refusal. */
export function canRelease(mission, auth, now = Date.now()) {
  const reasons = [];
  reasons.push({ check: "state", ok: mission.state === "validated", why: `mission is ${mission.state}` });
  reasons.push({ check: "human decision", ok: mission.validation?.decision === "release", why: mission.validation ? `${mission.validation.by} decided ${mission.validation.decision} at ${mission.validation.at}` : "no human validation" });
  reasons.push({ check: "memo on file", ok: !!mission.memo?.sha256, why: mission.memo ? `memo ${mission.memo.sha256.slice(0, 12)}… recommends ${mission.memo.recommendation}` : "no memo" });
  reasons.push({ check: "before deadline", ok: Date.parse(mission.deadlineAt) > now, why: `deadline ${mission.deadlineAt}` });
  const h = holdMatches(mission, auth);
  reasons.push({ check: "hold matches", ok: h.ok, why: h.why });
  return { ok: reasons.every((r) => r.ok), reasons };
}

/** Can the code call void now? Past the deadline, or after a refusal — never after a capture. */
export function canVoid(mission, auth, now = Date.now()) {
  const reasons = [];
  const pastDeadline = Date.parse(mission.deadlineAt) <= now;
  const refused = mission.validation?.decision === "refuse";
  reasons.push({ check: "deadline passed or human refused", ok: pastDeadline || refused, why: pastDeadline ? `deadline ${mission.deadlineAt} has passed` : refused ? `${mission.validation.by} refused at ${mission.validation.at}` : `deadline ${mission.deadlineAt} not reached and nobody refused` });
  reasons.push({ check: "not released", ok: !["released"].includes(mission.state), why: `mission is ${mission.state}` });
  reasons.push({ check: "authorization open", ok: auth?.status === "CREATED", why: auth ? `authorization is ${auth.status}` : "no authorization" });
  return { ok: reasons.every((r) => r.ok), reasons };
}
