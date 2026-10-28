# dareskro — final pitch (Sunday 25 Oct, 2:00 PM, ~3 min)

Jury scores: Idea 25 % · Implementation 25 % · Demo quality 25 % · Potential 25 %.
Only what was built during the 36 h counts. Say clearly what existed before and what is new.

**Code (public, weekend only):** https://github.com/LeDenti/dareskro — README with every measured hash, LEDGER_FEEDBACK.md, THIRD_PARTY_NOTICES.md.

---

## 0. Hook (15 s)

Hi, I'm Julien. I'm a pharmacist from Marseille, and I own my pharmacy.
Every month I pay people whose work I can't fully verify: a Sunday shift, a freelancer, a real-estate agent on commission.
And every month, someone, somewhere, is chasing a payment.
Dareskro fixes that on the XRP Ledger. No middleman, no custody, and this weekend: no manual calculation either.

## 1. Idea (30 s)

Dareskro is escrow between two parties who agree on the rules up front.
The payer locks the money. The ledger enforces the rules. A third party, or simply the date, releases it.
Nobody holds the funds. Not a platform, not a bank, not us. That's the whole promise, and it's why we refused to build a bridge.

This weekend we added the agentic layer, for the Agentic Finance track and the Ledger bounty:
an AI agent gathers the evidence, deterministic code computes the amount, a human signs on a Ledger device, and the chain pays.
The AI never touches the money. It reads. The code calculates. The human decides.

## 2. What we built in 36 hours (45 s)

Before this weekend, we had the escrow core on testnet: EscrowCreate and EscrowFinish, tesSUCCESS, and two hard lessons.
The beneficiary must open a trustline first, or a third party cannot finish the escrow. And RLUSD could not be escrowed when we measured, because its issuer had not enabled trustline locking.

What's new, built here:
- the agent: reads the schedule and the badge log, retains the planned hours the badge covers, flags the rest "to decide" — the badge never qualifies an hour
- the statement: a 466.58 shift (four lines with their sources, each rounded to the cent and added), a one-day contract → gross 564.56, net paid 407.33; SHA-256 fingerprint; status PROPOSITION until a named person validates
- the pay desk: EscrowCreate with FinishAfter only, hash in the memo, built for the device and signed on the Ledger (DMK + XRP signer kit, USB/Bluetooth/Speculos)
- the proofs, measured on testnet: early finish tecNO_PERMISSION, employer cancel tecNO_PERMISSION, third-party release at the date tesSUCCESS, employee credited
- device run (Ledger XRP app 2.8.1 on Speculos, Nano X, Saturday 11:25 NY): EscrowCreate 19A03F2C… tesSUCCESS after 15 review screens, with "Finish After 2026-10-24 15:25:10 UTC" readable on the device; early finish 48136EE8… tecNO_PERMISSION; employer cancel signed on device 1E08B209… tecNO_PERMISSION; release 79C97E6B… tesSUCCESS
- the oracle: a named account, rUuvu1X…, born at 15:51 UTC with a memo saying what it is; cited in the escrow (the device shows "Memo Data [3] rUuvu1X…"); second run at 15:54: it watched the date pass and finished the escrow by itself 12 seconds later (2F94E2BE… tesSUCCESS), the employer's cancel signed on the device afterwards got tecNO_TARGET — nothing left to cancel
- same run on a real Nano S Plus, Saturday 19:40 UTC, buttons pressed by the employer: EscrowCreate 5FF67E32… tesSUCCESS (405.22 XRP = 466.57 € at 1.1514), early finish by a stranger EA6790A1… tecNO_PERMISSION, employer's cancel signed on the device 71E227E5… tecNO_PERMISSION, released by the oracle 13 s after the date F61DBCD3… tesSUCCESS. One finding for Ledger: the XRP app 2.2.2 that ships on the device refuses the pre-release kit with "status 6800" — update the app and it works.
- Mastercard AP4M, twice: the agent buys the collective-agreement rules over x402 (0.05 RLUSD, 17:44 UTC), and the oracle settles the pay in dollars once the ledger has released it — Saturday 20:28 UTC, escrow #21789944: release by the oracle D749E538…, VoucherRedeemed 0x7e124666… (4.67 RLUSD, 1/100 of 466.57 $), settlement 0x2e10a168…, payout 0x83310afd…, Mastercard receipt showing the employee's wallet going from 4.77 to 9.44 RLUSD. Statement in dollars, XRP locked at the Kraken rate (361.14 XRP at 1.29193), employee's choice: crypto or dollars.
- Sunday morning: the one-day contract — end-of-contract bonus 46.66, paid leave 51.32, gross 564.56, contributions 361.32 to URSSAF, income tax 33.03 to DGFiP, net paid 407.33 (each line rounded to the cent, then added: the statement adds up on paper); one signature for three transactions — pay escrow, Check for URSSAF, tax escrow — in one Batch (XLS-56, all or nothing), measured 9E38E027… from the desk and 443DBC60… by script with the corrected statement; the dollar leg reads the sandbox budget and scales down (0.41 RLUSD at 1/1000, receipt verified)

## 3. Demo (60 s) — the thing worth 25 %

Live, on testnet. One screen, four steps, under a minute. Have a recorded fallback ready.

1. **Evidence.** "Here is a pharmacist's Sunday shift: 12 hours, schedule and badge log."
   The agent reads both and proposes: 12 hours, Sunday, coefficient 600, 18 years of seniority.
2. **Calculation.** The code computes the shift, 466.58: shift pay, overtime markups, Sunday allowance, seniority bonus. Then, because a Sunday shift by an outside pharmacist is a one-day fixed-term contract: the end-of-contract bonus and the paid-leave allowance, gross 564.56; the contributions at rates the agent bought with the point value, 361.32 to URSSAF; the income tax withheld at source at the employee's personalised rate, 33.03 to DGFiP; net paid 407.33. Every line cites its source.
3. **Human validation, one signature.** The owner reviews and signs on the Ledger device: one Batch, three transactions, all or nothing — or, if the device's XRP app does not know Batch yet, three approvals in a row, same result on the ledger. The net paid to the employee, an escrow at the pay date. The contributions to URSSAF, a Check with the statement hash as invoice: URSSAF cashes it itself, the ledger's direct debit. The income tax to DGFiP, an escrow at the due date. Nothing moves before that signature, and nothing can be forgotten or diverted afterwards: it was all locked the day the shift was validated.
4. **Release, by the oracle — then the employee's choice.** "This is the oracle: it released the net paid to the employee at the pay date; URSSAF cashed its Check itself; and thirty seconds later — the due date, in the demo — the income tax to DGFiP: the ledger paid the tax, nobody had to remember. Measured this morning, twice: from the desk, one Batch 9E38E027… locked all three, URSSAF cashed E9B92D54…, the oracle released 3D7B3308… and 65248360…; then again at 14:35 UTC with the corrected statement (Batch 443DBC60…, CheckCash A2B3CAF0…, releases 235B2CF8… and A96035DF…). And this is the oracle: a named account, cited in the escrow you just saw on the device. It watched the date pass and finished the escrow itself — here is its EscrowFinish. It paid 12 drops of fee. It never touched the 407 dollars: the ledger released the value. Now the employee chooses. Crypto: he keeps the XRP. Dollars: the oracle settles RLUSD to his payout wallet through Mastercard Agent Pay for Machines — here is the VoucherRedeemed, here is the Mastercard receipt, and the receipt carries the hash of the ledger's release. Nothing moves on Mastercard before the ledger has moved. Sandbox budget is 20 RLUSD, so this is one hundredth of the pay — and when the budget no longer fits, the payout reads it first and settles at one thousandth, saying so in its record: 0.41 RLUSD this morning, receipt verified. The mechanism is full size. The owner cannot cancel, nobody can: FinishAfter only, no CancelAfter. One possible outcome."

Point at the explorer: "That's the escrow. That's the finish. That's the memo with the hash."

## 4. Potential (30 s)

Same mechanism, four payers already modeled — and four oracles, which is the real question:
- variable pay, in a healthcare job with long, irregular hours: a pharmacist's Sunday shift, $466.58. Oracle: the date. The evidence is judged by a named human *before* the lock; after it, the oracle only has punctuality.
- a real-estate agency: an agent's share on one deed, 5,833.33 €, owed at the deed and never at the compromis. Oracle in two steps: the notary's signature on the deed releases the secret, then the official publication of the sale confirms it — neither is a party.
- a freelancer in Lagos paid by a client in Paris: the fee locked behind a secret, released on proof of delivery. Oracle: the same account, reading a public fact — the file at the agreed address has the agreed hash. Ran on testnet yesterday afternoon: wrong file, nothing; a stranger without the secret, refused by the ledger; right file, paid; nothing published, refunded at the deadline by the oracle itself. It cannot steal; it can only wait.
- an influencer placing a product: the brand locks the fee, the oracle checks that the post is live at the agreed address and still live thirty days later, then releases; deleted post, no pay. And an affiliate program with five commissions: one escrow per expected commission, released by the merchant's sales system — a party to the dispute — so the money is locked before the sale and every release carries the order hash. Or no oracle at all: the customer pays through us and the commission splits at source.

The sorting question is not "can the oracle disappear?" but "is it a party to the dispute?" An oracle with a stake is not an oracle, it's a party. Our job is to put it where it has nothing to gain — or to remove it.

The honest limit: in France, an employee's pay must go through a payslip and a bank transfer.
So for employees, dareskro is the proof layer: timekeeping, replayable calculation, human validation, anchoring.
For non-employees — freelancers, agents, affiliates — it's the payment channel itself.
That's where the volume is, and that's where a stablecoin escrow on XRPL changes who gets paid on time.

## 4b. The two partner connections (30 s) — say them by name, the judges for each bounty are in the room

**Ledger — the trust layer, not a logo.**
"The employer's approval is a signature on a Ledger device. We integrated the Device Management Kit and the brand-new XRP signer kit, pre-release: USB, Bluetooth, or the Speculos emulator. The device shows the amount, the destination, the pay date and the hash of the statement. The agent prepares, the human signs, and the same path signs the employer's cancel attempt — which the ledger then refuses. That's exactly the bounty's line: escrow-backed work agreements, approved on device. And we wrote up the developer-experience feedback: where the docs disagree with the kit, what we'd add."
[Show the device during the demo. If no device: Speculos on screen.]

**Mastercard — Agent Pay for Machines (AP4M).**
"The second half of the story is the agent paying for what it reads. Before it can price the shift, the agent needs the collective-agreement parameters — point value, seniority tiers, Sunday allowance. That's a service, and it costs 0.05 RLUSD a query. The agent opens a Channel on AP4M with the cap the employer funded — two RLUSD — calls the rules service, gets a 402, signs an EIP-712 voucher, retries, and the voucher is redeemed on the XRPL EVM sidechain: here is the VoucherRedeemed event, here is the RLUSD settlement to the merchant, here is the receipt. Nobody clicked. The agent spends inside a budget a human set, it never touches the salary, and every cent it spends leaves an on-chain proof. Machine-speed micropayments for the inputs, a human-signed escrow for the pay."
**The dollar leg, same rails.** "When the employee chose dollars, the oracle — after its own EscrowFinish, never before — opens a payslip settlement on AP4M: the agent pays the employee's payout wallet in RLUSD, the receipt carries the hash of the ledger's release. Measured at 20:28 UTC: redemption 0x7e124666…, settlement 0x2e10a168…, payout 0x83310afd…, receipt claims/0xf4470eea…/0x6764e0ad…. And one thing we are proud of: the first attempt was redeemed on chain but our script died before collecting the proof. The fix is a rule, not a retry: if the chain says the voucher is redeemed, resume and collect; never sign a second one. Nobody got paid twice. And the limit holds: we staged two over-cap attempts — the payslip on a channel with 0.66 RLUSD left, and a 52 RLUSD channel on a 20 RLUSD limit — both refused, nothing signed. And this morning the budget bit for real: 2.82 RLUSD unassigned for 4.08 needed — the payout stopped, then learned to read the budget first and settle one notch smaller: 0.41 RLUSD at 1/1000, written in the record; closing two near-empty Channels gave 1.44 RLUSD back. The payout receipt is verified on chain with your own script."

Done live on Saturday at 17:44 UTC: Channel 0xe2c30cf9… (cap 2 RLUSD), VoucherRedeemed tx 0xf6b37003… (0.05 RLUSD), settlement payout tx 0xf6fc32f8…, receipt hackathon.ap4m.build/public/evidence/claims/0xeca2dabf…/0x234af26d….json. The purchased point value and the contribution rates are the ones the statement uses: `rules_source` in bulletin.json — re-bought this morning at 09:39 UTC when the statement was recomputed with the contract (0xcb49f537…, same Channel). Side story worth 10 seconds: the EVM faucet was gated, so we bridged the gas from the XRP Ledger testnet through Axelar in 40 seconds — the two chains talk.

## 4c. What's next — asked for by XRPL Commons (15 s)

"XRPL Commons asked us for the complete payroll application. Here is the plan: the same oracle, four payers on one desk — employee, freelancer, influencer, affiliate — each with its own release rule. Built and measured last night on testnet: the influencer's fee released because the post was still live at the end of the period (D906F9CC…) and refunded when the post had been deleted (E1BA776B…); the affiliate's commission locked before the sale, refused on a wrong token, released when the merchant's system confirmed the order with its hash in the memo (A9A9370A…), refunded without a sale. Same oracle account, same device path, one desk with a case selector and a registry of every escrow. Then two things. Privacy: a salary must be invisible to the public and visible to the administration — the statement is encrypted for the employee and the administration, only hashes go on-chain, and a zero-knowledge proof lets anyone check the pay is lawful under the collective agreement without the payer disclosing anything — measured last night on escrow 7ED9282F… and again this morning on the Batch's pay escrows (1FE4BFC0…, 99DBC2B3…): the public reads nothing private, the proof verifies in about 15 ms, the administration opens the statement with its key; the amount itself will disappear with XLS-96 confidential transfers once the amendment passes. And the legal layer for France: the official payslip, the DSN declaration, the bank transfer as the dollar leg is today, and the anchoring of every statement. dareskro becomes the proof layer for salaried pay and the payment rail for everyone else."

## 4d. Fifth payer — the rental security deposit (added 27 October, after the hackathon)

"Here is the one that is not an escrow. In France, a tenant hands one month of rent to the landlord, and one lease in two ends in a fight over it. The law is precise — one month to give it back if the inventory matches, two if not, ten percent of the rent per month late, of right — and nobody enforces it.

We measured the euro on XRPL first: EURØP, Schuman's MiCA euro, is on the ledger, but its issuer has not enabled trust-line locking — bit 0x40000000, absent, same as RLUSD. So no escrow in euros today. And a deposit comes back in parts anyway; an escrow is all or nothing.

So each lease gets an account with three keys — landlord, tenant, us — and a quorum of two. The tenant opens it with the reserve and pays the deposit in; the entry inventory's hash is in the signer list itself. Then nobody can move the money alone, and the ledger says so: the arbiter alone, tefBAD_QUORUM; the landlord alone, tefBAD_QUORUM; the key that created the account, tefMASTER_DISABLED — all three measured on 27 October. If the inventory matches, landlord and tenant sign together and we are not even needed. If there is a hole in the wall and a 180 € quote, we sign 180 € to the landlord with him, and 1,020 € back to the tenant with her — the quote's hash in the memo, the deadline in the memo, the penalty computed by code, fourteen self-checks on the law before any ledger call.

The limit, said plainly: the ledger has no clock on a multisig account. The deadline is computed and written, not enforced; who was late is public forever. And before the first real euro: a lawyer's opinion on whether a key holder who cannot act alone is a 'holder of funds' under French real-estate law, a licensed partner for the SEPA-to-EURØP leg, and a three-party clause in the lease."

Measured 27/10/2026, 15:42–15:44 UTC, testnet: deposit accounts rM89zX71… (full return, FB4FCE0C…) and rndU6pH9… (180 € to the landlord 6358E670…, 1,020 € to the tenant 58F9259D…). Code: `depot/`, log: `depot/run.log`.

## 4e. Sixth payer — wedding photos sold to the guests (added 28 October)

"An agency shot two thousand photos of eighty-eight guests. A guest picks his, and for each one wants the file, or a print from a lab. One price, split by code: the agency, the photographer who took that photo, the lab with its postage. The guest signs once — one Batch, one escrow per payee — and from that second nobody holds his money: not the agency, not us.

Two ways to be paid in that one signature. The files are paid by key reveal, and there is no oracle at all: the files are boxed under a key, the escrows' condition is the hash of that key, and the only way for the agency to collect is to put the key on the ledger. Money and key change hands in the same transaction; the photographers then finish their own escrows with the key they read there. A stranger without the key: tecCRYPTOCONDITION_ERROR. The guest trying to take his money back: the same. Measured.

The prints are paid by the oracle we already have, reading a public fact: at the agreed date, the carrier's tracking page says shipped, the lab is paid; order B's page never did, and the guest got the lab's share back at the deadline. Both on testnet on 28 October: order A, 46.90 euros, four escrows, every payee paid; order B, 7.40 euros, the lab refunded.

What it is not: the lock is in XRP at the day's rate — no euro or dollar token can be escrowed on XRPL today, we measured their issuers — and a guest paying by card needs a licensed partner buying the XRP for him. The ledger side is real; the on-ramp is a partner."

Measured 28/10/2026, 05:21–05:23 UTC, testnet: Batch A 462535C4… (4 escrows), Batch B 4A9856BE… (3 escrows); stranger 87899D26… and guest B8AE0C03… refused; agency reveals the key DAC76016…, Léa 0A78BBB8…, Marc 39FB42A8…; lab paid by the oracle 11880267…, order B refunded A11F3D25…. Code: `photos/`, log: `photos/run.log`.

## 5. Close (10 s)

Dareskro: the AI reads, the code calculates, a human signs, the ledger pays.
Built this weekend on the XRP Ledger. The code is public: github.com/LeDenti/dareskro. Thank you.

---

## Likely questions

**Why not just a smart contract?** XRPL escrow is native: no contract to deploy, no contract to audit, no contract to exploit. The only logic we need is a date and a hash.

**Where is the AI, exactly?** Only at the evidence stage. A payroll must be replayable to the cent three years later; a non-deterministic model has no place in the calculation.

**Why the Ledger device?** Because the human validation is the product. The owner sees the amount and the hash on a screen the agent cannot touch.

**What about RLUSD?** Escrow of issued tokens needs the issuer's trustline-locking flag. When we measured, RLUSD's issuer had not set it. The flow works today with XRP and any issuer that enables it.

**Where is the money before the date?** In the ledger itself: an Escrow object, owner the employer, destination the employee, amount, date. Nobody can spend it — not the employer, there is no cancel date; not the employee, not before the date; not us, we never hold anything. **Does it have to be there before?** Yes, by construction: the ledger refuses the lock if the account cannot fund it on top of its reserve, so the pay and the tax are provisioned the moment the human validates — before the pay date, and before the work is judged for the freelancer, the influencer and the affiliate. The desk checks the balance first. One honest exception: the URSSAF leg is a Check, a right to pull, not a lock — the money stays with the employer until URSSAF cashes it. We did that to show the native direct debit; in production that leg is an escrow too, one line in the desk.

**Who is the oracle, exactly?** A named account on the ledger — rUuvu1X…, born yesterday at 15:51 UTC with a memo saying what it is — that watches the escrows it is cited in and submits the finish once the ledger allows it. It pays the fee. It cannot pay early (tecNO_PERMISSION), cannot redirect (no destination field in EscrowFinish), cannot cancel (no CancelAfter exists). Its whole power on a payroll escrow is punctuality. In the freelance case, with a conditional escrow, the same account holds the secret and decides *whether*; here it only decides *when*. The shape of the escrow is the policy.

**What if the oracle dies?** Anyone can finish after the date — the employee included — and the money goes where it was written. That is the test of a good oracle: it is useful and it is not needed.

**How do you verify a delivery?** By a fact anyone can re-check: a URL and a hash agreed up front, written in the escrow's memo. The oracle polls the address and reveals the secret when the published file matches. Code, files, sites, APIs: that covers most freelance work. For a logo or a text, you need a judgement — a client-acceptance portal with a written silence rule, or a panel of named arbiters. That's the site we'd build next; it plugs into the same account.

**Why a multisig account for the deposit and not your escrow?** Two reasons. The euro tokens on XRPL cannot be escrowed today — their issuers have not set the locking flag, we measured EURØP and RLUSD on 27 October. And a deposit is returned in parts; an escrow is all or nothing. Three keys, quorum two: nobody holds the money, any split is possible, and it works with the euro as it is.

**Then you hold the deposit?** No. We hold one key of three. Alone we get tefBAD_QUORUM — measured. If the two parties agree they settle without us; if we disappear they still have two keys. Useful and not needed, same test as the oracle.

**How do you sell a file without anyone holding it?** Box it under a key, make the key's hash the escrow's condition. The seller collects only by revealing the key on the ledger, and the buyer reads it there. No oracle, no platform, no download link to trust: the swap is one transaction. Measured 28 October: wrong finisher refused, right key paid, box opened, hashes matched.
