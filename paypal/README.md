# dareskro on PayPal — the same desk, seven shapes, and the first model in the loop

**PayPal AI Hackathon "Build what's next with PayPal and AI", Devpost, 1 October – 12 November 2026.**
Everything in this folder (`paypal/`) and the PayPal tab of the pay desk (`app/src/PaypalDesk.tsx`, `app/src/paypal.ts`) was
written in the submission window, first commit 3 November 2026. The rest of the repository is the product dareskro built on
the XRP Ledger (New York, 24–25 October), then on Solana and NEAR: it is the baseline, disclosed as the rules ask ("existing
projects must have been significantly updated after the start of the Submission Period; explain how"). Diff: tag `pre-paypal`
→ tag `paypal-submission`.

> The agent reads the evidence. The code computes the amount. A human validates. PayPal pays when the rule says so.
> The model has no tool that moves money.

## What PayPal changes, said plainly

On XRPL, Solana and NEAR dareskro locks money in an escrow: the ledger (or a contract with no owner) holds it, and the rule
that releases it is written where everyone can read it. PayPal has no escrow. It has three verbs that, put in the right order,
give the same guarantees to the payer — and one difference the record never hides.

| the desk's step | on the ledger | on PayPal (`rail.mjs`) |
|---|---|---|
| lock | `EscrowCreate` / `create` | an **order with intent `AUTHORIZE`** the payer approves on PayPal's page: the **authorization** holds the amount, nothing is charged |
| release | `EscrowFinish` / `finish` | **capture** of the authorization (partial allowed; `final_capture` gives the rest back), then **one payout batch** to the payees |
| refund | `EscrowCancel` / `cancel` | **void** of the authorization: the payer was never charged |
| the deadline | `CancelAfter` | the mission's `deadlineAt`, which the desk refuses to set after the hold's expiry |
| the memo on the ledger | `Memos` | the capture's note and `invoice_id`, the payout's note, and the public registry `sortie/missions.json` |

The difference: **a PayPal authorization lasts 29 days**, and a capture lands on the platform's PayPal account before the
payout leaves it. For a mission that fits in 29 days the payer's position is the ledger's: nothing charged until the rule says
so, and the desk's code is the only thing that can say so. For a deposit that outlives it (a lease), the vault runs in
**custody** — captured at lock, held on the platform's account, paid out at the decision — and the record says `custody: true`.
That is a different trust than the ledger's, and the README says it before the jury asks.

## The seven shapes (`kinds.mjs`)

One table per shape; the service (`service.mjs`) is generic. Each table says what the payer agrees to at draft, when the
mission is locked, and the gate that releases or refunds — a list of reasons, all of which must hold, every one of them written
in the registry whether it passed or not.

| shape | what it was on XRPL / NEAR | on PayPal | who decides |
|---|---|---|---|
| **payroll** | `FinishAfter` only; one Batch = net + URSSAF Check + DGFiP escrow | one hold by the employer; at the date **anyone** releases: one capture, **one payout batch of three items** (employee, URSSAF, DGFiP) | the date; the human validated the statement *before* the lock (GDPR art. 22) |
| **delivery** | `Condition` + `CancelAfter`, hash of the file | hold; the freelancer delivers a URL, the code fetches and hashes it, **the AI seat writes the memo**, a named human validates; capture + payout — or void at the deadline | the model proposes, the human decides, the code gates |
| **presence** | `Condition` + `FinishAfter` + `CancelAfter`: the post live at the date | hold; before the date the desk only watches; at the date it reads the page: live → capture + payout; deleted → void | the code, by reading |
| **affiliate** | the merchant confirms with a token given once | hold **before** the sale (a confirmation before the lock is refused); the merchant's token releases; the capture carries the order hash | the merchant's system, with a token whose hash alone is kept |
| **pool** | NEAR `pool_create` / `pool_fund`, ≤ 16 payers, surplus trimmed | one hold per payer; locked when the target is reached; the filling share is **captured partially**, the surplus released to that payer; one payout | the date, or a named human |
| **vault** | NEAR vault 2-of-3 / XRPL 2-of-3 signer list (rental deposit, returned in part) | the owner's hold; each party votes an amount to the beneficiary; the vote that reaches 2 of 3 **captures that amount, the rest goes back to the owner**; past the deadline anyone voids; `custody` for leases longer than 29 days | 2 parties of 3 |
| **advance** | XRPL pool 2-of-3: AI, risk policy, operator (the invoice advance) | three seats sign — the AI's memo, a deterministic policy, the operator; **2 of 3** pay the supplier from the platform's balance; the debtor repays by an order with intent `CAPTURE` | 2 seats of 3; the policy's refusal is a signer's refusal, not the rail's |

A fee per act, zero by default and bounded by the code at 1 % (`tarif.json`, basis points), is taken on what leaves the
platform at payout — the same lever as on the three ledgers.

## The AI seat (`seat.mjs`) — what it reads, what it cannot do

This is the first place in dareskro where a language model sits. Until now "the agent" was code reading a schedule and a
badge log; the memo of the invoice advance was produced deterministically. Here the seat is Claude (`claude-opus-5-5`, through
the official Anthropic SDK's tool runner), and its job is bounded the way the oracle's is on XRPL:

- it **reads**: the brief and its acceptance criteria; the deliverable, already fetched and hashed by the desk (`read_deliverable`);
  and what PayPal actually holds for the mission, through **PayPal's Agent Toolkit** (`@paypal/agent-toolkit`, read-only tools
  `get_order` and `list_transactions`, adapted from its OpenAI binding to the Anthropic tool runner);
- it **writes** a memo with a fixed JSON schema: evidence with its source, one verdict per criterion with the quote that
  decides it, a recommendation (`release` / `hold` / `refuse`) and the list of what it could not verify;
- it has **no tool that moves money**. `capture`, `void` and `payout` are in `rail.mjs` and are called by `service.mjs` only after
  the shape's gate and, where the shape says so, a named human.

The memo is hashed (SHA-256) and written to `sortie/memos/<mission>.json` before the human sees it; the validation records that
hash, so what was validated is what the registry keeps. `SEAT_MODE=mock` produces the same memo shape from the gate's facts and
the machine checks a criterion may carry in brackets (`[min-words 250]`, `[contains BR Score]`, `[absent guaranteed]`), says in
its `model` field that no model was called, and is what the tests run on.

## Measured — mock PayPal, mock seat, 3 November 2026 (60 steps)

`PAYPAL_MODE=mock SEAT_MODE=mock node demo_paypal.mjs` starts the service with an in-memory PayPal that answers the same
shapes as the sandbox (every id starts with `MOCK-`), drives the seven shapes, sends the forbidden actions for real, and writes
`sortie/compte_rendu.json`. 60 steps, all as expected:

| shape | what was sent | what came back |
|---|---|---|
| payroll | release before the pay date | **409**, `pay date reached` false |
| payroll | release at the date | one capture 801.66, **one payout batch of three**: 407.32 employee, 361.31 URSSAF, 33.03 DGFiP |
| payroll | release twice | **409**, `hold of the pharmacy: authorization is CAPTURED` |
| delivery | release before anything | **409**: state, human decision, memo on file, hold |
| delivery | void before the deadline | **409** |
| delivery | the memo (4/4 criteria) then release **without** a human | **409**: `human decision: no human validation` |
| delivery | a named human, then release | capture, payout to the freelancer |
| delivery | void after the capture | **409** |
| presence | release before the check date; probe before the date | **409**; `watch`, not a decision |
| presence | the deleted post at the date | release **409**, void accepted: the brand never charged |
| affiliate | confirmation before the lock; a bad token | **409** (the money must be locked *before* the sale); **403** |
| pool | release with 600 of 1000 held; a third payer once full | **409**; **409** |
| pool | 700 brought when 400 were missing | the order is for **400**; at the date two captures, one payout of 1000 |
| vault | one vote; two votes that disagree; a stranger's vote | **409**; no decision; **400** |
| vault | landlord + mediator agree on 180 | **capture 180, 1020 released back to the tenant**, payout 180 to the landlord |
| vault (custody) | no decision at the deadline | the whole deposit **paid back** to the owner by payout |
| advance | AI memo + policy (800 ≤ 90 % of 900) | **2 of 3: paid without the operator**; the debtor's `CAPTURE` order, repaid |
| advance | 855 asked (95 %) | the policy **refuses**; AI + operator still make 2 of 3 — a signer's refusal, as on XRPL |

## Measured — PayPal sandbox, Claude seat, 3 November 2026

Same demo, `PAYPAL_MODE=sandbox SEAT_MODE=claude`, one shape at a time (`DEMO_ONLY=<shape>`), 20:00–21:30 UTC. Every order was
a real sandbox order approved by a human on PayPal's page with a sandbox Personal account; every hold, capture, void and payout
below is PayPal's own id, checkable in the sandbox dashboard. The seat was `claude-opus-5-5` through the SDK's tool runner, with
the PayPal Agent Toolkit's read-only tools. Fee: 1 bp (0.01 %) of what is released, kept on the platform's account.
Registry: `sortie/missions.json`; one report per shape: `sortie/compte_rendu_<shape>.json`; the desk's log: `sortie/service.log`.

| shape | mission | hold / order | what happened | payout (PayPal status) |
|---|---|---|---|---|
| payroll | PAY-58267F | authorization 0H923884BD348641U, 801.66 | release before the date **409**; at the date capture 62V017810L6457311; release twice **409** | 3ZYDR5QNUBRYE **SUCCESS**: 407.32 employee (SUCCESS), 361.31 URSSAF, 33.03 DGFiP (UNCLAIMED: mock addresses) |
| delivery | DEL-850982 | authorization 2W56764598992502B, 120 | deliverable fetched, 1468 bytes, sha256 8c707f0d…; **memo by claude-opus-5-5, 4/4, cites `paypal:get_order`**, sha256 79db1968…; release on the memo alone **409**; Julien validates; capture 9DC98243J55097407 | V9Y4RVYJ2HQV2 **SUCCESS**: 119.99 (fee 0.01) |
| presence | PRE-FB6789 | authorization, 80 | watch before the date (no decision); release early **409**; at the date the post is live → capture 8RH401899N604435S | F2U59T8VD3BS4 **SUCCESS**: 79.99 |
| presence | PRE-4BC6D0 | authorization, 80 | the post answers **404** → release **409**, **void 0TN9015825219300R**: the brand never charged | — |
| affiliate | AFF-B8DFC6 | authorization 2LU04622J2717534J, 25 | confirm before the lock **409**; bad token **403**; the sale confirmed with its hash; capture 8VJ727459B990791W | T6SFUUTA2S5KE **SUCCESS**: 25.00 |
| pool | POO-5A20A9 | 600 (17316083HF1550623) + **400 of the 700 offered** (1JJ30432RA0433250) | release at 600/1000 **409**; a third payer once full **409**; at the date captures 6NU530152H978454G + 0F294513VN4813710 | 8YTFWDFVWNTGQ **SUCCESS**: 999.90 (fee 0.10) |
| vault | VAU-D11247 | authorization 12U88777GV854771U, 1200 | one vote: nothing; two that disagree: nothing; a stranger **400**; landlord + mediator say 180 → **partial capture 180** (6SU60818MW199240X), **1020 back to the tenant**, never charged | Y9UKC8452R3WW **SUCCESS**: 179.98 |
| vault (custody) | VAU-E0EB4E | order captured at the lock, 3VY99844US7611410, 500 | no decision at the deadline → the whole 500 paid back by payout | ETYZWTG78KR3L (to the draft's address; fixed, see below) |
| advance | ADV-30E35E | no hold: the pool pays | memo by claude-opus-5-5 names the invoice; policy 4/4 (800 ≤ 810, 29 d ≤ 90, cap); **AI + policy = 2 of 3, paid without the operator**; the debtor's CAPTURE order 3K994277SM473315S paid → **repaid**, 0B863230H8384340T | 8ZGBT2YKTNGXJ **SUCCESS**: 799.92 |
| advance | ADV-BA9C55 | — | 855 asked (95 %): the policy **refuses**; AI + operator could still make 2 of 3 | — |

What the sandbox taught, and what changed because of it (all four are in the code now, and the mock run still gives 60/60):

1. **Dates calibrated for a machine.** The demo put "the date" 3 s after the draft; a human takes minutes to approve, so the
   first payroll run released "too early" legitimately. In sandbox the demo now gives `DEMO_APPROVE_WINDOW` (300 s) and waits
   for the date itself.
2. **A silent timeout.** An order nobody approved within 30 min was counted as approved. It is a failed step now.
3. **The fee in the assertion.** With 1 bp the pool pays 999.90, not 1000.00; the test adds the fee back.
4. **Refund to the account that paid.** The custody refund went to the address typed at the draft (a mock one). The rail now keeps
   the payer address PayPal reports at approval (`paidFrom`) and refunds there. Measured in mock only; the next sandbox custody run
   will show it.

Not measured: the 29-day expiry itself (it needs 29 days), and a payout that PayPal refuses (every one was accepted).
The two memos of the advance say they did **not** call `get_order`, because an advance has no hold: the seat reads only what exists.

## The desk tab — `app/src/PaypalDesk.tsx`

The same pay desk as XRPL, Solana and NEAR has a **PayPal · same desk** tab: six cards. The rail (mode, seat, hold, fee, the
counts of the registry); the draft, with the seven shapes as a segmented control and the demo's values prefilled; the lock
(the AUTHORIZE order, approved on PayPal's page — a "mock click" button in mock mode, a new tab in sandbox, the hold appears when
PayPal sends the buyer back); the shape's own step (deliver → the seat reads → a named human validates; the page probed; the
merchant's token; the votes; the three seats of the advance and the debtor's repayment); release and void, every attempt listed
with the gate's reasons when refused; the registry. Measured in mock on 3 November: a delivery (release refused before anything
and on the memo alone, then validated and paid with the 1 bp fee) and a deposit (a stranger's vote **400**, landlord + mediator
on 180 → capture 180, 1020 back). The tab only talks to `service.mjs` on 127.0.0.1:8796; `app/src/paypal.ts` is its client.

## Hosted demo — Render

**https://dareskro-paypal.onrender.com** (free tier: the first request may take a minute to wake it). `render.yaml` at the root of the repository is the Render Blueprint behind it: one free web service that runs `service.mjs` with the
**mock PayPal** (no credentials; every id starts with `MOCK-`) and serves the built desk at `/`, opened on the PayPal tab
(`?case=paypal`). Anyone can draft a mission, "mock click" the payer's approval, let the seat read, validate, release or
void, and watch the registry — every refusal included. The hosted registry (`PAYPAL_OUT=sortie_hosted`) starts empty and
stays apart from the sandbox one. Set `ANTHROPIC_API_KEY` in the Render dashboard and the seat is the real Claude on the
hosted desk (it still has no tool that moves money); leave it empty and the mock seat writes the same memo shape.

The sandbox itself is not hosted on purpose: a real PayPal approval needs a sandbox **buyer** account, i.e. a human on
PayPal's page, and the ids of the 3 November measurement are in this README and in `sortie/missions.json`. What the
hosting needed from the code: the service listens on the host's `PORT`, takes its public URL from `RENDER_EXTERNAL_URL`
(for PayPal's return URL), serves `app/dist` when it exists, and the desk's client reads `VITE_PAYPAL_DESK_URL` (empty =
its own origin).

## Run it

```bash
cd paypal && npm install

# 1. no credentials: the whole thing on a mock PayPal, mock seat
PAYPAL_MODE=mock SEAT_MODE=mock node demo_paypal.mjs

# 2. the sandbox: copy .env.example to .env (chmod 600), fill the sandbox app's client id/secret,
#    the sandbox personal account that plays the payee, and ANTHROPIC_API_KEY for the seat
node demo_paypal.mjs            # prints each approval URL: approve as the sandbox buyer, the script goes on
DEMO_ONLY=pool,vault node demo_paypal.mjs      # one shape at a time; DEMO_APPROVE_WINDOW=300 (s) is how long "the date" waits for the human
PAYPAL_OUT=sortie_mock PAYPAL_MODE=mock SEAT_MODE=mock node demo_paypal.mjs   # a mock run that leaves the sandbox registry alone
node service.mjs                # the service alone, http://127.0.0.1:8796, behind the desk's PayPal tab (app/)
(cd ../app && npm run dev)       # the desk: open it, pick "PayPal · same desk" (or add ?case=paypal)
(cd ../app && VITE_PAYPAL_DESK_URL= VITE_DEFAULT_CASE=paypal npm run build) && PAYPAL_MODE=mock PAYPAL_OUT=sortie_hosted node service.mjs   # what Render runs: one URL
```

Every mission, every refusal and every PayPal id goes to `sortie/missions.json` (public) and `sortie/service.log`; the memos to
`sortie/memos/`; the presence observations to `sortie/observations_<id>.jsonl`. Nothing in `sortie/` is a secret; `.env` is.

## Files

| file | what |
|---|---|
| `rail.mjs` | PayPal with three verbs: authorize (lock), capture (release, partial allowed), void (refund), payout (pay, several items); `CAPTURE` orders for custody and repayments; a mock that answers the same shapes |
| `kinds.mjs` | the seven shapes: what the payer agrees to, when locked, the gates |
| `seat.mjs` | the AI seat: Claude + PayPal Agent Toolkit (read-only) → the memo, hashed; the mock seat |
| `gate.mjs`, `fetch_deliverable.mjs` | the shared checks (hold matches, deadline fits the hold, the deliverable's hash) and the reader |
| `service.mjs` | the state machine and the HTTP routes; the registry |
| `demo_paypal.mjs` | the seven shapes end to end, refusals included; `sortie/compte_rendu.json` |
| `../app/src/PaypalDesk.tsx`, `../app/src/paypal.ts` | the desk tab and its client of the service |
| `enregistre.mjs` | films the sandbox logs (`sortie/mesure_<shape>.log`) typed out in a terminal, Playwright + ffmpeg → `sortie/film_sandbox.mp4` (2:31); `--clip delivery --seconds 12 --size 1280x720` makes a 12 s insert of one shape |
| `tarif.json` | the fee per act (bps, ≤ 100, zero by default) |
| `../render.yaml` | the hosted demo: mock PayPal + the built desk on one Render web service |
| `fixtures/` | the demo's deliverable, post and invoice |

## Honest limits

- **29 days.** The hold is PayPal's, and it ends. The desk refuses a deadline past the hold's expiry; a lease's deposit runs in custody and says so.
- **The platform's account.** A capture lands there before the payout leaves it. On the ledger nobody holds the funds; here, for the time of one call, the platform does. The code is public; the registry is public; the sandbox ids are checkable.
- **Payouts need enabling** on a PayPal business account (and a balance); the mock does not know that. If the payout fails after a capture, the record says `payout.error` and the capture stands.
- **The seat is a model.** It reads, it does not decide: the gate and the human do. Its memo is hashed before anyone acts on it, and its mock twin exists so the rest of the desk is tested without it.
