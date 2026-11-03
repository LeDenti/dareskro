/**
 * The shapes — every form dareskro measured on XRPL, Solana and NEAR, written for PayPal.
 *
 * One table per kind. The service (service.mjs) is generic: it creates the orders, keeps the
 * registry and calls PayPal; what differs from one shape to the next is here, as plain
 * functions of the mission record and of what PayPal answered:
 *
 *   draft(p)        what the payer agrees to: the fields and their checks → { errors, fields }
 *   lockedWhen(m)   when the mission is "locked": every hold on file (and, for a pool, the target reached)
 *   release(m, now) the gate: reasons[] (all must hold) and, if they do, what to capture and what to pay
 *   voidable(m,now) the gate for the refund: reasons[]
 *
 *   kind       on XRPL / NEAR it was…                       on PayPal
 *   payroll    EscrowCreate FinishAfter only; one Batch      one hold by the employer; at the date anyone
 *              = net + URSSAF Check + DGFiP escrow           releases: one capture, ONE payout batch of 3 items
 *   delivery   Condition + CancelAfter, hash of the file     hold; the AI reads, the code hashes, a human
 *                                                            validates; capture + payout — or void
 *   presence   Condition + FinishAfter + CancelAfter         hold; at the date the desk reads the page; live →
 *              (post live at the date)                       capture + payout; not live → void
 *   affiliate  merchant confirms with a token given once     hold; the merchant's token releases; the capture
 *                                                            carries the order hash
 *   pool       NEAR pool_create / pool_fund (≤ 16 payers)    one hold per payer; locked when the target is
 *              surplus trimmed in the filling call           reached; the filling hold is captured PARTIALLY
 *                                                            (final_capture releases the surplus); one payout
 *   vault      NEAR vault 2-of-3 / XRPL 2-of-3 signer list   the owner's hold; each party votes an amount to
 *              (rental deposit, returned in part)            the beneficiary; the vote that reaches the threshold
 *                                                            captures THAT amount, the rest goes back to the
 *                                                            owner; past the deadline anyone voids everything
 *   advance    XRPL pool 2-of-3 (AI, risk policy, operator)  three seats sign: AI memo, deterministic policy,
 *              the invoice advance                           human; 2 of 3 pay the supplier from the platform's
 *                                                            balance (a payout); the debtor repays by an order
 *                                                            with intent CAPTURE at the due date
 *
 * The honest line on every kind: PayPal's hold lasts 29 days. A deposit on a lease outlives it;
 * such a vault runs in CUSTODY (captured at lock, held on the platform's PayPal account, paid
 * out at the decision) and the record says so — a different trust than the ledger's.
 */

const isEmail = (s) => /^[^@\s]+@[^@\s]+$/.test(s ?? "");
const isMoney = (n) => Number(n) > 0 && Math.round(Number(n) * 100) === Number(n) * 100;
const isoFuture = (s) => Number.isFinite(Date.parse(s ?? "")) && Date.parse(s) > Date.now();
const money = (n) => Number(n).toFixed(2);
const reason = (check, ok, why) => ({ check, ok, why });

/** Common draft fields: title, currency, deadlineAt (the hold's CancelAfter), fee. */
function common(p) {
  const errors = [];
  if (!p.title || String(p.title).length < 3) errors.push("title (3+ chars)");
  if (!/^[A-Z]{3}$/.test(p.currency ?? "")) errors.push("currency: ISO code (USD, EUR…)");
  if (!isoFuture(p.deadlineAt)) errors.push("deadlineAt: ISO date in the future, after which the hold is voided");
  return { errors, fields: { title: p.title, currency: p.currency, deadlineAt: new Date(p.deadlineAt ?? 0).toISOString() } };
}
function onePayer(p, who = "client") {
  const errors = [];
  if (!isMoney(p.amount)) errors.push("amount: a positive number with at most 2 decimals");
  const payer = { name: p[who]?.name ?? who, email: p[who]?.email ?? null, amount: Number(p.amount) };
  return { errors, payers: [payer] };
}
function payees(list, errors, field = "payees") {
  if (!Array.isArray(list) || !list.length) {
    errors.push(`${field}: a non-empty list of { label, email, amount }`);
    return [];
  }
  return list.map((x, i) => {
    if (!isEmail(x.email)) errors.push(`${field}[${i}].email`);
    if (!isMoney(x.amount)) errors.push(`${field}[${i}].amount`);
    return { label: x.label ?? `payee ${i + 1}`, email: x.email, amount: Number(x.amount) };
  });
}
const sum = (xs, f = (x) => x.amount) => Math.round(xs.reduce((a, x) => a + Number(f(x)), 0) * 100) / 100;

/** Reasons every kind shares at release: before the deadline, every hold open and matching. */
function holdsOpen(m, holds) {
  return m.payers.map((p, i) => {
    const a = holds[i];
    if (!a) return reason(`hold of ${p.name}`, false, "no authorization on file");
    if (a.status !== "CREATED") return reason(`hold of ${p.name}`, false, `authorization ${a.id} is ${a.status}`);
    const need = p.trimmedTo ?? p.amount; // a pool's filling share is trimmed to what was missing
    if (a.amount?.currency_code !== m.currency || Number(a.amount?.value) < need) return reason(`hold of ${p.name}`, false, `holds ${a.amount?.value} ${a.amount?.currency_code}, mission needs ${money(need)} ${m.currency}`);
    if (Date.parse(a.expiration_time) < Date.now()) return reason(`hold of ${p.name}`, false, `expired ${a.expiration_time}`);
    return reason(`hold of ${p.name}`, true, `${a.amount.value} ${a.amount.currency_code} held (${a.id}) until ${a.expiration_time}`);
  });
}
const beforeDeadline = (m, now) => reason("before deadline", Date.parse(m.deadlineAt) > now, `deadline ${m.deadlineAt}`);
const notClosed = (m) => reason("not closed", !["released", "refused", "expired"].includes(m.state), `mission is ${m.state}`);
const pastDeadlineOrRefused = (m, now) => {
  const past = Date.parse(m.deadlineAt) <= now;
  const refused = m.validation?.decision === "refuse";
  return reason("deadline passed or refused", past || refused, past ? `deadline ${m.deadlineAt} has passed` : refused ? `${m.validation.by} refused at ${m.validation.at}` : `deadline ${m.deadlineAt} not reached and nobody refused`);
};
const anyHoldOpen = (holds) => reason("a hold is open", holds.some((a) => a?.status === "CREATED"), holds.map((a) => a?.status ?? "none").join(", "));
/** Full captures, one per payer, then the payees get what the draft says. */
const fullCaptures = (m) => m.payers.map((p, i) => ({ payer: i, amount: p.amount }));
const memoOk = (m) => reason("memo on file", !!m.memo?.sha256, m.memo ? `memo ${m.memo.sha256.slice(0, 12)}… recommends ${m.memo.recommendation}` : "no memo");
const humanSaid = (m, what = "release") => reason("human decision", m.validation?.decision === what, m.validation ? `${m.validation.by} decided ${m.validation.decision} at ${m.validation.at}` : "no human validation");

export const KINDS = {
  // ---- 1. payroll: the date decides; one approval, three payouts
  payroll: {
    label: "Payroll — paid at the date, one approval, three payouts",
    draft(p) {
      const { errors, fields } = common(p);
      const { errors: e2, payers } = onePayer(p, "employer");
      errors.push(...e2);
      const list = payees(p.payees, errors);
      if (list.length && sum(list) !== Number(p.amount)) errors.push(`payees sum to ${money(sum(list))}, amount is ${money(p.amount)}`);
      if (!isoFuture(p.finishAfter)) errors.push("finishAfter: ISO date, the pay date");
      else if (Date.parse(p.finishAfter) > Date.parse(p.deadlineAt)) errors.push("finishAfter must be before deadlineAt");
      if (!p.statement?.sha256 || !/^[0-9a-f]{64}$/i.test(p.statement.sha256)) errors.push("statement.sha256: the validated statement's hash (64 hex)");
      if (!p.validatedBy) errors.push("validatedBy: the named human who validated the statement before the lock (GDPR art. 22)");
      return { errors, fields: { ...fields, payers, payees: list, finishAfter: p.finishAfter ? new Date(p.finishAfter).toISOString() : null, statement: { sha256: p.statement?.sha256?.toLowerCase(), id: p.statement?.id ?? null }, validation: { by: p.validatedBy, decision: "release", at: new Date().toISOString(), what: "the statement, before the lock" } } };
    },
    lockedWhen: (m) => m.payers.every((p) => p.authorizationId),
    release(m, holds, now) {
      const reasons = [notClosed(m), reason("pay date reached", Date.parse(m.finishAfter) <= now, `finishAfter ${m.finishAfter}`), beforeDeadline(m, now), ...holdsOpen(m, holds)];
      return { reasons, captures: fullCaptures(m), payouts: m.payees, note: `statement ${m.statement.sha256.slice(0, 12)}, validated by ${m.validation.by}` };
    },
    voidable: (m, holds, now) => [notClosed(m), reason("deadline passed", Date.parse(m.deadlineAt) <= now, `deadline ${m.deadlineAt}`), anyHoldOpen(holds)],
  },

  // ---- 2. delivery: the AI reads, the code hashes, a human validates
  delivery: {
    label: "Delivery — the AI reads, a human validates, PayPal pays",
    draft(p) {
      const { errors, fields } = common(p);
      const { errors: e2, payers } = onePayer(p, "client");
      errors.push(...e2);
      if (!p.brief || String(p.brief).length < 20) errors.push("brief (20+ chars): what must be delivered");
      if (!Array.isArray(p.criteria) || !p.criteria.length || p.criteria.some((c) => typeof c !== "string" || !c.trim())) errors.push("criteria: a non-empty list of acceptance criteria");
      if (!isEmail(p.freelancer?.email)) errors.push("freelancer.email: the PayPal account that receives the payout");
      if (p.expectedSha256 !== undefined && !/^[0-9a-f]{64}$/i.test(p.expectedSha256)) errors.push("expectedSha256: 64 hex if given");
      return { errors, fields: { ...fields, payers, brief: p.brief, criteria: p.criteria, expectedSha256: p.expectedSha256?.toLowerCase() ?? null, payees: [{ label: p.freelancer.name ?? "the freelancer", email: p.freelancer.email, amount: Number(p.amount) }] } };
    },
    lockedWhen: (m) => m.payers.every((p) => p.authorizationId),
    needs: { deliver: true, review: true, validate: true },
    release(m, holds, now) {
      const reasons = [notClosed(m), reason("state", m.state === "validated", `mission is ${m.state}`), humanSaid(m), memoOk(m), beforeDeadline(m, now), ...holdsOpen(m, holds)];
      return { reasons, captures: fullCaptures(m), payouts: m.payees, note: `memo ${m.memo?.sha256?.slice(0, 12)}, validated by ${m.validation?.by}` };
    },
    voidable: (m, holds, now) => [notClosed(m), pastDeadlineOrRefused(m, now), anyHoldOpen(holds)],
  },

  // ---- 3. presence: the post must be live at the date
  presence: {
    label: "Presence — the post must still be there at the date",
    draft(p) {
      const { errors, fields } = common(p);
      const { errors: e2, payers } = onePayer(p, "brand");
      errors.push(...e2);
      if (!p.proof?.url || !/^https?:\/\//.test(p.proof.url)) errors.push("proof.url: the post's public address");
      if (!isoFuture(p.checkAfter)) errors.push("checkAfter: ISO date, when the desk reads the page");
      else if (Date.parse(p.checkAfter) > Date.parse(p.deadlineAt)) errors.push("checkAfter must be before deadlineAt");
      if (!isEmail(p.creator?.email)) errors.push("creator.email");
      return { errors, fields: { ...fields, payers, proof: { url: p.proof.url, mustContain: p.proof.mustContain ? String(p.proof.mustContain) : null }, checkAfter: new Date(p.checkAfter).toISOString(), payees: [{ label: p.creator.name ?? "the creator", email: p.creator.email, amount: Number(p.amount) }] } };
    },
    lockedWhen: (m) => m.payers.every((p) => p.authorizationId),
    needs: { probe: true },
    release(m, holds, now) {
      const seen = m.lastSeen;
      const reasons = [notClosed(m), reason("check date reached", Date.parse(m.checkAfter) <= now, `checkAfter ${m.checkAfter}`), reason("post live at the decision", !!seen?.decision && seen.ok, seen ? `${seen.at}: ${seen.why}` : "not read yet"), beforeDeadline(m, now), ...holdsOpen(m, holds)];
      return { reasons, captures: fullCaptures(m), payouts: m.payees, note: `post ${m.proof.url} live at ${seen?.at}, sha256 ${seen?.sha256?.slice(0, 12) ?? "-"}` };
    },
    voidable(m, holds, now) {
      const seen = m.lastSeen;
      const gone = !!seen?.decision && !seen.ok && Date.parse(m.checkAfter) <= now;
      return [notClosed(m), reason("deadline passed, or post not live at the decision", Date.parse(m.deadlineAt) <= now || gone, gone ? `${seen.at}: ${seen.why}` : `deadline ${m.deadlineAt}`), anyHoldOpen(holds)];
    },
  },

  // ---- 4. affiliate: the merchant's system confirms the sale
  affiliate: {
    label: "Affiliate — the merchant confirms the sale with a token given once",
    draft(p) {
      const { errors, fields } = common(p);
      const { errors: e2, payers } = onePayer(p, "merchant");
      errors.push(...e2);
      if (!isEmail(p.affiliate?.email)) errors.push("affiliate.email");
      return { errors, fields: { ...fields, payers, orderRef: p.orderRef ? String(p.orderRef) : null, payees: [{ label: p.affiliate.name ?? "the affiliate", email: p.affiliate.email, amount: Number(p.amount) }] } };
    },
    lockedWhen: (m) => m.payers.every((p) => p.authorizationId),
    needs: { confirm: true },
    release(m, holds, now) {
      const reasons = [notClosed(m), reason("sale confirmed", !!m.confirmed, m.confirmed ? `order sha256 ${m.confirmed.orderHash.slice(0, 12)}… confirmed at ${m.confirmed.at}` : "waiting for the merchant's confirmation"), beforeDeadline(m, now), ...holdsOpen(m, holds)];
      return { reasons, captures: fullCaptures(m), payouts: m.payees, note: `order-sha256 ${m.confirmed?.orderHash}` };
    },
    voidable: (m, holds, now) => [notClosed(m), reason("deadline passed", Date.parse(m.deadlineAt) <= now, `deadline ${m.deadlineAt}`), anyHoldOpen(holds)],
  },

  // ---- 5. pool: several payers, one target, the filling share trimmed
  pool: {
    label: "Pool — several payers, one target, surplus returned",
    draft(p) {
      const { errors, fields } = common(p);
      if (!isMoney(p.target)) errors.push("target: a positive amount");
      if (!isEmail(p.destination?.email)) errors.push("destination.email");
      if (p.finishAfter !== undefined && !isoFuture(p.finishAfter)) errors.push("finishAfter: ISO date if given (otherwise a human decides)");
      return { errors, fields: { ...fields, target: Number(p.target), payers: [], finishAfter: p.finishAfter ? new Date(p.finishAfter).toISOString() : null, payees: [{ label: p.destination.name ?? "the destination", email: p.destination.email, amount: Number(p.target) }] } };
    },
    needs: { fund: true, validate: true },
    maxPayers: 16,
    /** a payer brings a share: trimmed to what is left of the target, as the NEAR contract does in the filling call */
    fund(m, p) {
      if (m.payers.length >= 16) return { error: "16 payers at most" };
      if (!isMoney(p.amount)) return { error: "amount" };
      const held = sum(m.payers.filter((x) => x.authorizationId || x.orderId));
      if (held >= m.target) return { error: "the pool is full" };
      return { payer: { name: p.name ?? `payer ${m.payers.length + 1}`, email: p.email ?? null, amount: Number(p.amount), trimmedTo: Math.min(Number(p.amount), Math.round((m.target - held) * 100) / 100) } };
    },
    lockedWhen: (m) => m.payers.length > 0 && m.payers.every((p) => p.authorizationId) && sum(m.payers, (p) => p.trimmedTo ?? p.amount) >= m.target,
    release(m, holds, now) {
      const funded = sum(m.payers.filter((p, i) => holds[i]?.status === "CREATED"), (p) => p.trimmedTo ?? p.amount);
      const decided = m.finishAfter ? reason("date reached", Date.parse(m.finishAfter) <= now, `finishAfter ${m.finishAfter}`) : humanSaid(m);
      const reasons = [notClosed(m), reason("target reached", funded >= m.target, `${money(funded)} of ${money(m.target)} ${m.currency} held`), decided, beforeDeadline(m, now), ...holdsOpen(m, holds)];
      // captures: each hold for its trimmed share — the last one partially; final_capture gives the surplus back
      const captures = m.payers.map((p, i) => ({ payer: i, amount: p.trimmedTo ?? p.amount }));
      return { reasons, captures, payouts: m.payees, note: `pool of ${m.payers.length} payers, target ${money(m.target)}` };
    },
    voidable: (m, holds, now) => [notClosed(m), pastDeadlineOrRefused(m, now), anyHoldOpen(holds)],
  },

  // ---- 6. vault: the deposit decided 2 of 3
  vault: {
    label: "Vault — the deposit decided 2 of 3, returned in part",
    draft(p) {
      const { errors, fields } = common(p);
      const { errors: e2, payers } = onePayer(p, "owner");
      errors.push(...e2);
      if (!isEmail(p.beneficiary?.email)) errors.push("beneficiary.email");
      if (!Array.isArray(p.parties) || p.parties.length !== 3 || p.parties.some((x) => !x || typeof x !== "string")) errors.push("parties: exactly three names (owner, beneficiary, mediator)");
      if (p.custody && !isEmail(p.owner?.email)) errors.push("owner.email: in custody the surplus is paid back by payout, so the owner's PayPal account is needed");
      return { errors, fields: { ...fields, payers, beneficiary: { name: p.beneficiary.name ?? "the beneficiary", email: p.beneficiary.email }, parties: p.parties, threshold: 2, votes: [], custody: !!p.custody, memos: Array.isArray(p.memos) ? p.memos.map(String) : [] } };
    },
    lockedWhen: (m) => m.payers.every((p) => p.authorizationId || p.captureId),
    needs: { vote: true },
    vote(m, { party, toBeneficiary }) {
      if (!m.parties.includes(party)) return { error: `unknown party ${party}; parties are ${m.parties.join(", ")}` };
      const v = Number(toBeneficiary);
      if (!(v >= 0) || v > m.payers[0].amount || Math.round(v * 100) !== v * 100) return { error: `toBeneficiary: 0 to ${money(m.payers[0].amount)}` };
      m.votes = m.votes.filter((x) => x.party !== party);
      m.votes.push({ party, toBeneficiary: v, at: new Date().toISOString() });
      const agreeing = m.votes.filter((x) => x.toBeneficiary === v);
      return { decided: agreeing.length >= m.threshold ? v : null, agreeing: agreeing.map((x) => x.party) };
    },
    decidedAmount(m) {
      for (const v of m.votes) if (m.votes.filter((x) => x.toBeneficiary === v.toBeneficiary).length >= m.threshold) return v.toBeneficiary;
      return null;
    },
    release(m, holds, now) {
      const amount = KINDS.vault.decidedAmount(m);
      const base = [notClosed(m), reason("2 of 3 agree on the amount", amount !== null, amount !== null ? `${money(amount)} ${m.currency} to ${m.beneficiary.name}, ${money(m.payers[0].amount - amount)} back to ${m.payers[0].name}` : `${m.votes.length} vote(s): ${m.votes.map((v) => `${v.party}→${money(v.toBeneficiary)}`).join(", ")}`), beforeDeadline(m, now)];
      if (m.custody) {
        // the deposit was captured at lock; the decision is a payout split
        const reasons = [...base, reason("deposit in custody", !!m.payers[0].captureId, m.payers[0].captureId ? `captured ${m.payers[0].captureId} at lock` : "not captured")];
        const payouts = [];
        if (amount > 0) payouts.push({ label: `to ${m.beneficiary.name} (decided 2 of 3)`, email: m.beneficiary.email, amount });
        if (m.payers[0].amount - amount > 0) payouts.push({ label: `back to ${m.payers[0].name}`, email: m.payers[0].email, amount: Math.round((m.payers[0].amount - amount) * 100) / 100 });
        return { reasons, captures: [], payouts, note: `deposit decided 2 of 3: ${money(amount ?? 0)} to the beneficiary` };
      }
      const reasons = [...base, ...holdsOpen(m, holds)];
      // the decided amount is captured from the owner's hold; final_capture releases the rest to the owner — nothing to pay back
      const captures = amount > 0 ? [{ payer: 0, amount }] : [];
      const payouts = amount > 0 ? [{ label: `to ${m.beneficiary.name} (decided 2 of 3)`, email: m.beneficiary.email, amount }] : [];
      return { reasons, captures, payouts, voidIfNoCapture: amount === 0, note: `deposit decided 2 of 3: ${money(amount ?? 0)} to the beneficiary, the rest released to the owner by the final capture` };
    },
    voidable(m, holds, now) {
      if (m.custody) return [notClosed(m), reason("deadline passed", Date.parse(m.deadlineAt) <= now, `deadline ${m.deadlineAt}`), reason("in custody: the refund is a payout, not a void", true, "the service pays the whole deposit back to the owner")];
      return [notClosed(m), reason("deadline passed with no decision", Date.parse(m.deadlineAt) <= now && KINDS.vault.decidedAmount(m) === null, `deadline ${m.deadlineAt}; decided: ${KINDS.vault.decidedAmount(m) ?? "no"}`), anyHoldOpen(holds)];
    },
  },

  // ---- 7. advance: the invoice advance, three seats, 2 of 3 pay
  advance: {
    label: "Invoice advance — AI, risk policy and operator; 2 of 3 pay the supplier",
    draft(p) {
      const { errors, fields } = common(p);
      if (!isMoney(p.invoiceAmount)) errors.push("invoiceAmount");
      if (!isMoney(p.amount)) errors.push("amount: the advance");
      if (!isEmail(p.supplier?.email)) errors.push("supplier.email");
      if (!p.debtor?.name) errors.push("debtor.name");
      if (!isoFuture(p.dueAt)) errors.push("dueAt: the invoice's due date");
      if (!p.invoiceUrl || !/^https?:\/\//.test(p.invoiceUrl)) errors.push("invoiceUrl: the invoice document (public URL)");
      const limits = { tauxAvanceMax: 0.9, echeanceMaxJours: 90, plafondDebiteur: 5000, ...(p.limits ?? {}) };
      return { errors, fields: { ...fields, payers: [], invoiceAmount: Number(p.invoiceAmount), advance: Number(p.amount), supplier: { name: p.supplier.name ?? "the supplier", email: p.supplier.email }, debtor: { name: p.debtor.name, email: p.debtor.email ?? null }, dueAt: new Date(p.dueAt).toISOString(), invoiceUrl: p.invoiceUrl, brief: `Invoice of ${money(p.invoiceAmount)} ${p.currency} from ${p.supplier.name ?? "the supplier"} to ${p.debtor.name}, due ${p.dueAt}; advance asked ${money(p.amount)}.`, criteria: Array.isArray(p.criteria) && p.criteria.length ? p.criteria : ["The document is an invoice naming the supplier and the debtor [contains invoice]", "It states the amount and a due date [contains due]"], limits, signatures: {}, payees: [{ label: p.supplier.name ?? "the supplier", email: p.supplier.email, amount: Number(p.amount) }] } };
    },
    lockedWhen: () => true, // no hold: the advance leaves the platform's balance
    needs: { review: true, validate: true, policy: true, repay: true },
    /** the risk policy: deterministic, no network, the same inputs always give the same answer */
    policy(m, now = Date.now()) {
      const L = m.limits;
      const r = [];
      r.push(reason("advance ≤ rate × invoice", m.advance <= m.invoiceAmount * L.tauxAvanceMax, `${money(m.advance)} vs ${money(m.invoiceAmount * L.tauxAvanceMax)} (${L.tauxAvanceMax * 100} % of ${money(m.invoiceAmount)})`));
      const days = (Date.parse(m.dueAt) - now) / 86400e3;
      r.push(reason("due within the horizon", days <= L.echeanceMaxJours && days > 0, `${days.toFixed(1)} days, limit ${L.echeanceMaxJours}`));
      r.push(reason("under the debtor's cap", m.advance <= L.plafondDebiteur, `${money(m.advance)} vs cap ${money(L.plafondDebiteur)}`));
      r.push(reason("the AI's memo exists and names this invoice", !!m.memo?.sha256 && m.memo.deliverableUrl === m.invoiceUrl, m.memo ? `memo ${m.memo.sha256.slice(0, 12)}… on ${m.memo.deliverableUrl}` : "no memo"));
      return { ok: r.every((x) => x.ok), reasons: r };
    },
    signatures(m) {
      const s = { ai: m.memo?.recommendation === "release", policy: !!m.signatures?.policy?.ok, operator: m.validation?.decision === "release" };
      return { ...s, count: Object.values(s).filter(Boolean).length };
    },
    release(m, holds, now) {
      const s = KINDS.advance.signatures(m);
      const reasons = [notClosed(m), reason("2 of 3 seats sign", s.count >= 2, `ai ${s.ai ? "✓" : "✗"}, policy ${s.policy ? "✓" : "✗"}, operator ${s.operator ? "✓" : "✗"}`), beforeDeadline(m, now), reason("memo on file", !!m.memo?.sha256, m.memo ? `memo ${m.memo.sha256.slice(0, 12)}…` : "no memo")];
      return { reasons, captures: [], payouts: m.payees, note: `advance on invoice ${m.invoiceUrl}, memo ${m.memo?.sha256?.slice(0, 12)}, seats ${s.count}/3` };
    },
    voidable: (m, holds, now) => [notClosed(m), reason("nothing to void: no hold", m.state !== "released", "an advance that was not paid is simply closed"), pastDeadlineOrRefused(m, now)],
  },
};

export const kindOf = (m) => KINDS[m.kind];
export { money, sum };
