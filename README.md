# dareskro — agentic payroll escrow on the XRP Ledger, signed on a Ledger device

**AI & Fintech XRP Ledger Hackathon, New York, 24–25 October 2026.**
Demo video (3 min 49, English): [dareskro explainer v2 — La Linea, with the one-day contract, URSSAF, and the oracle's real loop typed on its card](https://github.com/LeDenti/dareskro/releases/download/v0.1-hackathon-nyc/dareskro_final_EN_linea2.mp4) · earlier cut with the terminal logs: [split screen](https://github.com/LeDenti/dareskro/releases/download/v0.1-hackathon-nyc/dareskro_final_EN_linea_split.mp4) · release [v0.1-hackathon-nyc](https://github.com/LeDenti/dareskro/releases/tag/v0.1-hackathon-nyc).
The spoken pitch: [PITCH.md](PITCH.md) (full, with the Q&A) and [PITCH_3MIN.md](PITCH_3MIN.md) (the 3-minute track version).
Track: Agentic Finance. Partner prizes targeted: Ledger (Agentic Finance), Mastercard.

> The agent reads the evidence. The code computes the amount. A human signs on a
> Ledger device. The XRP Ledger pays at the date. Nobody holds the funds in between.

## The problem

Every month a small business pays people whose work it cannot fully verify: a
pharmacist's Sunday shift, a freelancer, a real-estate agent on commission. The
evidence is scattered (schedules, badge logs, CRM), the rules are long (collective
agreements), and someone always ends up chasing a payment.

## What dareskro does

1. **Evidence.** The schedule *qualifies* the hours (Sunday shift, shutters open,
   after 35 h already worked). The badge log *proves* presence. A badge never
   qualifies an hour: that is the schedule's job, and only the schedule's.
2. **Calculation, by code only.** `officine.garde` applies the French pharmacy
   collective agreement (IDCC 1996, art. 11; agreement of 23/03/2000, art. 4),
   line by line, replayable to the cent. No model in the loop: a payroll must be
   auditable three years later.
3. **Human validation.** A named person validates the statement. Nothing is locked
   while it is a PROPOSITION (GDPR art. 22: no fully automated decision on pay).
4. **Signature on a Ledger device.** The employer signs `EscrowCreate` on the
   device: amount, destination, pay date and the statement's SHA-256 are on a
   screen the agent cannot touch. Nothing moves before that signature.
5. **Payment by the ledger.** `FinishAfter` only — no `Condition`, no
   `CancelAfter`. After the date, *anyone* can finish the escrow; the employer has
   no transaction to take the money back. One possible outcome.

## What was built during the 36 hours

Only this counts for judging, and we say so.

| Piece | Where | Status |
|---|---|---|
| Evidence → statement agent (schedule + badge → lines, total, SHA-256); since Sunday morning the statement is a **one-day fixed-term contract**: end-of-contract bonus and paid-leave allowance (10 % + 10 %), the contributions (rates bought from the rules service), the income tax withheld at source (personalised rate from DGFiP), the net paid, the employer cost | `agent/bulletin_garde.py` | done: shift 466.57, gross 564.56, net 440.35, tax 33.03, paid 407.32, 361.31 to URSSAF (USD; `--devise EUR` for euros) |
| Pay desk web app: statement, human validation, Ledger connect, `EscrowCreate` signed on device, proofs, third-party release | `app/` | done, run end to end on Speculos (Nano X, XRP app 2.8.1) **and on a real Nano S Plus (XRP app 2.8.2), Saturday 19:40 UTC** |
| Ledger integration: Device Management Kit + `device-signer-kit-xrp` (pre-release), USB / Bluetooth / Speculos | `app/src/ledger.ts` | done |
| Escrow builder for the device, memo with statement hash, early-finish / cancel / release proofs | `app/src/xrpl.ts` | done |
| Ledger developer-experience feedback | `LEDGER_FEEDBACK.md` | done |
| Delivery oracle (example 3): conditional escrow, proof = URL + SHA-256 read online by the oracle, secret revealed on match, refund at the deadline | `oracle/oracle.mjs`, `oracle/demo_livraison.mjs` | done, run on testnet 24/10 18:35 UTC |
| Four payers on one desk (examples 1, 3, 4): the oracle gains the "presence" shape (influencer: the post must be live at the end of the period) and the "affiliate" shape (the merchant's sales system confirms the order; the release carries the order hash); the pay desk gets a case selector, a contract desk signed on the same device path, and a registry of every escrow | `oracle/oracle.mjs` (`KINDS`), `app/src/ContractDesk.tsx`, `oracle/demo_influenceur.mjs`, `oracle/demo_affiliation.mjs` | done, measured 21:38–21:56 UTC |
| Privacy: the salary invisible to the public, visible to the administration — a fresh payee account per period, the statement sealed for two readers (employee, administration), a zero-knowledge compliance proof (Noir, UltraHonk in wasm) bound to the escrow by hash and commitment, a privacy service behind the desk's Privacy card |
| One signature, three transactions: the net paid (escrow), the contributions as a Check URSSAF cashes itself, the income tax to DGFiP (escrow), inside one Batch (XLS-56, all or nothing) signed once on the device | `app/src/xrpl.ts` (`prepareCheckCreate`, `cashCheck`, `prepareBatch`), `app/src/App.tsx`, `oracle/demo_confidentialite.mjs` | done, measured 25/10 | `agent/confidentiel.mjs`, `agent/divulgation.mjs`, `zk/` (`circuit/src/main.nr`, `prove.mjs`, `verify.mjs`, `ouvrir.mjs`), `agent/service_confidentialite.mjs`, `oracle/demo_confidentialite.mjs` | done, measured 22:10 UTC |
| Mastercard Agent Pay for Machines (AP4M): the agent buys its evidence over x402 in RLUSD on XRPL EVM testnet, inside a cap the employer approved | `ap4m/agent.mjs`, `ap4m/merchant.mjs` | done, run live 24/10 17:44 UTC: channel, 402, voucher, redemption, RLUSD settlement, receipt verified on-chain |

### Measured on testnet, 24/10/2026, signed on the Ledger XRP app (2.8.1, Nano X emulated by Speculos)

| Step | Signed by | Result |
|---|---|---|
| `EscrowCreate`, 466.57 XRP, FinishAfter +90 s, memos = statement SHA-256 + id — [19A03F2C…](https://testnet.xrpl.org/transactions/19A03F2CC5108F42B7FF2FD846F0150B4D735DC5444BDB34FA286982859E19E8) | the device, after 15 review screens | `tesSUCCESS` |
| `EscrowFinish` by a third party **before** the date — [48136EE8…](https://testnet.xrpl.org/transactions/48136EE86CEDF26039857AD3C876697F95CEE59FF25708A149735542BD27D0DB) | a fresh faucet account | `tecNO_PERMISSION` |
| `EscrowCancel` by the employer — [1E08B209…](https://testnet.xrpl.org/transactions/1E08B209F6C42A9217E24B028611F98C2FF6F33A1631CA3DD965BDD221772600) | the device (it signs; the ledger refuses) | `tecNO_PERMISSION` |
| `EscrowFinish` by a third party **after** the date — [79C97E6B…](https://testnet.xrpl.org/transactions/79C97E6B56728E660DABAB32854ADFFA6EB4CE52FC6DDA98FC3FC378125B4913) | a fresh faucet account | `tesSUCCESS`, employee credited 466.57 XRP |

What the device showed, screen by screen, is in `LEDGER_FEEDBACK.md`: the pay date
as a readable UTC date, both memos in full, no blind signing.

### On real hardware — Ledger Nano S Plus, XRP app 2.8.2, 24/10/2026 19:35–19:43 UTC

Same page, Chrome, WebHID. The employer pressed the device's buttons; nobody else
touched the keys. The first attempt, with the XRP app 2.2.2 that shipped on the
device, was refused before any review screen (`status 6800`, see
`LEDGER_FEEDBACK.md`); after updating the app in Ledger Live it signed.

| Step | Signed by | Result |
|---|---|---|
| `EscrowCreate` 405.219732 XRP = 466.57 € at 1.1514 EUR/XRP, FinishAfter +240 s, memos sha256 + eur + oracle — [5FF67E32…](https://testnet.xrpl.org/transactions/5FF67E32CEE83FCB7E3E25FE726BA3AE2A851C370417C0A05D45E0119772E9CC) | **the Nano S Plus** | `tesSUCCESS`, escrow #21793983 |
| `EscrowFinish` by a third party **before** the date — [EA6790A1…](https://testnet.xrpl.org/transactions/EA6790A1094094F90594663EFAC40E390C7C4A6032C7FF43B9FCBFC39D7CB6A9) | a fresh faucet account | `tecNO_PERMISSION` |
| `EscrowCancel` by the employer — [71E227E5…](https://testnet.xrpl.org/transactions/71E227E5B7606F72505DF5DDBD3645DFC5B2B2F99E3E53CE84CE449FEC2016BD) | **the Nano S Plus** (it signs; the ledger refuses) | `tecNO_PERMISSION` |
| `EscrowFinish` **by the oracle**, 13 s after the date — [F61DBCD3…](https://testnet.xrpl.org/transactions/F61DBCD30CD4D88AB55782E30287A012DBFC23E4381A8A853430F22E8AD8FF3A) | `rUuvu1XPgd5GtTgrXQKiwrHq3fb2xiHZMW` | `tesSUCCESS`, employee credited |

A first device-signed escrow a few minutes earlier
([8C2AD66C…](https://testnet.xrpl.org/transactions/8C2AD66C5E4073A9D426E7602C553B05784324E777FA50E7BE4FA55F78F52DBF),
90 s delay) was finished by a third party *after* its date
([3BAC99BF…](https://testnet.xrpl.org/transactions/3BAC99BF09DBD2E366F93306DED2DEF3E1F9C123A6295FBC16BCE21726B2DF7E),
`tesSUCCESS`) while we were still clicking: the "anyone can finish after the date"
rule, demonstrated by accident.

### Second run, 24/10/2026 15:54 UTC — the oracle releases by itself

| Step | Signed by | Result |
|---|---|---|
| `EscrowCreate` with a third memo citing the oracle (17 screens on the device, `Memo Data [3]: rUuvu1X…`) — [F4029046…](https://testnet.xrpl.org/transactions/F4029046943D8EBADE8B7C432646739875D6635BF7A2F48D54FAF17040ACA524) | the device | `tesSUCCESS` |
| `EscrowFinish` by a third party **before** the date — [013744BE…](https://testnet.xrpl.org/transactions/013744BEB23C06430FE2EFC6E6DB08191166C634D1CD54C0EF28F440784C970C) | a fresh faucet account | `tecNO_PERMISSION` |
| `EscrowFinish` **by the oracle**, 12 s after the date, nobody clicked — [2F94E2BE…](https://testnet.xrpl.org/transactions/2F94E2BE970311999B3A759B4760CAC3EC4C9B0B2E9C1DCE54839655A48D79B2) | `rUuvu1XPgd5GtTgrXQKiwrHq3fb2xiHZMW` | `tesSUCCESS`, employee credited 466.57 XRP |
| `EscrowCancel` by the employer, signed on the device after the oracle had paid — [31771004…](https://testnet.xrpl.org/transactions/31771004943B4A5DFD7B1BB7B250FA8C1DA8F6A17DFE053BE99091DFC90F7562) | the device | `tecNO_TARGET`: already paid, nothing left to cancel |

Oracle log of that run:

```
15:54:36 watching escrow #21789941 of rGJsjkfm…: 466.57 XRP to r3kiDtPb…, payable at ripple time 846172520
15:55:27 escrow #21789941: date passed, submitting EscrowFinish…
15:55:32 escrow #21789941: finished — 466.57 XRP to r3kiDtPb… — https://testnet.xrpl.org/transactions/2F94E2BE…
```

### What existed before (not for judging)

Escrow core on XRPL testnet with xrpl-py, payroll rules (the `officine.garde`
engine the agent imports), PDF dossiers. That prior work lives in a `sources/`
folder that is **not part of this repository**: only the weekend's code is
published here. Two lessons from that work are
reused as-is: the beneficiary must open a trustline *before* a third party can
finish a token escrow (`tecNO_LINE` otherwise), and RLUSD could not be escrowed
when measured on 08/09/2026 because its issuer had not set
`lsfAllowTrustLineLocking`.

**A one-day contract, and the contributions paid by the ledger too.** A Sunday shift
by an outside pharmacist is a fixed-term contract of one day, so the statement carries,
on top of the four shift lines (466.57), the end-of-contract bonus (10 %, Code du travail
L1243-8: 46.66) and the paid-leave allowance (10 % of the gross including that bonus,
L1242-16: 51.32): **gross 564.56**. Then the contributions, at aggregated indicative
rates bought from the rules service with the point value (`fixed_term`, `contributions`
in the resource; the DSN computes line by line in production): employee 22 % (124.20),
employer 42 % (237.12). **Net before tax 440.36; 361.32 to URSSAF**, due the 15th of the
next month; employer cost 801.68. Then the **income tax withheld at source** at the
employee's personalised rate, transmitted by DGFiP through the DSN (7.5 % here, in the
schedule file): 33.03 to DGFiP, **net paid 407.33**.

Three transactions leave the pay desk for one validated shift, and the ledger carries
each to the right place:

| Leg | To whom | How | When |
|---|---|---|---|
| the net paid, 407.33 | the employee (a fresh account per period) | an **escrow**, FinishAfter only, released by the oracle | the pay date |
| the contributions, 361.32 | URSSAF | a **Check** (XLS-18) with the statement hash as `InvoiceID`: the employer signs once, URSSAF cashes it itself (`CheckCash`) for the amount due before it expires — the ledger's direct-debit mandate | whenever URSSAF wants, before the due date + grace |
| the income tax, 33.03 | DGFiP | an **escrow**, released by the oracle | the due date |

**Rounding, fixed at 10:45 NY on Sunday.** The four shift lines are printed rounded to the
cent (250.51 + 83.50 + 94.99 + 37.58 = 466.58) but the engine rounded their *exact* sum once
(466.5714 → 466.57): the statement did not add up on paper. Since then each line is rounded,
then added: shift 466.58, gross 564.56, net 440.36, URSSAF 361.32, DGFiP 33.03, net paid 407.33,
employer cost 801.68 (rates labelled "10 %", no more "1E+1 %"). The Noir circuit rounds line by
line too (replayed on 20 000 random combinations: identical whenever the week held at most
43 h before the shift), the statement was regenerated (sha256 384ec59c…), proven again
(commitment 0x20613f4b…, 4 compatible triples instead of 11) and sealed. Every run measured
**before** that moment carried the previous statement (ede5c5fd…, one cent apart on four
lines); the runs after it are marked.


**Where the money is, and when it must be there.** At `EscrowCreate` the XRP leave the
employer's spendable balance and sit in an **Escrow object of the ledger** — owner the
employer, `Destination` the employee, `Amount`, `FinishAfter` — that no account can spend:
not the employer (no cancel date), not the employee (not before the date), not the oracle
(it never holds anything, it only submits the finish). The ledger refuses the lock if the
account cannot fund it on top of its reserve (`tecUNFUNDED_ESCROW`, `tecINSUFFICIENT_RESERVE`),
so the pay and the income tax are **provisioned at the moment of the lock**: when the human
validates the statement, before the pay date — and, for the freelancer, the influencer and the
affiliate, before the work is judged. The desk checks the balance first and says "too low:
N XRP needed for the escrows, the reserve and the fees". The **Check** is the honest
exception: a Check is a right to pull, not a lock. The 361.32 for URSSAF stay in the
employer's balance until `CheckCash`; if they are not there at that moment the cash fails
(`tecUNFUNDED`). We kept the Check to show the ledger's native direct debit; a payroll in
production would lock that leg too, and the desk already carries the form (`kind: "escrow"`
on the URSSAF leg gives it the DGFiP treatment, one line).

**One signature.** The three are inner transactions of one **Batch** (XLS-56,
`tfAllOrNothing`): the employer approves once on the device, the ledger applies all three
or none. Measured on testnet 25/10/2026: a Batch with two inner payments, one signature,
`tesSUCCESS` ([5BAB5020…](https://testnet.xrpl.org/transactions/5BAB5020D0B1A7DA0BA288B51F41238DBF034002049279DA5BD1BB5FAA3070C2)),
then the three legs of the pay in one Batch (table below). The desk keeps "one approval
per transaction" as a switch, for a device whose XRP app does not know Batch yet.
Nobody can forget the contributions or the tax, nobody can divert them: they were
locked the day the shift was validated. The zero-knowledge proof binds the gross; the
pay escrow's `dareskro/gross` memo states gross, net, the contribution rate, the tax
rate and what is paid, and the verifier checks net = gross − contributions and
paid = net − tax. URSSAF and DGFiP are stand-in accounts on testnet; in production the
euro leg does the last mile to their bank accounts with the DSN reference, the way the
dollar leg works today.

**Dollars owed, XRP locked, and the employee chooses how to be paid.** The
statement is in dollars: that is what the employee is owed (`--devise EUR` for
euros). The escrow is in XRP, converted at the rate of the moment of signing
(Kraken XRP/USD, CoinGecko as fallback), and the memo `dareskro/fiat` carries the
amount and the rate, so the device shows both: "466.57 USD @ 2.61 USD/XRP". Then
two options, chosen on the pay desk before the lock:

- **crypto**: the employee keeps the XRP the ledger releases at the date;
- **dollars**: once the ledger has released the escrow — and only then, the payout
  script re-reads the validated `EscrowFinish` on XRPL before doing anything —
  the oracle settles RLUSD, a dollar stablecoin, to the employee's payout wallet
  through **Mastercard Agent Pay for Machines** (`ap4m/payout.mjs`): a one-shot
  "payslip settlement" merchant priced at the pay, the agent answers the 402 inside
  the employer's budget, `VoucherRedeemed` on XRPL EVM, RLUSD settled, receipt. The
  sandbox budget is 20 RLUSD, so the demo settles at 1/100 of the pay (4.67 RLUSD
  for $466.57) and says so in the resource and the receipt. The payout reads the
  budget before it prices anything: when 1/100 of the pay no longer fits in the
  unassigned allocation nor in an open Channel, it settles one notch smaller
  (1/1000, then 1/10000), writes the scale it used in the record, and only then
  gives up with "ask the organizer to fund the team". `ap4m/channels-close.mjs`
  closes the near-empty Channels so their unused cap is unassigned again; in
  production the scale is 1 and none of this exists.

The first runs below, before 18:55 UTC, locked 466.57 XRP as a stand-in; from
then on the page converts at the day's rate. Run from a terminal at 18:56 UTC
(`app/scripts/demo-terminal.mjs`, DMK in Node, Speculos Nano X): rate 1.1474,
466.57 € = 406.632386 XRP, the device showed `Memo Data [3]: 466.57 EUR @ 1.1474
EUR/XRP Kraken 2026-10-24T18:56Z`, escrow
[9D59BC76…](https://testnet.xrpl.org/transactions/9D59BC76560FDAC77A569972E87C1366ED89D6812F364DFE115EB4580A4735F3)
`tesSUCCESS`, early finish by a stranger
[7C2A9FDB…](https://testnet.xrpl.org/transactions/7C2A9FDBF6C5A03BC9CA54692AAC8ADD5CD334C70D89F9B7EB21AC6327D2E7EB)
`tecNO_PERMISSION`, released by the oracle 12 s after the date
[0356E36B…](https://testnet.xrpl.org/transactions/0356E36B867DB2F4F5FD8191D1BB4C10F3CD7C20A33565964FDC4CFFA35946DF).

## The oracle — the nerve of the whole thing

The oracle is the **named third party that executes what the ledger already
decided**. It is an XRPL account with a name, a birth certificate on-chain and one
job: watch the escrows it is cited in, and submit `EscrowFinish` once the ledger
allows it. It pays the fee of that transaction. That is all it ever pays.

| | |
|---|---|
| Name | dareskro payroll oracle v1 |
| Address (testnet) | [`rUuvu1XPgd5GtTgrXQKiwrHq3fb2xiHZMW`](https://testnet.xrpl.org/accounts/rUuvu1XPgd5GtTgrXQKiwrHq3fb2xiHZMW) |
| Birth certificate | [`AF5C74C8…`](https://testnet.xrpl.org/transactions/AF5C74C86FB526396E4FCF0B659AB2F3AA8D450C9218A19DA4F54C23EC3B4A2A): an `AccountSet` that changes nothing, with a memo saying what the account is |
| Created | 24/10/2026 15:51 UTC, during the hackathon, with `node oracle/oracle.mjs create` |
| Cited | in every escrow the pay desk builds: memo `dareskro/oracle` → its address, read on the Ledger device before signing |

**What it cannot do, by construction, not by promise.** It never holds the funds:
the money sits in the ledger and goes to the `Destination` written at creation,
whoever submits the finish. It cannot pay early: `EscrowFinish` before
`FinishAfter` is `tecNO_PERMISSION`. It cannot redirect: `EscrowFinish` has no
destination field. It cannot cancel: the payroll escrow has no `CancelAfter`, so
nobody can. For a payroll escrow the oracle's whole power is **punctuality**. If it
dies, anyone else — the employee included — can finish the escrow and the money
still goes where it was written.

**Where an oracle does get power.** In a *conditional* escrow (the freelance case,
example 3 below), the oracle holds the preimage of a `PREIMAGE-SHA-256`
condition and reveals it when delivery is proven. There the oracle decides
*whether*; here it only decides *when*, and even that is bounded below by the
ledger. Same account, same code path, different escrow shape: the shape of the
escrow is the policy.

### The oracle, case by case

The question that sorts oracles is not "can it disappear?" but **"is it a party to
the dispute?"** An oracle with a stake in the outcome is not an oracle, it is a
party. Each of our four cases gives the oracle a different shape, and the shape of
the escrow decides how much the oracle can do.

| Case | Escrow shape | Who observes what | The oracle decides | What bounds it |
|---|---|---|---|---|
| **Pharmacist's Sunday shift** (the demo) | `FinishAfter` only | *Before* the lock: the schedule qualifies the hours, the badge proves presence, code computes, a **named human** validates. *After* the lock: the **payroll oracle** `rUuvu1X…` watches the date | *when*, and only once the ledger allows it | cannot pay early (`tecNO_PERMISSION`), cannot redirect (no such field), cannot cancel (no `CancelAfter`). Anyone can replace it |
| **Real-estate agent** | conditional: `Condition` + `CancelAfter` | two steps: the **notary's signature** on the deed, then the **official publication** of the sale (land records, DVF). Nothing is owed at the compromis (loi Hoguet art. 6) | *whether*: the signature releases the secret; the publication confirms it for anyone | neither the notary nor the public record is a party. The publication is a proof, not the trigger. `CancelAfter` refunds the agency if the sale falls through |
| **Freelancer in Lagos, client in Paris** | conditional: `Condition` + `CancelAfter` | the oracle holds the secret and **reads a public fact by itself**: the file at the agreed URL has the agreed SHA-256 (built this weekend, see below). The signer is interchangeable; the oracle is not | *whether*, from a fact anyone can check | it cannot steal: the funds go to the destination written at creation. It can only block, and blocking ends at `CancelAfter`: the oracle itself submits the refund |
| **Influencer product placement** | conditional + `FinishAfter` | the oracle reads the **platform**: the post is live at the agreed address, and still live at the date (30 days) | *whether*, from a public page | deleted post, no pay; the platform is party to nothing; `CancelAfter` refunds the brand |
| **Affiliate commissions** (five expected) | model A: one conditional escrow per expected commission; model B: no escrow oracle at all | A: the **merchant's sales system** confirms the attributed sale and the end of the return window; automatic. B: the customer pays *through* dareskro and the commission is split at source | A: *whether*, with no human. B: nothing, the payment proves itself | A: the merchant is a party, so the money is locked **before** the sale, every release carries the order hash, and unreleased escrows are cancelled at the end of the campaign. B removes the oracle entirely |

Three remarks the jury should hear:

- **The payroll case moves the judgement before the lock.** The evidence is read
  by the agent and judged by a named person while the money is still the
  employer's. Once signed on the device, nothing is left to judge: only a date.
  That is why its oracle can be a machine with no power.
- **The conditional cases put the judgement after the lock.** The money is already
  out of the payer's hands, so whoever reveals the secret decides. The remedy is
  never trust: it is the `CancelAfter` deadline, after which the ledger refunds
  the payer and the oracle has nothing left to decide.
- **Same account, same code.** The payroll oracle finishes with `EscrowFinish`
  alone; the conditional oracle finishes with `EscrowFinish` + `Fulfillment`
  (`tickDelivery` in `oracle/oracle.mjs`). The difference is in the
  escrow, not in the oracle.

### Example 3, live: the oracle verifies the delivery online

Built Saturday afternoon on the same oracle account. The client asks the oracle
for a condition against an agreed proof — a URL and a SHA-256 — and locks the
fee behind it with a `CancelAfter`. The oracle polls the URL. Nobody clicks.

| Step (24/10/2026, 18:39 UTC, testnet) | Result |
|---|---|
| Client locks 40 XRP behind the condition, memos = proof + oracle — [26A28B94…](https://testnet.xrpl.org/transactions/26A28B9413CF47FCB45A8B7171085C565E8AE13B9B109825C535E9974071BFFD) | `tesSUCCESS` |
| Freelancer publishes the **wrong** file | oracle: "published sha256 19d309b9… ≠ agreed 3be52427…", pays nothing |
| A third party tries `EscrowFinish` without the secret — [4C585D08…](https://testnet.xrpl.org/transactions/4C585D0800286DFBB3CC0B2C60EC94688DCE6951F4C176C66D10FFAA23726F23) | `tecCRYPTOCONDITION_ERROR`: the ledger refuses |
| Freelancer publishes the **right** file | oracle: "match (75 bytes)", reveals the secret, `EscrowFinish` + `Fulfillment` [3AA9B66D…](https://testnet.xrpl.org/transactions/3AA9B66DE39814C42C9CAA4ABC345A193838014587EC025667303E72B5693F41) `tesSUCCESS`, freelancer 100 → 140 XRP |
| Second escrow, nothing ever published — [A15F4497…](https://testnet.xrpl.org/transactions/A15F4497DF04DA35D795A02F54633B2CE11E756BE824866C5B2CDF02F48BD9EF) | after `CancelAfter`, the oracle submits `EscrowCancel` [3CDE5B05…](https://testnet.xrpl.org/transactions/3CDE5B05BD7BC682FFC419306BC868E0AC448405DD927081846C61FD84B8E210): client refunded, 59.99 XRP |

Same account, two shapes: on a payroll escrow the oracle decides *when*; on a
delivery escrow it decides *whether*, from a fact anyone can re-check with a
browser and a hash. In the demo the "publication" is a tiny HTTP server on the
laptop; point `PROOF_URL` at any public address and nothing else changes.

**A site, later.** Online verification covers code, files, sites and APIs —
anything that reduces to a URL and a hash. For deliverables that need a judgement
(a logo, a text), two more oracles are possible, and both deserve a site:
a client-acceptance portal with an explicit silence rule (past the deadline,
either refund or release, written in the escrow and said before signing), and a
panel of named arbiters, party to nothing, paid a small share. Neither is built;
both plug into the same account and the same `EscrowFinish`.

**How it runs.** `oracle/oracle.mjs` — `create` (faucet account + birth memo),
`watch` (an HTTP service on `127.0.0.1:8787` that the pay desk registers escrows
with, plus a loop that finishes them at the date, retrying while the ledger's
close time is not yet past the date), `status`. Its seed lives in
`oracle/.oracle.json` (0600, never committed); what it watches is in
`oracle/registry.json`, public.

### Examples 4 and 5, live: the influencer and the affiliate — four payers on one desk

The same oracle account, the same desk, four shapes of escrow. The pay desk
(`app/`) now opens with a case selector — Employee · Freelancer · Influencer ·
Affiliate — and the three contract cases share one `ContractDesk`: ask the
oracle for a condition, lock the fee on the device, hand the escrow to the
oracle, watch what it sees. A registry card lists every escrow of every kind.

| Shape | Who decides, and what the oracle can do |
|---|---|
| **presence** (influencer, product placement): `Condition` + `FinishAfter` + `CancelAfter` | the oracle decides *whether the post is still there* at the end of the period: it reads the agreed URL, checks the agreed text is in it (`#ad @dareskro`), and only then reveals the secret. Before the date it only watches, and says so when the page appears or disappears. Deleted post, no pay: refund at the deadline. |
| **affiliate** (commission on a merchant's sale): `Condition` + `CancelAfter` | the oracle decides nothing. The merchant's sales system — a party — confirms the sale with a token given once (`POST /affiliate/confirm`, the oracle keeps only its hash). The oracle only guarantees that the money was locked *before* the sale and that the release carries the SHA-256 of the order record in a memo (`dareskro/order-sha256`), so the payout can be matched to the order forever. No sale, refund at the deadline. |

Measured on testnet, 24/10/2026 21:38–21:56 UTC (`oracle/demo_influenceur.mjs`, `oracle/demo_affiliation.mjs`, captures in `presentation/demo-terminal/capture/`):

| Step | Proof |
|---|---|
| Influencer, escrow 1: 20 XRP locked behind the condition, FinishAfter = the end of the period | [F88D1196…](https://testnet.xrpl.org/transactions/F88D11962F76903EDE345DFC5F6675D854D29F0E2C4E462DC387CCD2D62FA5FB) |
| A bystander tries to finish 38 s before the date | `tecNO_PERMISSION` [9779DC7D…](https://testnet.xrpl.org/transactions/9779DC7D2039227985577A9FEC35253E95D6D84951D6E637C1D6FBF15175DB9B) |
| The post is live at the date: the oracle reveals the secret and pays | `tesSUCCESS` [D906F9CC…](https://testnet.xrpl.org/transactions/D906F9CC28C2075BCAC580EC6F82E9E050C37FD774EDA10819611EBB12FDE463) |
| Influencer, escrow 2: the post is deleted before the date (HTTP 404, logged as a transition) | lock [0851C4BE…](https://testnet.xrpl.org/transactions/0851C4BE32D90E390759D799258CA3E4C86AFB72B1DDE5BBE3462D534EFEF4B1) |
| Deadline passed with the post gone: the oracle refunds the brand | `EscrowCancel` `tesSUCCESS` [E1BA776B…](https://testnet.xrpl.org/transactions/E1BA776BF0A9242AD2813B90A4DD2418B8B3E322F728F9A5F88BCB7F2064DD2C) |
| Affiliate, escrow 1: 20 XRP locked for order `ORD-2026-1045` before any sale | [CE7BFECE…](https://testnet.xrpl.org/transactions/CE7BFECEB5828DF31531E0B349D7D4BE5F0A945F415A0DC510668F574E2217ED) |
| The merchant's system confirms with a wrong token | `HTTP 403 {"error":"bad token"}`, escrow still waiting |
| Right token, order record hashed (`8fb00a23…`): the oracle finishes with the order hash in a memo, decoded back from the ledger and equal to the record's SHA-256 | `tesSUCCESS` [A9A9370A…](https://testnet.xrpl.org/transactions/A9A9370A083F7502A632BBC7F5DB4B247C2A0DC395EE495851746F4244248AAA) |
| Affiliate, escrow 2: no sale before the deadline, the oracle refunds the merchant | [87A22223…](https://testnet.xrpl.org/transactions/87A2222325296812EC5DAE6EDC56E97F4B54A2B0AD750CA383911145C7A7E11D) |
| Freelance regression on the same code: wrong file, stranger without the secret `tecCRYPTOCONDITION_ERROR` [EEE21FE0…](https://testnet.xrpl.org/transactions/EEE21FE00E7016BC60DF9B4E1E8465BEC5E0B7630A40355C19B2B50A02C4333B), right file paid, nothing published refunded | [D4FF12DA…](https://testnet.xrpl.org/transactions/D4FF12DA121ED1C494ACD6329507C379CA1716DFC0CA300FC0F35E5D7B452212), [7DE73379…](https://testnet.xrpl.org/transactions/7DE733794C1AF43BAF0F5F9D639D11D7E5F57A928DF265BA44B377FEDDD77AE8) |

What changed in the oracle to carry four shapes: a `KINDS` table (what `/condition`
agrees to, which `/watch` fields are required, how to probe, how to decide, what
memo to add), one conditional handler for the three conditional shapes, and a
registry that merges the entries a pass touched instead of overwriting the file —
`/affiliate/confirm` and `/watch` write it while a finish is in flight. The payroll
branch is the one measured on the real device, untouched.

## Privacy — invisible to the public, visible to the administration

The founder's rule for a salary: nobody in the street may read it, every administration
(tax, social security) must be able to. An XRPL escrow is transparent by construction —
the two accounts and the XRP amount are public — so privacy is a layer on top, in three
mechanisms that stack, each hiding a different thing. All three are real code, run and
measured tonight; the long version with every measurement is in [zk/README.md](zk/README.md).

| Layer | Hides from the public | Leaves visible |
|---|---|---|
| **A. Unlinkable payee** — the employee is paid to a fresh account per pay period, derived from the employee's own Ledger (`44'/144'/<period>'/0/0`, `agent/compte_periode.mjs`) | *who* is paid: no account carries a person's pay history | that an escrow exists between two addresses |
| **B. Selective disclosure** — `agent/confidentiel.mjs` seals the statement with AES-256-GCM (padded to a 1 kB class), the content key wrapped with X25519 + HKDF for two readers only: the employee and the administration. On the chain, hashes. `agent/divulgation.mjs --role administration` decrypts, recomputes the SHA-256, compares it with the escrow's memo and prints the statement; `--role public` shows what anyone sees and fails to open anything; `--role employee` the same as the administration, with the employee's key | *what*: the name, the hours, the lines, the total in dollars | a 3 072-byte opaque file and an empreinte |
| **C. Zero-knowledge compliance proof** — `zk/circuit/src/main.nr` (Noir, compiled and proven in WebAssembly with `@noir-lang/noir_wasm` and `@aztec/bb.js` 5.2.1, no binary installed) proves that the total is exactly the collective agreement's formula for *some* admissible hours, coefficient and seniority, and that the prover knows them behind a Pedersen commitment that also binds the statement's SHA-256; the commitment rides in the escrow as a memo (`dareskro/zk-commitment`) | *why it is right*, without the payer disclosing anything: the proof itself reveals nothing but "lawful under IDCC 1996" | the total, the Sunday/shutters context, the point value — all public already |

Measured, 24/10/2026 (arm64 Mac, Node 26, one wasm thread): compile 0.42 s, witness 33 ms,
**prove 0.9 s, verify 15 ms**; proof 14 656 bytes, verification key 3 680 bytes; `node
prove.mjs` 2.0 s wall clock, `node verify.mjs --escrow …` 0.3 s plus the testnet read.
Tampering with the public total, the statement hash, one hex digit of the proof or of the
key: rejected, exit 1. One character of the ciphertext: GCM refuses. The circuit's integer
arithmetic was replayed against the payroll engine on 1.1 million cases (two independent
reimplementations) and agrees on every statement with at most 43 h already worked in the week;
beyond that the engine's overtime rule differs and `prove.mjs` refuses rather than guess.

**The honest measurement, said before the jury asks.** With a public amount and a public
formula, the proof cannot hide the inputs from arithmetic: `verify.mjs` counts the (hours,
coefficient, seniority) triples that give 466.57 — **11** — and a readable statement id in the
memo (`garde-2026-10-25-coef600`, what the first escrows carried) left **1**. So: the proof
guarantees compliance and binds the person's commitment; the amount is the leak, not the
proof. Two fixes, both done tonight: the statement id written in the memo is now opaque
(`stmt-<12 hex>`), and the proof binds to the escrow by the statement hash and the commitment
memo, not by amount alone. The amount itself disappears with **XLS-0096 Confidential
Transfers** (spec Final, 10/09/2026; EC-ElGamal on secp256k1, Pedersen commitments,
Bulletproofs; the issuer registers an `AuditorEncryptionKey`, so every hidden amount is also
encrypted to the auditor — "visible to the administration" natively): the amendment
`ConfidentialTransfer` is in rippled but not yet active on mainnet or testnet (22 validators
of 29 in mid-October), and its first version excludes escrow. Until then, pooling several
periods into one payment is the other way to make a total uninformative.

Measured end to end on testnet, 24/10/2026 22:10 UTC (`oracle/demo_confidentialite.mjs`,
capture in `presentation/demo-terminal/capture/confidentialite_v1.log`): a pay escrow of
361.127881 XRP (466.57 USD at 1.29198) to a fresh employee account, whose memos leak nothing.

| Step | Proof |
|---|---|
| `EscrowCreate` #21797423: statement SHA-256, **opaque id** `stmt-ffff3dd0e216`, fiat at rate, oracle, **zk commitment** `0x26ab993a…` | [7ED9282F…](https://testnet.xrpl.org/transactions/7ED9282F5057807C852A0E6DDE24B2C35A5160E03C8BE6A01BFA94763CB9D570) |
| The statement sealed for the employee and the administration, bound to that escrow: 2 987 bytes → 5 837-byte file, ciphertext 3 072 bytes, two wrapped keys | `agent/sortie/bulletin.chiffre.json` |
| The public reads the file and the chain: two addresses, the amount, five memos, an opaque ciphertext; a random key is refused | `RESULT: OK, the file and the escrow show the public nothing private` |
| Anyone verifies the proof against the chain: statement memo = the proof's public hash, zk-commitment memo = the proof's commitment, 361.13 XRP × rate = 466.57 | `proof VERIFIED in 15 ms`, `RESULT: OK`, 11 candidate triples printed |
| The administration opens it with its key: hash recomputed = memo, statement printed (employee, hours, four lines, 466.57 USD) | `bound to escrow 7ED9282F…: MATCH` |
| The oracle releases at the date: the employee holds 461.127881 XRP | [C38552EE…](https://testnet.xrpl.org/transactions/C38552EEFB074CF3668B14D4F182BE03AAFA0BD5748D00AA344ADE3D77AB3504) |

Re-run on Sunday 25/10/2026 09:45 UTC with the one-day contract and the contributions
(`presentation/demo-terminal/capture/confidentialite_v2.log`; the Saturday run is kept as
`confidentialite_v1.log`): gross 564.55, two escrows locked together, both released by the oracle.

| Step | Proof |
|---|---|
| Pay escrow #21810200: the **net** 440.35 USD = 341.565765 XRP to a fresh employee account; memos: statement SHA-256 (b0c852de…), opaque id, fiat at rate, **`dareskro/gross` = gross 564.55, net 440.35, employee rate 0.22**, oracle, zk commitment 0x02d19cac… | [19321151…](https://testnet.xrpl.org/transactions/193211513A5B84F6068CFFF2C1F76B97227652B7F52F9C64D9DDACE5C11D3C6A) |
| Contributions escrow #21810201: 361.31 USD = 280.256902 XRP to a stand-in account for URSSAF, due 2026-11-15 (here 30 s after the pay); memos: statement hash, **`dareskro/urssaf`** (employee 124.20 + employer 237.11, period 2026-10, due date), fiat at rate, oracle | [954CF856…](https://testnet.xrpl.org/transactions/954CF85662F88169C3C67B33A54AA5799003F574C8A9DEBB69C33C682475C7AB) |
| The public reads both files and the chain: nothing private; the proof verifies and binds by hash, by commitment, and **by amount through gross − 22 % = net** | `RESULT: OK` twice |
| The administration opens the statement: hash = memo, fiat memo = net, gross memo = gross and net, six lines, net, URSSAF | `bound to escrow 19321151…: MATCH` |
| The oracle releases the pay at the date, then the contributions at the due date | [A0FF2CAF…](https://testnet.xrpl.org/transactions/A0FF2CAF3CF2C167701ECBAC153350339311E8252DD3A1CA19B715F085D33E69), [89EAB200…](https://testnet.xrpl.org/transactions/89EAB200EC0F6B9D408F57B2DC66F8D60EC14C94846852A723B8E377C2C87464) |

And the same run **from the pay desk**, Sunday 09:51 UTC, test wallet, one signature session
for two escrows, the employee paid in dollars: pay escrow #21810279
[33823638…](https://testnet.xrpl.org/transactions/3382363811F4C840F80780B9B339B97C6519E7ED62CDACB87BCF72EC86C20A21) released by the oracle
[1F93F19B…](https://testnet.xrpl.org/transactions/1F93F19B101B18664B186C7BAAF09194BDC175EF37F00D5CC7048D34676B15B7) then
4.40 RLUSD settled through Mastercard AP4M (1/100 of the net 440.35:
[0x1a5506ad…](https://explorer.testnet.xrplevm.org/tx/0x1a5506adc447a9de190cd561a070ea20ee5c156c421a4ada3668957c58df31dc));
contributions escrow #21810280 [7780DEBB…](https://testnet.xrpl.org/transactions/7780DEBB83FFAAD0ACDB607BD8FD10767DA7603D54839D9DFE0EA09C964EF17B)
released to the URSSAF stand-in 30 s later
[CFD2DE92…](https://testnet.xrpl.org/transactions/CFD2DE92650D885BAED93D5CC3BF7B95AF1421BC5FAD64630ADB42250890A404).
The statement was sealed for the two readers, bound to the pay escrow, from the desk's Privacy card.

Re-run on Sunday 25/10/2026 10:23 UTC with the income tax and **one signature for the three
legs** (`presentation/demo-terminal/capture/confidentialite.log`; the one-approval-per-transaction
run of 10:15 UTC is kept as `confidentialite_v3_pertx.log`):

| Step | Proof |
|---|---|
| **Batch, one signature, three inner transactions, all or nothing** (XLS-56, `tfAllOrNothing`) | `tesSUCCESS` [80BBBB36…](https://testnet.xrpl.org/transactions/80BBBB36088BC2BDEEAE095D99501821AC7B52443ED3AADD5B243DF44928F393) |
| inner 1 — pay escrow #21810889: the **net paid** 407.32 USD = 315.14 XRP to a fresh employee account; memos: statement hash (ede5c5fd…), opaque id, fiat at rate, `dareskro/gross` = gross 564.55, net 440.35, employee rate 0.22, tax rate 0.075, paid 407.32, oracle, zk commitment 0x29534add… | [1FE4BFC0…](https://testnet.xrpl.org/transactions/1FE4BFC0C3DF654982F5D08F95098C3D06E6465C443BAD7D5687AD24ADE20E6B) |
| inner 2 — **Check** #21810890 for URSSAF: up to 361.31 USD = 279.55 XRP, `InvoiceID` = the statement hash, expires 10 min after the due date | [E4AAF2B8…](https://testnet.xrpl.org/transactions/E4AAF2B8EFCDD98AEEA72A33773F878D8F478CEF9A0926B6C82E17E32BC09E9E) |
| inner 3 — tax escrow #21810891: the income tax withheld, 33.03 USD = 25.56 XRP to DGFiP, FinishAfter = the due date | [44CA07EA…](https://testnet.xrpl.org/transactions/44CA07EA5C07BD26AB3D46061B7CCB4475BFEE93B2376A9C001) |
| The public reads the file and the chain: nothing private; the proof verifies and binds by hash, by commitment, and by amount through gross − 22 % = net, net − 7.5 % = paid | `RESULT: OK` twice |
| The administration opens the statement: hash = memo, fiat memo = net paid, gross memo = gross, net, paid; six lines, contributions, tax, URSSAF, DGFiP | `bound to escrow 1FE4BFC0…: MATCH` |
| **URSSAF cashes its check itself** at the due date, with its own key (`CheckCash`) | [AF896B56…](https://testnet.xrpl.org/transactions/AF896B563E7D796C040FE67FDDF4FACBB68E3F56645B0BF2678186CB78CA647B) |
| The oracle releases the pay at the date, then the income tax to DGFiP at the due date | [D7CADBD4…](https://testnet.xrpl.org/transactions/D7CADBD47257BEA4B2E0A8EE2AC4CD5FB6650001E0638126070C6DC778097187), [148B533C…](https://testnet.xrpl.org/transactions/148B533CD64F96E6201FF926183270A5BB1E04A9B43E2BE1419B8A71E1487E9B) |

From the pay desk, same morning, test wallet: one click on "Sign once on the Ledger (Batch)",
Batch [CEF73AAD…](https://testnet.xrpl.org/transactions/CEF73AAD0D33F52333C4657F2773578A1982348FF338E4366B39496283C3883B)
`tesSUCCESS` with the pay escrow, the Check and the tax escrow inside, then the button
"URSSAF cashes its check": `CheckCash` [31C16FFF…](https://testnet.xrpl.org/transactions/31C16FFF95357AA098FB5C2AB0FE1F6E144649E1C181F2790493FF963CCD1973).
Second desk run at 10:28 UTC, after the inner sequences were renumbered (the first
run had watched the Batch's own sequence): Batch [9E38E027…](https://testnet.xrpl.org/transactions/9E38E0273305951D943FD367BC111A57A0A905B51FFA3A13BE2C94427B91BF7B)
with pay escrow #21810938, Check #21810939 and tax escrow #21810940 inside;
`CheckCash` by URSSAF [E9B92D54…](https://testnet.xrpl.org/transactions/E9B92D54DDE5681D4709B948AC6EE7FEB65B7384A065E0D41715CA6DD10CFFCD);
the oracle released the pay at 10:29:24 [3D7B3308…](https://testnet.xrpl.org/transactions/3D7B3308CD7F200BBD7FD8F20EE57FF953BD8B55C826C777F42CFA7E8655BE26)
and the income tax to DGFiP at 10:29:55 [65248360…](https://testnet.xrpl.org/transactions/65248360031CABB75F1790328DBECFA5F28E7D494A80530A251B74E12A522E7F).
The dollar leg of that run met the sandbox budget: at 10:29 the payout found 2.82 RLUSD
unassigned for 4.08 needed and stopped ("ask the organizer to fund the team"); the
payout was then taught to read the budget first and settle one notch smaller, and
`POST /payout/retry` at 10:37 settled **0.41 RLUSD at 1/1000**, written in the record,
on the existing Channel 0xe2c30cf9…: `VoucherRedeemed`
[0x24374e5e…](https://explorer.testnet.xrplevm.org/tx/0x24374e5ef554b9b73528234e7f0e3246424dc86d714560e1bdf72fac54032604),
settlement 0x22e123b7…, payout 0xf8da93b8…, receipt
[claims/0xbe2ede57…/0xadbf78e6…](https://hackathon.ap4m.build/public/evidence/claims/0xbe2ede5761bd7ea40e6362a7af76a5efa7f1e604104c4bd4f8a4ddbabb50a92c/0xadbf78e6e4e760cebb12bba3db46fb069339d85c2554fbcf43cb269f00a628b4.json)
verified with `verify-receipt.mjs` (`verified: true`, amount 0.41, payout wallet
0x1f9265e1…; `presentation/demo-terminal/capture/recu_pupitre_batch.log`). Then
`channels-close.mjs --keep 0xe2c30cf9` closed the two near-empty Channels
(0x125490fb… at 9.34 redeemed, 0x32b199da… at 4.40 redeemed: 0x5434ac29…, 0x9323e003…),
giving 1.44 RLUSD back: 20 allocated, 14.30 spent, 1.44 held, **4.26 free** for one
more payout at 1/100.

### Live with the Mastercard engineer, 15:38 UTC — the dollar leg at 1/100, and a resume

Run from the terminal in front of the Mastercard engineer, on the pay escrow of the 14:35 run
(`EscrowFinish` 235B2CF8…, 407.33 USD): the payout read the budget (20 allocated, 14.30 spent,
1.44 held, 4.26 free), opened Channel 0xa4b92b60… with a 4.26 RLUSD cap and paid **4.07 RLUSD
at 1/100**. The voucher was redeemed on chain at once
([0xbe6bc867…](https://explorer.testnet.xrplevm.org/tx/0xbe6bc867f39a949d5965075f0c60eaa2378c43fc11d338da53b5c84facbab9c0))
but the purchase outcome came back `503`: the script stopped without signing anything else.
The first retry exposed a flaw: it re-read the budget (now 0 free), scaled to 1/1000 and clashed
with the first attempt's merchant store (`409`). Fixed on the spot (commit de8ef6d): a pending
attempt is read before the budget and resumed at the price it was signed for. The second retry
resumed — "its voucher is already redeemed on chain: collecting the result, nothing is paid
twice" — and collected the resource. The settle call then failed to fetch (the laptop changed
Wi-Fi), so the settlement was read back from the chain: claim paid
[0x718dd5df…](https://explorer.testnet.xrplevm.org/tx/0x718dd5df4b269b8f096cc11302161557a0b3949d10e695893529ecb52a22f2b8),
settlement recorded
[0x60a28968…](https://explorer.testnet.xrplevm.org/tx/0x60a28968cf9bb96b67e4ca1dfda3844d7ebd4bbc2700487a41378b17c883040c),
receipt
[claims/0x0f424d47…/0xf37082fc…](https://hackathon.ap4m.build/public/evidence/claims/0x0f424d47e76d0960bf43c3e24af5d27d6c342a5443640adc20b0ca73c12153fd/0xf37082fcbaaf9184029e06436b2383358a761c12d0188214263d424d465dde1b.json)
verified with `verify-receipt.mjs` (`verified: true`, 4.07 RLUSD to 0x1f9265e1…;
`presentation/demo-terminal/capture/recu_live_mastercard.log`). Budget after: 18.37 of 20 RLUSD
spent, 0.19 + 1.44 held in two open Channels, nothing free — the next payout settles at 1/1000
by itself, unless the team allocation is topped up.

### Run with the regenerated statement, 14:35 UTC (script, after the rounding fix)

Same script (`oracle/demo_confidentialite.mjs`, capture
`presentation/demo-terminal/capture/confidentialite_arrondi.log`), statement **384ec59c…**
(shift 466.58, gross 564.56, net 440.36, net paid 407.33, URSSAF 361.32, DGFiP 33.03),
commitment 0x20613f4b…, 4 compatible triples:

| Step | Result |
|---|---|
| **Batch, one signature, three inner transactions, all or nothing** | `tesSUCCESS` [443DBC60…](https://testnet.xrpl.org/transactions/443DBC6026CCE1100AC6D7EB04C7D4029CBC4F2F08B0057469CF014668044BCE) |
| inner 1 — pay escrow: the **net paid** 407.33 USD = 315.500441 XRP at 1.29106; memos: statement hash 384ec59c…, opaque id, fiat, `dareskro/gross` = gross 564.56, net 440.36, employee rate 0.22, tax rate 0.075, paid 407.33, oracle, zk commitment 0x20613f4b… | [99DBC2B3…](https://testnet.xrpl.org/transactions/99DBC2B3F8DCB1F50BAC12F12B34B0DD5E85A264FC9FAB8095D5A27A32BD2972) |
| inner 2 — **Check** for URSSAF: 361.32 USD, `InvoiceID` = the statement hash | [7AF31E37…](https://testnet.xrpl.org/transactions/7AF31E37EA05918D22DAEC6A537CC78A22951A30DF09529B673E2CEDD0412605) |
| inner 3 — tax escrow: 33.03 USD to DGFiP, FinishAfter = the due date | [C1C3720B…](https://testnet.xrpl.org/transactions/C1C3720B90A2885C3D6A6CE72959EE8C454CAFF63FF33639A31CB02A67F7933D) |
| Public verification: hash, commitment and amount bound (gross − 22 % = net, net − 7.5 % = paid) | `RESULT: OK` |
| The administration opens the statement: hash = memo, fiat memo = net paid, gross memo = gross, net, paid | `MATCH` |
| **URSSAF cashes its check itself** at the due date (`CheckCash`) | [A2B3CAF0…](https://testnet.xrpl.org/transactions/A2B3CAF0EC7FEC366BE40469F67A37CD30DBB3D8173898885F8AECD1B9EFB201) |
| The oracle releases the pay, then the income tax to DGFiP | [235B2CF8…](https://testnet.xrpl.org/transactions/235B2CF8D5DDA16B9D693BE6C25225BD1BF8E066F12B7E2DD49EEE83B0AD65DC), [A96035DF…](https://testnet.xrpl.org/transactions/A96035DFDC9E56A34FBBE442F423D9C87FC7E6CACD873FAB405D18457CD6BFF0) |


One more thing said plainly: this repository publishes the demo statement itself
(`agent/sortie/bulletin.json`, served by the desk as `/bulletin.json`), because it is the
input of every demo and the employer — who is the prover — reads it on the desk. The privacy
layer is about what leaves the employer's machine: the chain and the sealed file. In a
deployment the statement stays with the employer, the employee and the administration; the
repository would carry a fictional one, as this one is.

The desk's **Privacy** card (card 6 of the employee flow) talks to
`agent/service_confidentialite.mjs` (127.0.0.1:8788): it seals the statement bound to the
escrow just created, and shows, in the three readers' own words, what the public sees, what the
administration opens, what the employee opens, and the proof verified against the chain.

## Mastercard — the agent pays for its evidence (Agent Pay for Machines)

The salary goes through the XRPL escrow. But before the engine can price the
shift, the agent needs the current collective-agreement parameters: point value,
seniority tiers, Sunday allowance, overtime thresholds. That is data a provider
keeps current and sells per query. On AP4M the agent pays for it **by itself,
inside a budget a human set**:

1. **Channel.** The employer funds the team budget from the funding wallet and the
   agent opens a Channel with a cap (2 RLUSD here). The cap is the employer's
   decision; the agent cannot exceed it.
2. **402.** The agent calls the rules service (`ap4m/merchant.mjs`, GET
   `/resource`). The service answers `402 Payment Required` with a
   `PAYMENT-REQUIRED` challenge.
3. **Voucher.** The agent signs an EIP-712 Voucher for the cumulative amount
   (0.05 RLUSD a query) and retries with `PAYMENT-SIGNATURE`. No human clicks.
4. **Redemption.** The service redeems the Voucher on the PaymentLedger contract
   (XRPL EVM testnet, chain 1449000): `VoucherRedeemed` is on the explorer. The
   agent verifies the exact redemption before trusting the resource.
5. **Settlement.** AP4M moves RLUSD from the escrow vault to the merchant payout
   wallet and issues a verifiable receipt.
6. **Load-bearing.** The agent writes what it bought to
   `agent/sortie/regles_achetees.json`; `bulletin_garde.py` prices the shift with
   the purchased point value and records the purchase in the statement
   (`rules_source`), which the pay desk shows next to the lines. With
   `--exige-achat` the engine refuses to compute without a purchase.

Boundaries: the agent spends only inside the cap; the agent never touches the
salary (that is the device-signed escrow); every purchase leaves an on-chain
event and a receipt. Team `dareskro`, agent wallet (MetaMask, registered by the staff) `0xC3027DE9…aC7`,
merchant payout `0x1f9265e1…f323`. Keys live in `ap4m/.env`
(0600, never committed).

```bash
cd ap4m
# the Mastercard AP4M hackathon SDK is "for hackathon use only" and is not redistributed here:
# download it from the portal into ap4m/ (and the package into ap4m/vendor/), then install
curl -sO https://hackathon.ap4m.build/sdk/ap4m-hackathon-sdk.js && mv ap4m-hackathon-sdk.js ap4m-hackathon-sdk.cjs
curl -sO https://hackathon.ap4m.build/sdk/ap4m-x402.mjs && curl -sO https://hackathon.ap4m.build/sdk/verify-receipt.mjs
mkdir -p vendor && curl -so vendor/sdk_ap4m-sdk.tgz https://hackathon.ap4m.build/sdk/ap4m-sdk.tgz
npm install                            # ethers 6.17 + @ap4m/sdk from vendor/
node merchant.mjs                      # the rules service, 127.0.0.1:4308
node agent.mjs                         # sign in, Channel, 402, Voucher, settle
../.venv/bin/python ../agent/bulletin_garde.py --exige-achat   # price the shift with what was bought (needs the private engine; the shipped bulletin.json already carries this purchase)
```

### Measured on XRPL EVM testnet, 24/10/2026 17:43–17:45 UTC, nobody clicked

| Step | Proof |
|---|---|
| Team `dareskro` active, 20 RLUSD allocated by the organizer; merchant registered on-chain | `registerMerchant` [0xb3be482d…](https://explorer.testnet.xrplevm.org/tx/0xb3be482df16e55fb39049dfd09402edc7c3e905c4f229990ee7590e8a5722da7) |
| Gas for both wallets bridged from the XRP Ledger testnet through Axelar (the EVM faucet was gated) | XRPL [A1F72873…](https://testnet.xrpl.org/transactions/A1F72873F17E8CA00679924C5D4F08E36D0B87E310C25D02CE3C33A2928FF5EE), [A98D843B…](https://testnet.xrpl.org/transactions/A98D843B9B44BFAF7459A10726C1A4DEC0A9C7FC0092110C3A45F91480AB2D23): 43 XRP each after 40 s |
| Channel opened by the agent, cap 2 RLUSD (the employer's budget for this agent) | `0xe2c30cf9c897c60e8a6e9d471f4d6a9da1fe9264b482dfc4c6317bbc3813ccb0` |
| GET `/resource` → `402` → EIP-712 Voucher signed by the agent → redeemed by the merchant, **`VoucherRedeemed`** | [0xf6b37003…](https://explorer.testnet.xrplevm.org/tx/0xf6b370033501d60560c010a7ed3811883d0192de702d8ffd6da98d9ea5858922), 0.05 RLUSD |
| Settlement: RLUSD from the vault to the merchant payout wallet, balance now 0.05 RLUSD | settlement [0xe87d84aa…](https://explorer.testnet.xrplevm.org/tx/0xe87d84aa187f18905ffdb3795ca26ca014c7608e154185fa28e8f2ad3181f9ec), payout [0xf6fc32f8…](https://explorer.testnet.xrplevm.org/tx/0xf6fc32f89560883ea15535c05b07f03caf4a1ab0064fd1cf5931661274cd91c7) |
| Verifiable receipt (`ap4m.claim-receipt.v1`), checked on-chain with `verify-receipt.mjs` | [claims/0xeca2dabf…/0x234af26d….json](https://hackathon.ap4m.build/public/evidence/claims/0xeca2dabf6d5669d2a69499da4108cb1e667db2028552a683d0e92d843eea8584/0x234af26dbbac13f4ae0efa921a18b65a866ed386a062fa357ea5413af4e9d0b3.json) |
| The purchase in the pay statement (`rules_source`): the point value used is the one that was bought | `agent/sortie/bulletin.json`, shown on the pay desk next to the lines |

### The dollar leg, triggered by the oracle — 24/10/2026 20:28 UTC

The employee of escrow `#21789944` (employer `rGJsjkfmASA2ezXYDpTQJZDp9tRgCJAPhw`,
466.57 USD = 361.141858 XRP at 1.29193) had chosen **dollars**. The oracle
finished the escrow at the date, then ran `ap4m/payout.mjs` by itself.

| Step | Proof |
|---|---|
| The ledger releases: `EscrowFinish` by the oracle, `tesSUCCESS` | [D749E538…](https://testnet.xrpl.org/transactions/D749E538E2BC6A969CF4CBE516AEDA038C271E81992179D96747CFFC36239C21) |
| `payout.mjs` re-reads that transaction on XRPL (`tx`, validated, `EscrowFinish`, `tesSUCCESS`) before anything else; a one-shot "payslip settlement" merchant is priced at 4.67 RLUSD (1/100 of the pay, sandbox budget) with the finish hash in its content | the merchant's content, returned with the purchase: `resource` in `agent/sortie/payout.json` |
| The agent answers the 402 with a signed Voucher inside the employer's channel, the merchant redeems it: **`VoucherRedeemed`**, 4.67 RLUSD | [0x7e124666…](https://explorer.testnet.xrplevm.org/tx/0x7e124666074a614917d1d7cd679d55784d3ab2b3bd63691a54454251dc05a431) |
| Settlement and payout: RLUSD to the employee's payout wallet, 4.77 → 9.44 RLUSD | settlement [0x2e10a168…](https://explorer.testnet.xrplevm.org/tx/0x2e10a168e142fc749fc71543527c59cfdc5066c01ed8e6056027f6d884a7cab2), payout [0x83310afd…](https://explorer.testnet.xrplevm.org/tx/0x83310afd9aff69059f4a31300ea061d8f2f5889796997933db0a692e365877a8) |
| Mastercard receipt (`ap4m.claim-receipt.v1`), with the payout observation | [claims/0xf4470eea…/0x6764e0ad….json](https://hackathon.ap4m.build/public/evidence/claims/0xf4470eea92e6363f93031203cad3d3163bb19f44bc102c3ca55eb2cb0351f3fd/0x6764e0ad071e562281d1a1b312f8555e0f28d3b1689720c67825c89b79968013.json) |
| The oracle's own log and registry (`payoutResult`), shown on the pay desk | `20:28:03 escrow #21789944: 4.67 RLUSD settled via AP4M` |
| The payout receipt checked on chain with Mastercard's `verify-receipt.mjs`: `verified: true`, amount 4.67, payout 0x83310afd…, settlement 0x2e10a168…, against ledger 0xcAB42800…, vault 0x83DD9cD0…, RLUSD 0x27b57a9D… | `presentation/demo-terminal/capture/recu_paie.log` |

### The spend limit, enforced — 25/10/2026 00:28 UTC, two over-cap attempts refused

Mastercard's own demo blueprint asks for an over-cap attempt rejected. `ap4m/plafond.mjs`
stages two, on purpose, and pays nothing (`presentation/demo-terminal/capture/plafond.log`):

| Attempt | Refused by | Words |
|---|---|---|
| Pay the payslip, 4.67 RLUSD, on the channel `0x125490fb…` that has 0.66 RLUSD left (cap 10.00, redeemed 9.34) | the Merchant (payee facilitator), reading the channel on chain: it issues no 402 challenge for a price the channel cannot cover | `HTTP 503: payment_pending_or_unavailable` — and had a challenge been issued, the kit refuses to sign a Voucher above cap: `settled ≤ redeemed ≤ cap`, 9.34 + 4.67 = 14.01 > 10.00 |
| Open a new channel with a 52.82 RLUSD cap while the team's limit is 20.00 and 2.82 is unassigned | the platform (the Authorized Spend Limit) | `channel request failed (400): cap exceeds the unassigned deposit (2.82 RLUSD available)` |

The agent cannot spend beyond what the employer funded, at either layer, and no signature exists that could.

One honest detail, and the rule it produced. The first attempt (20:12 UTC) *was*
redeemed on chain, but the script died before collecting the proof, leaving the
kit's `purchase.json` unresolved; the kit then refuses any other purchase until that
one is "resumed with its original arguments". `payout.mjs` now reads the chain
first: if the channel's redeemed amount already covers the pending voucher, it
resumes and collects — nothing is signed, nothing is paid twice; if the voucher was
never redeemed and its channel can no longer hold it, it is set aside on disk
(`abandoned-*.json`) and a fresh one is signed. Idempotence is the whole safety of
a payout agent, and the chain, not a local file, is the source of truth for it.

## Run it

```bash
# 1. the statement — already computed: agent/sortie/bulletin.json and app/public/bulletin.json
#    ship with the repo. agent/bulletin_garde.py is the agent's code; it imports the payroll
#    engine (officine.garde), prior work that is not in this repository, and says so if run.

# 2. the oracle (Node 22+): create it once, then let it watch
cd oracle && npm install && node oracle.mjs create && node oracle.mjs watch

# 3. the pay desk (Node 22+, Chrome/Edge/Brave for WebHID), in another terminal
cd app && npm install && npm run dev            # http://localhost:5173

# 4. Mastercard AP4M (optional): download the SDK as shown in the AP4M section above, then
cd ap4m && npm install && node merchant.mjs     # and node agent.mjs, node payout.mjs …

# 5. the privacy layer: keys for the two readers, the proof, the service behind the Privacy card
node agent/confidentiel.mjs --init && (cd zk && npm install && node prove.mjs)
node agent/service_confidentialite.mjs            # 127.0.0.1:8788
node oracle/demo_confidentialite.mjs              # the whole layer end to end on testnet, no device
```

On the page: validate the statement with your name → connect the Ledger (USB)
with the XRP app open → get the employer's address → fund it from the faucet
(the page asks the faucet until it holds enough: about 100 XRP per call) →
create a test employee → Prepare → **Sign on the Ledger** → Submit → run the three
proofs. "Test wallet (no device)" is a rehearsal mode signed by xrpl.js; it is not
what the bounty asks for.

No device? Clone Ledger's workshop, `git clone https://github.com/LedgerHQ/device-management-kit-ts-workshop ledger-workshop`,
run `ledger-workshop/xrpl-hackathon/speculos/run-speculos.sh stax` (needs Docker; colima on a Mac)
and choose the Speculos transport. The terminal demo (`app/scripts/demo-terminal.mjs`) drives the same emulator with `nanox`.

## Honest limits, said before the jury asks

- In France an employee's pay must go through a payslip and a bank transfer
  (C. trav. L3241-1). For employees dareskro is the **proof layer**: timekeeping,
  replayable calculation, named validation, on-chain anchoring. For non-employees
  (freelancers, agents, affiliates) it is the **payment channel** itself.
- The badge proves presence, not the nature of the hour. Anything the schedule
  does not cover goes to "to decide", for a human.
- RLUSD escrow waits for its issuer's flag. XRP, or any issuer with the flag, works today.

## Disclosure

Prior work and third-party software, per the rules: XRPL escrow core and payroll
rules written before the event (see above, not in this repository); Ledger Device
Management Kit, XRP signer kit, and Ledger's workshop app
<https://github.com/LedgerHQ/device-management-kit-ts-workshop> (Apache-2.0: the files
copied or derived are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md), license
copy in [LICENSE-APACHE](LICENSE-APACHE)); Mastercard's AP4M hackathon SDK (not
redistributed); xrpl.js; React/Vite. This repository is under the MIT license
([LICENSE](LICENSE)). Built with AI assistance (Claude), used as a tool by the team.
