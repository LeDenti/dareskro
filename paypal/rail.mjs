/**
 * The PayPal rail — what the ledger does on XRPL, PayPal does with three verbs.
 *
 *   XRPL escrow                     PayPal (Orders v2 + Payments v2 + Payouts)
 *   EscrowCreate (funds locked)  →  order with intent AUTHORIZE, approved by the payer:
 *                                   the AUTHORIZATION holds the amount up to 29 days
 *   EscrowFinish (release)       →  CAPTURE of the authorization, then a PAYOUT to the payee
 *   EscrowCancel (refund)        →  VOID of the authorization: the payer was never charged
 *   CancelAfter                  →  the mission's deadline, bounded by the 29-day hold
 *
 * What is different, and said plainly: on XRPL nobody holds the funds; on PayPal
 * the hold sits on the payer's funding source and the capture lands on the
 * platform's PayPal account before the payout leaves it. The code below is the
 * only thing that ever calls capture or payout, and only after the gate (gate.mjs)
 * and a named human said yes. The model (seat.mjs) has no tool that moves money.
 *
 * MODES
 *   sandbox  real calls to api-m.sandbox.paypal.com with the app's client id/secret
 *   mock     an in-memory PayPal that answers the same shapes, so the whole flow
 *            runs with no credentials (tests, CI, a first look); it is honest about
 *            being a mock: every id starts with "MOCK-".
 */
import { randomBytes } from "node:crypto";

const SANDBOX = "https://api-m.sandbox.paypal.com";
const HOLD_DAYS = 29; // PayPal: an authorization is valid 29 days (honor period 3 days)

export class PayPalRail {
  constructor({ mode = "sandbox", clientId, clientSecret, baseUrl = SANDBOX, mockApproveBase = "" } = {}) {
    this.mode = mode;
    this.baseUrl = baseUrl;
    if (mode === "mock") {
      this.mock = { orders: new Map(), auths: new Map(), captures: new Map(), payouts: new Map(), approveBase: mockApproveBase };
      return;
    }
    if (!clientId || !clientSecret) throw new Error("PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET are required in sandbox mode (or set PAYPAL_MODE=mock)");
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.tokenCache = null;
  }

  get holdDays() {
    return HOLD_DAYS;
  }

  // ---- auth (client credentials)
  async token() {
    if (this.tokenCache && this.tokenCache.expiresAt > Date.now() + 60_000) return this.tokenCache.value;
    const res = await fetch(`${this.baseUrl}/v1/oauth2/token`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${this.clientId}:${this.clientSecret}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
    });
    if (!res.ok) throw new Error(`PayPal token: ${res.status} ${await res.text()}`);
    const j = await res.json();
    this.tokenCache = { value: j.access_token, expiresAt: Date.now() + j.expires_in * 1000 };
    return j.access_token;
  }

  async call(method, path, body, extraHeaders = {}) {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${await this.token()}`,
        "Content-Type": "application/json",
        Prefer: "return=representation",
        ...extraHeaders,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = { raw: text };
    }
    if (!res.ok) {
      const err = new Error(`PayPal ${method} ${path}: ${res.status} ${json?.name ?? ""} ${json?.message ?? text}`);
      err.status = res.status;
      err.body = json;
      throw err;
    }
    return json;
  }

  // ---- the lock: an order the payer approves, intent AUTHORIZE
  async createOrder({ amount, currency, description, customId, returnUrl, cancelUrl }) {
    const value = Number(amount).toFixed(2);
    if (this.mode === "mock") {
      const id = `MOCK-ORDER-${randomBytes(4).toString("hex").toUpperCase()}`;
      this.mock.orders.set(id, { id, status: "CREATED", intent: "AUTHORIZE", amount: value, currency, customId, description });
      return { id, status: "CREATED", approveUrl: `${this.mock.approveBase}/mock/approve/${id}` };
    }
    const j = await this.call(
      "POST",
      "/v2/checkout/orders",
      {
        intent: "AUTHORIZE",
        purchase_units: [{ amount: { currency_code: currency, value }, description: description?.slice(0, 127), custom_id: customId?.slice(0, 127) }],
        payment_source: { paypal: { experience_context: { user_action: "PAY_NOW", return_url: returnUrl, cancel_url: cancelUrl, brand_name: "dareskro" } } },
      },
      { "PayPal-Request-Id": `dareskro-${customId ?? randomBytes(6).toString("hex")}` },
    );
    const approve = (j.links ?? []).find((l) => l.rel === "payer-action" || l.rel === "approve")?.href ?? null;
    return { id: j.id, status: j.status, approveUrl: approve };
  }

  async getOrder(id) {
    if (this.mode === "mock") {
      const o = this.mock.orders.get(id);
      if (!o) throw Object.assign(new Error(`mock: unknown order ${id}`), { status: 404 });
      return {
        id,
        status: o.status,
        intent: o.intent,
        purchase_units: [{ amount: { currency_code: o.currency, value: o.amount }, custom_id: o.customId, payments: o.authId ? { authorizations: [this.mock.auths.get(o.authId)] } : undefined }],
      };
    }
    return this.call("GET", `/v2/checkout/orders/${id}`);
  }

  /** mock only: what the payer does on PayPal's page */
  mockApprove(orderId) {
    const o = this.mock.orders.get(orderId);
    if (!o) throw new Error(`mock: unknown order ${orderId}`);
    if (o.status === "CREATED") o.status = "APPROVED";
    return o.status;
  }

  // ---- after approval: the hold
  async authorize(orderId) {
    if (this.mode === "mock") {
      const o = this.mock.orders.get(orderId);
      if (!o) throw Object.assign(new Error(`mock: unknown order ${orderId}`), { status: 404 });
      if (o.status !== "APPROVED") throw Object.assign(new Error(`mock: ORDER_NOT_APPROVED (${o.status})`), { status: 422 });
      const id = `MOCK-AUTH-${randomBytes(4).toString("hex").toUpperCase()}`;
      const a = { id, status: "CREATED", amount: { currency_code: o.currency, value: o.amount }, expiration_time: new Date(Date.now() + HOLD_DAYS * 86400e3).toISOString(), create_time: new Date().toISOString() };
      this.mock.auths.set(id, a);
      o.status = "COMPLETED";
      o.authId = id;
      return { authorizationId: id, status: a.status, amount: a.amount, expiresAt: a.expiration_time };
    }
    const j = await this.call("POST", `/v2/checkout/orders/${orderId}/authorize`, {}, { "PayPal-Request-Id": `dareskro-auth-${orderId}` });
    const a = j.purchase_units?.[0]?.payments?.authorizations?.[0];
    if (!a) throw new Error(`PayPal authorize: no authorization in response (${j.status})`);
    // the account that really paid, as PayPal reports it: a refund goes there, not to the address typed at the draft
    return { authorizationId: a.id, status: a.status, amount: a.amount, expiresAt: a.expiration_time, payerEmail: j.payer?.email_address };
  }

  async getAuthorization(id) {
    if (this.mode === "mock") {
      const a = this.mock.auths.get(id);
      if (!a) throw Object.assign(new Error(`mock: unknown authorization ${id}`), { status: 404 });
      return a;
    }
    return this.call("GET", `/v2/payments/authorizations/${id}`);
  }

  // ---- the release: capture to the platform, then the payout to the payee
  async capture(authorizationId, { amount, currency, note, invoiceId }) {
    const value = Number(amount).toFixed(2);
    if (this.mode === "mock") {
      const a = this.mock.auths.get(authorizationId);
      if (!a) throw Object.assign(new Error(`mock: unknown authorization`), { status: 404 });
      if (a.status === "VOIDED") throw Object.assign(new Error("mock: AUTHORIZATION_VOIDED"), { status: 422 });
      if (a.status === "CAPTURED") throw Object.assign(new Error("mock: AUTHORIZATION_ALREADY_CAPTURED"), { status: 422 });
      if (new Date(a.expiration_time) < new Date()) throw Object.assign(new Error("mock: AUTHORIZATION_EXPIRED"), { status: 422 });
      if (Number(value) > Number(a.amount.value) || a.amount.currency_code !== currency) throw Object.assign(new Error(`mock: cannot capture ${value} ${currency} on a hold of ${a.amount.value} ${a.amount.currency_code}`), { status: 422 });
      const id = `MOCK-CAP-${randomBytes(4).toString("hex").toUpperCase()}`;
      const c = { id, status: "COMPLETED", amount: { currency_code: currency, value }, invoice_id: invoiceId, create_time: new Date().toISOString() };
      this.mock.captures.set(id, c);
      a.status = "CAPTURED"; // final_capture: the rest of the hold is released to the payer
      a.captured = { value, released: (Number(a.amount.value) - Number(value)).toFixed(2) };
      return { captureId: id, status: c.status, captured: value, releasedToPayer: a.captured.released };
    }
    const j = await this.call(
      "POST",
      `/v2/payments/authorizations/${authorizationId}/capture`,
      { amount: { currency_code: currency, value }, final_capture: true, note_to_payer: note?.slice(0, 255), invoice_id: invoiceId },
      { "PayPal-Request-Id": `dareskro-cap-${authorizationId}` },
    );
    return { captureId: j.id, status: j.status, captured: j.amount?.value, releasedToPayer: (Number((await this.getAuthorization(authorizationId)).amount?.value ?? value) - Number(value)).toFixed(2) };
  }

  /** An order with intent CAPTURE (the invoice advance's repayment): charged at once when the payer approves. */
  async createCaptureOrder({ amount, currency, description, customId, returnUrl, cancelUrl }) {
    const value = Number(amount).toFixed(2);
    if (this.mode === "mock") {
      const id = `MOCK-ORDER-${randomBytes(4).toString("hex").toUpperCase()}`;
      this.mock.orders.set(id, { id, status: "CREATED", intent: "CAPTURE", amount: value, currency, customId, description });
      return { id, status: "CREATED", approveUrl: `${this.mock.approveBase}/mock/approve/${id}` };
    }
    const j = await this.call("POST", "/v2/checkout/orders", {
      intent: "CAPTURE",
      purchase_units: [{ amount: { currency_code: currency, value }, description: description?.slice(0, 127), custom_id: customId?.slice(0, 127) }],
      payment_source: { paypal: { experience_context: { user_action: "PAY_NOW", return_url: returnUrl, cancel_url: cancelUrl, brand_name: "dareskro" } } },
    }, { "PayPal-Request-Id": `dareskro-${customId ?? randomBytes(6).toString("hex")}` });
    return { id: j.id, status: j.status, approveUrl: (j.links ?? []).find((l) => l.rel === "payer-action" || l.rel === "approve")?.href ?? null };
  }

  async captureOrder(orderId) {
    if (this.mode === "mock") {
      const o = this.mock.orders.get(orderId);
      if (!o) throw Object.assign(new Error(`mock: unknown order ${orderId}`), { status: 404 });
      if (o.status !== "APPROVED") throw Object.assign(new Error(`mock: ORDER_NOT_APPROVED (${o.status})`), { status: 422 });
      const id = `MOCK-CAP-${randomBytes(4).toString("hex").toUpperCase()}`;
      this.mock.captures.set(id, { id, status: "COMPLETED", amount: { currency_code: o.currency, value: o.amount } });
      o.status = "COMPLETED";
      o.captureId = id;
      return { captureId: id, status: "COMPLETED", amount: { currency_code: o.currency, value: o.amount } };
    }
    const j = await this.call("POST", `/v2/checkout/orders/${orderId}/capture`, {}, { "PayPal-Request-Id": `dareskro-capo-${orderId}` });
    const c = j.purchase_units?.[0]?.payments?.captures?.[0];
    if (!c) throw new Error(`PayPal capture order: no capture in response (${j.status})`);
    return { captureId: c.id, status: c.status, amount: c.amount, payerEmail: j.payer?.email_address };
  }

  async void(authorizationId) {
    if (this.mode === "mock") {
      const a = this.mock.auths.get(authorizationId);
      if (!a) throw Object.assign(new Error(`mock: unknown authorization`), { status: 404 });
      if (a.status === "CAPTURED") throw Object.assign(new Error("mock: AUTHORIZATION_ALREADY_CAPTURED"), { status: 422 });
      if (a.status === "VOIDED") throw Object.assign(new Error("mock: AUTHORIZATION_ALREADY_VOIDED"), { status: 422 });
      a.status = "VOIDED";
      return { status: "VOIDED" };
    }
    await this.call("POST", `/v2/payments/authorizations/${authorizationId}/void`, undefined);
    return { status: "VOIDED" };
  }

  async payout({ items, currency, subject, note, batchId }) {
    const list = items.map((it, i) => ({ recipient_type: "EMAIL", receiver: it.email, amount: { value: Number(it.amount).toFixed(2), currency }, note: (it.label ?? note ?? "dareskro").slice(0, 4000), sender_item_id: `${batchId}-${i}` }));
    if (this.mode === "mock") {
      const id = `MOCK-PAYOUT-${randomBytes(4).toString("hex").toUpperCase()}`;
      this.mock.payouts.set(id, { batch_header: { payout_batch_id: id, batch_status: "SUCCESS" }, items: list });
      return { batchId: id, status: "SUCCESS", items: list.map((it) => ({ receiver: it.receiver, amount: it.amount.value, label: it.note })) };
    }
    const j = await this.call("POST", "/v1/payments/payouts", { sender_batch_header: { sender_batch_id: batchId, email_subject: subject ?? "dareskro: a payment was released", email_message: note }, items: list });
    return { batchId: j.batch_header?.payout_batch_id, status: j.batch_header?.batch_status, items: list.map((it) => ({ receiver: it.receiver, amount: it.amount.value, label: it.note })) };
  }

  async getPayout(batchId) {
    if (this.mode === "mock") return this.mock.payouts.get(batchId);
    return this.call("GET", `/v1/payments/payouts/${batchId}`);
  }
}

export function railFromEnv(env = process.env, { mockApproveBase } = {}) {
  const mode = env.PAYPAL_MODE === "mock" ? "mock" : "sandbox";
  return new PayPalRail({ mode, clientId: env.PAYPAL_CLIENT_ID, clientSecret: env.PAYPAL_CLIENT_SECRET, mockApproveBase });
}
