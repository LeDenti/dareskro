/**
 * The AI seat — the first place in dareskro where a language model sits.
 *
 * Its job, and its limits, in one line each:
 *   - it READS: the brief and its acceptance criteria, the deliverable (fetched
 *     and hashed by code before it looks), and what PayPal says about the order
 *     and the hold — through PayPal's own Agent Toolkit, read-only tools;
 *   - it WRITES a memo: evidence listed with its source, one verdict per
 *     criterion with the quote that supports it, a recommendation (release,
 *     hold, refuse) and what it could not verify;
 *   - it has NO tool that moves money. Capture, void and payout live in rail.mjs
 *     and are called by service.mjs after the gate and a named human.
 *
 * The memo is hashed (sha256) and kept in sortie/memos/<mission>.json before the
 * human sees it, so what the human validated is what the registry keeps.
 *
 * Model: Claude (claude-opus-5-5) through the official Anthropic SDK's tool runner,
 * with a JSON schema on the final answer. SEAT_MODE=mock produces the same memo
 * shape from the gate's facts alone (no model), for tests and for runs without a key.
 */
import { readFileSync } from "node:fs";
import { sha256, deliverableChecks } from "./gate.mjs";

export const MEMO_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "evidence", "criteria", "recommendation", "unverified", "model"],
  properties: {
    summary: { type: "string", description: "Three sentences at most: what was delivered, against what, and the verdict." },
    evidence: {
      type: "array",
      description: "Every fact used, with where it was read.",
      items: { type: "object", additionalProperties: false, required: ["fact", "source"], properties: { fact: { type: "string" }, source: { type: "string", description: "deliverable | paypal:get_order | paypal:list_transactions | brief" } } },
    },
    criteria: {
      type: "array",
      description: "One entry per acceptance criterion of the brief, in order.",
      items: { type: "object", additionalProperties: false, required: ["criterion", "met", "why"], properties: { criterion: { type: "string" }, met: { type: "boolean" }, why: { type: "string", description: "The quote or measurement from the deliverable that decides it." } } },
    },
    recommendation: { type: "string", enum: ["release", "hold", "refuse"], description: "release: every criterion met; hold: fixable gap, ask the freelancer; refuse: the deliverable is not what was agreed." },
    unverified: { type: "array", items: { type: "string" }, description: "What the seat could not check and says so." },
    model: { type: "string" },
  },
};

const SYSTEM = `You are the reading seat of dareskro, a payment desk where a client's money is held by PayPal
until a freelancer's deliverable is accepted. You read; you do not pay. Your memo will be hashed and shown
to a named human who decides. Rules:
- Judge ONLY against the brief's acceptance criteria, one by one, and quote the deliverable for each.
- Use the PayPal tools to confirm what is actually held for this mission (order id given), and report the
  amount, currency and status you read, as evidence with source "paypal:get_order".
- Never infer a fact you did not read. What you could not verify goes in "unverified".
- "release" only if every criterion is met. "hold" if a gap looks fixable. "refuse" if the deliverable is
  off-brief or missing.
- Answer with the memo JSON only.`;

/** The toolkit's read-only tools, adapted from its OpenAI binding to the Anthropic SDK's tool runner. */
async function paypalReadTools(env) {
  const { PayPalAgentToolkit } = await import("@paypal/agent-toolkit/openai");
  const { betaTool } = await import("@anthropic-ai/sdk/helpers/beta/json-schema");
  const toolkit = new PayPalAgentToolkit({
    clientId: env.PAYPAL_CLIENT_ID,
    clientSecret: env.PAYPAL_CLIENT_SECRET,
    configuration: { actions: { orders: { get: true }, transactions: { list: true } }, context: { sandbox: true } },
  });
  return toolkit.getTools().map((t) =>
    betaTool({
      name: t.function.name,
      description: t.function.description ?? t.function.name,
      inputSchema: t.function.parameters ?? { type: "object", properties: {} },
      run: async (args) => {
        const r = await toolkit.handleToolCall({ id: `call_${Date.now()}`, type: "function", function: { name: t.function.name, arguments: JSON.stringify(args) } });
        return typeof r.content === "string" ? r.content : JSON.stringify(r.content);
      },
    }),
  );
}

/** The deliverable as a tool too, so the model's reads are in the transcript. */
function deliverableTool(fetched) {
  return import("@anthropic-ai/sdk/helpers/beta/json-schema").then(({ betaTool }) =>
    betaTool({
      name: "read_deliverable",
      description: "Return the deliverable's text, already fetched and hashed by the desk (sha256 in the result).",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      run: async () => JSON.stringify({ url: fetched.url, status: fetched.status, bytes: fetched.bytes, sha256: fetched.sha256, contentType: fetched.contentType, text: fetched.text ?? "(binary content: judge by hash only)" }),
    }),
  );
}

export async function review({ mission, fetched, env = process.env, log = () => {} }) {
  const facts = deliverableChecks(mission, fetched);
  const mode = env.SEAT_MODE === "mock" || (!env.ANTHROPIC_API_KEY && env.SEAT_MODE !== "claude") ? "mock" : "claude";
  const memo = mode === "mock" ? mockMemo(mission, fetched, facts) : await claudeMemo({ mission, fetched, env, log });
  memo.facts = facts; // the gate's own checks, always attached, never the model's to edit
  memo.mission = mission.id;
  memo.deliverable = { url: fetched.url, sha256: fetched.sha256 ?? null, bytes: fetched.bytes ?? null };
  memo.at = new Date().toISOString();
  const text = JSON.stringify(memo, null, 2);
  return { memo, text, sha256: sha256(text) };
}

async function claudeMemo({ mission, fetched, env, log }) {
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const { betaJSONSchemaOutputFormat } = await import("@anthropic-ai/sdk/helpers/beta/json-schema");
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const model = env.SEAT_MODEL || "claude-opus-5-5";
  const tools = [await deliverableTool(fetched)];
  if (env.PAYPAL_MODE !== "mock") tools.push(...(await paypalReadTools(env)));
  else log("seat: PayPal mock — the toolkit's tools are not offered to the model (they would call the real sandbox)");
  const prompt = `MISSION ${mission.id} — "${mission.title}"
Client's brief:
${mission.brief}

Acceptance criteria (judge each, in this order):
${mission.criteria.map((c, i) => `${i + 1}. ${c}`).join("\n")}

Agreed price: ${Number(mission.amount).toFixed(2)} ${mission.currency}. PayPal order id: ${mission.paypal?.orderId ?? "(none yet)"}; authorization id: ${mission.paypal?.authorizationId ?? "(none)"}.
Deadline: ${mission.deadlineAt}. Deliverable URL: ${fetched.url}.

Read the deliverable with read_deliverable${env.PAYPAL_MODE !== "mock" ? ", confirm the hold with get_order" : ""}, then write the memo.`;
  const runner = client.beta.messages.toolRunner({
    model,
    max_tokens: 16000,
    system: SYSTEM,
    tools,
    messages: [{ role: "user", content: prompt }],
    output_config: { effort: "high", format: betaJSONSchemaOutputFormat(MEMO_SCHEMA) },
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    max_iterations: 8,
  });
  let final;
  for await (const message of runner) {
    final = message;
    for (const b of message.content) if (b.type === "tool_use") log(`seat: ${b.name}(${JSON.stringify(b.input).slice(0, 80)})`);
    if (message.stop_reason === "pause_turn") runner.pushMessages({ role: "assistant", content: message.content });
  }
  final = (await runner.done?.()) ?? final;
  if (final.stop_reason === "refusal") throw new Error(`seat: the model declined (${final.stop_details?.category ?? "no category"})`);
  const text = final.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  let memo;
  try {
    memo = final.parsed_output ?? JSON.parse(text);
  } catch (e) {
    throw new Error(`seat: memo is not valid JSON (${e.message}): ${text.slice(0, 200)}`);
  }
  memo.model = final.model ?? model;
  memo.usage = { input: final.usage?.input_tokens, output: final.usage?.output_tokens };
  return memo;
}

/** No model: a memo built from the gate's facts and a plain keyword reading of each criterion. Says so. */
function mockMemo(mission, fetched, facts) {
  const text = (fetched.text ?? "").toLowerCase();
  const words = text ? text.split(/\s+/).filter(Boolean).length : 0;
  const criteria = mission.criteria.map((c) => {
    // a criterion may carry its own machine check in brackets: [min-words 250] [contains BR Score] [absent price]
    const min = c.match(/\[min-words (\d+)\]/i);
    const has = c.match(/\[contains ([^\]]+)\]/i);
    const abs = c.match(/\[absent ([^\]]+)\]/i);
    if (min) return { criterion: c, met: words >= Number(min[1]), why: `${words} words counted` };
    if (has) return { criterion: c, met: text.includes(has[1].toLowerCase()), why: text.includes(has[1].toLowerCase()) ? `"${has[1]}" found` : `"${has[1]}" not found` };
    if (abs) return { criterion: c, met: !text.includes(abs[1].toLowerCase()), why: text.includes(abs[1].toLowerCase()) ? `"${abs[1]}" is present` : `"${abs[1]}" absent` };
    return { criterion: c, met: false, why: "no machine check in brackets: a model is needed to judge this criterion" };
  });
  const allMet = criteria.every((x) => x.met) && facts.every((f) => f.ok);
  return {
    summary: `Mock seat (no model): ${criteria.filter((x) => x.met).length}/${criteria.length} criteria pass by machine check; deliverable ${fetched.ok ? `${fetched.bytes} bytes` : "unreachable"}. ${allMet ? "Release." : "Hold."}`,
    evidence: [
      { fact: `deliverable at ${fetched.url}: ${fetched.ok ? `HTTP ${fetched.status}, ${fetched.bytes} bytes, sha256 ${fetched.sha256}` : fetched.why}`, source: "deliverable" },
      { fact: `price ${Number(mission.amount).toFixed(2)} ${mission.currency}, order ${mission.paypal?.orderId ?? "none"}, authorization ${mission.paypal?.authorizationId ?? "none"}`, source: "brief" },
    ],
    criteria,
    recommendation: allMet ? "release" : "hold",
    unverified: criteria.filter((x) => /no machine check/.test(x.why)).map((x) => x.criterion),
    model: "mock (no language model was called)",
  };
}

export function loadMemo(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}
