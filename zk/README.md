# zk — the salary is invisible to the public, visible to the administration

A dareskro escrow is transparent by construction: the employer's account, the employee's
account and the XRP amount sit in the ledger for everyone, with the statement's SHA-256 in a
memo. The founder's requirement is the opposite for a salary: invisible to the public, visible
to the administrations (tax, social security). This folder is the zero-knowledge part of the
answer; the selective-disclosure part lives in `agent/confidentiel.mjs` and
`agent/divulgation.mjs` (layer B), the unlinkable payee is a derivation rule (layer A, below).

Everything here is real code, run and measured on 24/10/2026 on an arm64 Mac, Node 26.12.1,
pure npm, in WebAssembly. No binary was installed.

**Read this first, because it is the measured truth and not the headline.** The proof hides
hours, coefficient and seniority *from the proof*. It cannot hide them from the public, because
the amount is public on the escrow and the rules are public: anyone can enumerate the inputs
that give the total. For the shipped escrow, `verify.mjs` counts **11** (hours, coefficient,
seniority rate) triples compatible with 466.57 over every integer coefficient the circuit admits,
and the escrow's own `dareskro/statement-id` memo (`garde-2026-10-25-coef600`, written by the
pay desk) names the coefficient, which leaves **1** candidate: 12 h, coefficient 600, 15 %.
What the layer does guarantee: the amount is the agreement's formula for admissible inputs (the
public cannot say otherwise), the person is hidden (the commitment opens on nothing without the
nonce), the statement is sealed (layer B), and the administration opens proof and statement with
one key (`ouvrir.mjs`). Hiding the inputs needs hiding the amount: XLS-96 (no escrow in v1) or
several periods pooled into one payment. Both are said again under "Honest limits".

## What is proven

`circuit/src/main.nr` (`pay_compliance`, Noir) proves this statement to anyone holding the
verification key and the public inputs:

> The amount `total_cents` is exactly what the pharmacy collective agreement (IDCC 1996 art. 11;
> agreement of 23/03/2000 art. 4, the rules the agent bought) pays for **some** number of hours
> (1 to 96 quarter hours), **some** integer coefficient (100 to 2000) and **some** seniority
> (0 to 70 years), given the public context of the shift (Sunday or not, shutters open or not,
> hours already worked that week, point value), and the prover knows those three values plus
> the employee's badge and a nonce behind the published Pedersen commitment, which also binds
> the SHA-256 of the statement the escrow cites.

| public (anyone reads them) | private (never leave `zk/.witness/`, sealed for the administration) |
|---|---|
| `total_cents` = 46657 | `heures_q` hours worked, in quarter hours |
| `point_value_milli` = 5277 (5.277 EUR) | `coefficient` |
| `dimanche` = true | `anciennete_annees` |
| `volets_ouverts` = true | `badge_id` = sha256(badge) reduced to the field |
| `heures_semaine_avant` = 35 | `nonce`, 31 random bytes |
| `statement_hi`, `statement_lo` = the two 16-byte halves of the statement's SHA-256 (7cad8a6d…) | |
| `commitment` = pedersen_hash([badge_id, heures_q, coefficient, anciennete_annees, nonce, statement_hi, statement_lo]) | |

The commitment is the circuit's return value, so it is computed and constrained in-circuit;
`prove.mjs` never has to reimplement Pedersen. `std::hash::pedersen_hash` is still in the Noir
1.0.0-rc.6 standard library (Poseidon2 moved to an external library), which is why Pedersen.
The statement hash is a public input (range-checked to 128 bits per half) and enters the
commitment: the proof is for **this** statement, hence for the escrow whose memo cites it, and
editing `statement_sha256` in `public_inputs.json` makes the proof REJECTED (measured).
`prove.mjs` recomputes that hash from the statement with the same canonical form as
`agent/confidentiel.mjs` instead of trusting the `sha256` field.

### The arithmetic, reproduced exactly

The payroll engine (`officine.garde`, prior work, read-only, not copied here) computes in
Python `Decimal` and rounds **the sum of the exact lines** to the cent, ROUND_HALF_UP. Every
line is a rational number whose denominator divides 242 672 000 = 2^7 x 5^3 x 15167
(151.67 monthly hours = 15167/100), so the circuit works on `N = total x 242 672 000` as a
`u64` and reproduces the engine's rounding as `cents = floor((N + 1 213 360) / 2 426 720)`:

| line | engine | circuit term of N |
|---|---|---|
| shift pay | retained h x coefficient x point / 151.67 | 100 x retenu16 x coefficient x point_milli |
| overtime +25 % (35 h to 43 h of the week) | tranche x rate x 0.25 | 25 x t1 x coefficient x point_milli |
| overtime +50 % (beyond 43 h) | tranche x rate x 0.50 | 50 x t2 x coefficient x point_milli |
| Sunday allowance | hours x 1.5 point | 91002 x heures_q x point_milli |
| seniority | retained h x rate x 3 % per 3 years, cap 15 % | k x retenu16 x coefficient x point_milli |

Hours travel in sixteenths of an hour (`retenu16`) so that the shutters-closed case (25 % of
the time retained, full time) stays an integer. Overtime is placed in the week after
`heures_semaine_avant`, exactly like the engine's `majorations_hs`.

Two facts a verifier should know, both measured:

- **The engine's total is not the sum of the printed lines.** The statement shows
  250.51 + 83.50 + 94.99 + 37.58 = 466.58, but the engine rounds the exact sum once:
  466.5714 -> **466.57**. The circuit follows the engine. A statement edited to 466.58 is
  rejected at witness generation ("Cannot satisfy constraint", exit 1).
- **Replayed against the engine** (1 124 352 combinations by the implementers, 20 000 random
  cases by the verifier, two independent reimplementations): the circuit's integer formula and
  the engine agree on every case where the week held at most 43 h before the shift. Beyond
  43 h they differ: the engine's `majorations_hs` resets the +50 % tranche start to 43 h
  regardless of the hours already worked (44 h before a 12 h shift gives "13 h a +50 %"); the
  circuit applies the rule as written (12 h). The engine is prior work, read-only; until its
  owner decides, `prove.mjs` refuses `heures_semaine_avant` > 43 with a clear message rather
  than failing inside the circuit. The comparison scripts live in the session scratchpad, not
  in the repository: they import the engine, which is not public.

Bounds in the circuit (`heures_q` 1..96, `coefficient` 100..2000, `anciennete_annees` <= 70,
`point_value_milli` 1..100000, `heures_semaine_avant` <= 168) keep every product below 2^64;
Noir also fails the proof on any unsigned overflow.

## What the public can compute anyway (measured)

The circuit's formula is public, so is the total. `commun.mjs: candidates()` runs the same
integers as `main.nr` backwards: for each of the 96 hour values and 6 seniority rates it solves
the coefficient range that lands on `total_cents` (96 x 6 loop, 0.13 ms). On the shipped public
inputs (46657 cents, point 5.277, Sunday, shutters open, 35 h before):

- **11 triples** over all integer coefficients 100..2000: 5.25 h / 1662 / 15 %, 6 h / 1606 / 0 %,
  8 h / 1159 / 0 %, 8.25 h / 1061 / 6 %, 10.5 h / 750 / 9 %, 11.75 h / 672 / 3 %,
  **12 h / 600 / 15 %**, 12.5 h / 617 / 3 %, 13.75 h / 497 / 15 %, 18.75 h / 316 / 15 %,
  19.75 h / 316 / 3 %;
- the escrow's `dareskro/statement-id` memo says `coef600`: **1 triple** left, so hours and
  seniority are public for this escrow;
- on the agreement's grid of listed coefficients the count would be smaller still, but the rules
  the agent bought (`agent/sortie/regles_achetees.json`) carry no coefficient grid, so neither
  the circuit nor `verify.mjs` enforces one; "coefficient 100..2000" is what is proven.

`verify.mjs` and `prove.mjs` print these counts every run, so the right column of the verifier
("what stays hidden") is a measurement, not a claim. `divulgation.mjs --role public` prints a
`LEAK` line for each memo that names the coefficient, the date or a badge, and exits 1: on the
shipped escrow it does (two LEAK lines). The memo is written by the pay desk
(`app/src/xrpl.ts` from `bulletin.statement_id`, built in `agent/bulletin_garde.py`), not by
this layer; the fix is an opaque statement id (first hex digits of the statement hash, or a
random id kept inside the sealed statement). The compact 3-memo mode already omits it.

## What is not proven

- That the hidden hours are the hours really worked. The proof says "equals the formula for
  some admissible inputs". The link to reality is the statement, whose SHA-256 is on the escrow
  and inside the commitment, and which the administration opens with layer B.
- Lawfulness beyond the formula: any integer coefficient 100..2000 passes (5.25 h at coefficient
  1662 with 15 % seniority is a valid preimage of 46657 cents). Constraining the coefficient to
  the agreement's grid in-circuit is a few hundred gates once a grid is part of the purchased
  rules; it is not today.
- The amount. The XRP `Amount` is public on every escrow and the `dareskro/fiat` memo states the
  fiat total; that is what makes the enumeration above possible. XLS-0096 (Confidential
  Transfers for MPT, EC-ElGamal + Bulletproofs, with an issuer-registered auditor key that is
  "visible to the administration" natively) will hide the amount for MPT payments, but its first
  version excludes escrow ("can't be used in DEX, escrow, or checks") and the amendment is not
  active on mainnet or testnet. Pooling several periods or several employees into one payment
  is the other way to make the total uninformative.
- Part time with shutters closed (100 % retained for part-timers in the engine) is not modelled:
  the circuit assumes full time, like the statement. `heures_semaine_avant` is in whole hours.
- Ties in the rounding: the circuit rounds exactly; the engine rounds a 28-digit Decimal. They
  could differ only if the exact sum lands on a half cent to 24 digits. None in 1.1 M cases.

## Toolchain (pure npm, wasm, pinned)

| package | version | role |
|---|---|---|
| `@noir-lang/noir_wasm` | 1.0.0-rc.6 | compiles `circuit/` in Node (no nargo) |
| `@noir-lang/noir_js` | 1.0.0-rc.6 | executes the circuit -> witness |
| `@aztec/bb.js` | 5.2.1 | UltraHonk prove / verify, `BackendType.Wasm` |

Noir's own integration tests pin bb.js 5.0.0 for rc.6; 5.2.1 (latest on npm, 07/10/2026) was
tried first on a trivial circuit and on a Pedersen probe, proved and verified, and kept.
`bb.js` 5.x bundles native `bb` binaries for four platforms (131 MB of the 199 MB
`node_modules`) and picks them first when present; the scripts force `BackendType.Wasm` so
the whole chain is the wasm one the spec asks for. On first use bb.js downloads the BN254
structured reference string (52 MB) into `~/.bb-crs`; later runs are offline. Single-threaded
wasm by default (`--threads N` for worker threads).

## Run it

```bash
cd zk && npm install
node prove.mjs                 # reads agent/sortie/bulletin.json + agent/preuves/planning_2026-10-25.txt
node verify.mjs --escrow D12FACCC9C466B2B809F49D222923C45B4B0DC0DF3F031E40B7053685F631BC0
node verify.mjs --recompile    # proves the vk is the one of circuit/src/main.nr
cd .. && node agent/confidentiel.mjs --chiffre --escrow D12FACCC9C466B2B809F49D222923C45B4B0DC0DF3F031E40B7053685F631BC0
node zk/ouvrir.mjs --role administration   # the administration re-opens the commitment from the sealed file
```

Order matters: `prove.mjs` draws a fresh nonce each run, so the commitment changes; run it
**before** `confidentiel.mjs --chiffre`, which seals the opening of that very commitment and
refuses a witness made for another statement.

`prove.mjs` derives the inputs from the statement (same code as `ouvrir.mjs`, in
`commun.mjs: inputsFromStatement`), refuses if the schedule disagrees with it on coefficient,
seniority, hours before, shift type or badge (without printing the values), refuses more than
43 h already worked (engine divergence), compiles, executes, proves, verifies once, then writes:

- `sortie/public_inputs.json` — the public values in ABI order (`statement_hi/lo` are derived
  from `statement_sha256` at verification time, so the file carries the hash once);
- `sortie/proof.json` — the UltraHonk proof, hex (14 656 bytes);
- `sortie/vk.json` — the verification key, hex (3 680 bytes), its SHA-256, the circuit
  source's SHA-256, the pinned versions;
- `.witness/witness.json` (0600, directory 0700, gitignored) — the private inputs, the nonce,
  the commitment and the gzipped witness. Nothing under `sortie/` names hours, badge or nonce
  (grep-checked after every run).

`verify.mjs` needs only `sortie/`: it checks `vk.json` and `proof.json` against their own
digests and lengths (a tampered vk is a `vk REJECTED` line, exit 1, not a wasm stack trace),
rebuilds the public field list from the JSON values (so editing any of them, the statement hash
included, changes what is verified), verifies, and with `--escrow` fetches the EscrowCreate on
testnet (`tx`, s.altnet.rippletest.net:51234, 20 s timeout, network errors exit 1 with a
message) and binds the proof **by hash** (the `dareskro/statement-sha256` or `dareskro/sha256`
memo must equal the proof's public statement hash) and **by amount** (`Amount` in drops x the
rate of the `dareskro/fiat` memo within 0.01 of the proven total, and the memo's total equal to
it). A `dareskro/zk-commitment` memo, when a pay desk writes one, is compared as a field value.
Then the two columns, the enumeration count and the memo leaks. Exit 0 ok, 1 any failure, 2 usage.

`ouvrir.mjs --role administration|employee` is layer B meeting layer C: it unwraps the content
key with that role's X25519 key, decrypts the statement and the zk opening sealed next to it,
re-derives the circuit inputs from the statement, re-executes the circuit with the sealed nonce
and compares the returned commitment with the sealed file, the opening and
`sortie/public_inputs.json`. It prints MATCH / MISMATCH lines only.

## Measured, 24/10/2026 (Mac arm64, 10 cores, Node 26.12.1, 1 wasm thread)

| step | time |
|---|---|
| compile (noir_wasm) | 417-437 ms |
| witness (noir_js) | 32-33 ms |
| prove (UltraHonk, bb.js wasm) | 906-931 ms |
| verification key | 264-272 ms |
| verify | 11-16 ms |
| `node prove.mjs` wall clock | 2.0 s |
| `node verify.mjs` wall clock, offline | 0.3 s |
| `node verify.mjs --escrow` wall clock | 0.3 s + testnet (0.4 to 1.4 s tonight) |
| `node verify.mjs --recompile` (recompile 737-761 ms) | 1.0 s |
| `node zk/ouvrir.mjs` (decrypt 2 ms, compile + witness 430 ms) | 0.7 s |
| `confidentiel.mjs --chiffre --escrow` (sealing 2 ms, the rest is testnet) | 1.4 s |

With 4 wasm threads the previous circuit (6 public fields) proved in 374 ms; not re-measured
after the change.

| artefact | size |
|---|---|
| circuit | 12 ABI inputs, 8 public fields, bytecode 4 080 chars base64, `main.nr` 4.8 kB |
| proof | 14 656 bytes (458 field elements), `proof.json` 29.5 kB as hex |
| verification key | 3 680 bytes, `vk.json` 7.7 kB |
| public inputs | `public_inputs.json` 729 bytes |
| private witness | 864 bytes gzipped, in `.witness/` only (1.7 kB file) |
| sealed statement | `bulletin.chiffre.json` 5 837 bytes: ciphertext 3 072 (statement 2 987 padded to 1 kB), zk opening 400, two wrapped keys |
| `zk/node_modules` | 199 MB (131 MB are bb's native binaries, unused) |

Checks run end to end on the real statement (total 466.57, escrow sequence 21789944 of
rGJsjkfmASA2ezXYDpTQJZDp9tRgCJAPhw), after the fixes of this evening:

- proof VERIFIED; statement memo 7cad8a6d… MATCHES the proof's public hash; 361.141858 XRP
  x 1.29193 = 466.5700 USD vs 466.57 -> MATCH, fiat memo total MATCHES; `--recompile`: vk
  MATCHES the circuit source (source sha256 42870b61…); exit 0;
- the other EscrowCreate of the demo (F4029046…, another statement, no fiat memo): statement
  memo 6313d0e0… DIFFERS, no fiat memo, RESULT: FAIL, exit 1 (the same-amount problem is closed
  by the hash binding); an EscrowFinish hash: exit 1; `--escrow` without a value or not 64 hex: exit 2;
- tamper `total_cents` 46657 -> 46658: proof REJECTED, exit 1 (and the enumeration shows 2
  triples for 466.58); tamper `statement_sha256`: proof REJECTED, exit 1;
- tamper one hex digit of the proof: `proof REJECTED (malformed proof or vk: Deserialized point
  is not on the curve)`, exit 1; one hex digit of the vk: `vk REJECTED`, exit 1, no stack trace;
- testnet unreachable (fetch stubbed): `testnet unreachable (ENOTFOUND): the binding to the
  escrow was not checked`, exit 1; HTTP 503: `HTTP 503`, exit 1;
- `ouvrir.mjs`: administration and employee both get AGREES + three MATCHES, exit 0; one
  character of the sealed opening changed, or its clear commitment edited (AAD): GCM refuses,
  exit 1, while the statement itself still decrypts;
- `confidentiel.mjs --chiffre` with a witness made for another statement: refuses, exit 1,
  sealed file untouched; without any witness: seals the statement, "zk opening none";
- `divulgation.mjs --role public --escrow D12FACCC…`: two LEAK lines (coefficient 600, date
  2026-10-25 from the statement-id memo), random-key unwrap refused, RESULT: FAIL, exit 1;
  `--offline`: RESULT: OK, exit 0 (nothing on-chain was read).

## How the administration opens everything

Layer B (`agent/divulgation.mjs --role administration`) decrypts the statement with the
administration's X25519 key and checks its SHA-256 against the escrow memo: the administration
reads the employee, the hours, the coefficient, the seniority and the lines. The same sealed
file carries the **zk opening** (the five private inputs, nonce included, encrypted under the
same content key, bound by AAD to the statement hash and the public commitment), so one key
opens proof and statement: `node zk/ouvrir.mjs --role administration` re-derives the inputs from
the statement, re-executes the circuit with the sealed nonce and gets the published commitment
back (measured: MATCHES the sealed file, the opening and `public_inputs.json`). The public
cannot do this: without the nonce the commitment opens on nothing, and the badge alone is not
enough to brute-force it. `--offline` reads the statement without testnet when the network is down.

## Unlinkable payee (layer A)

Paying every period to the same account links all salaries of one person forever. The pay desk
already creates a fresh funded account per demo; for a real employee, derive the account for
period `n` from the employee's own Ledger device with the XRPL path `44'/144'/n'/0/0` (one
account index per pay period; `agent/compte_periode.mjs --periode 2026-10` prints
`44'/144'/321'/0/0`). The employee holds every key; the employer only learns the public address
for the period. The administration receives, with the statement, the period index and the
derivation path, and can check that the destination of the escrow is that account.

Weaker than "the public sees unrelated accounts", and said plainly: an EscrowCreate to an
account that does not exist fails (`tecNO_DST`), so the fresh account must be funded before the
escrow, by a party unrelated to the employee (a faucet on testnet), otherwise the funding
Payment links the periods on-chain; the base reserve is locked per period; and the employer's
account, the amount and the FinishAfter cadence remain common to all the escrows of one employer.

## Honest limits and open points

1. **The binding to the escrow is by hash and by amount.** By hash: the statement SHA-256 is a
   public input of the proof and a memo of the escrow; two escrows of the same amount no longer
   both "match" (measured with F4029046…). By amount: the rate in `|drops x rate - total| <= 0.01`
   is read from the payer's own `dareskro/fiat` memo, so this part only shows that the memo and
   the proof agree on the total, not that the XRP locked is worth it; an independent price
   source (the oracle's registry entry carries `amountXrp` and `amount`) would make it honest.
   A `dareskro/zk-commitment` memo at creation time (pay desk, other workflow) is checked when present.
2. **The vk must be trusted or recomputed.** A proof only means what the circuit says; a reader
   who did not compile the circuit should run `node verify.mjs --recompile` (about 750 ms) or
   compare `vk_sha256` and `circuit_sha256` in `vk.json` against their own build.
3. **Overtime beyond 43 h already worked**: engine and circuit disagree (above). `prove.mjs`
   refuses those statements; the engine's owner decides whether to align `majorations_hs`.
4. **Fresh nonce at every `prove.mjs` run**: the commitment changes each run; run `prove.mjs`
   then `--chiffre`, once per escrow. `--chiffre` refuses a witness made for another statement.
5. **The amount is the leak.** 11 input triples fit the public total; the statement-id memo of
   the shipped escrow reduces them to 1. The proof is not what leaks, the escrow is. Fixes, in
   order of cost: an opaque statement id in the pay desk (one line, other workflow), pooled
   payments, XLS-96 when it reaches escrow.
6. The point value is public (it is in the collective agreement). The `heures_semaine_avant`
   value (35) is public too and says the shift was overtime; hiding it would need a range
   proof on a private value instead, a small change if wanted.
7. **Recipients are a committed file.** `agent/sortie/cles_publiques.json` lists who can read
   every statement sealed afterwards; `--chiffre` refuses names outside employee/administration,
   but nothing authenticates the administration's key. In production that key is pinned (its
   fingerprint in the pay desk) or signed. Demo keys, gitignored, 0600.
8. The sealed statement is padded with spaces to a 1 kB multiple, so the public learns a size
   class (3 072 bytes), not the statement's exact length; GCM tag length is pinned to 16 bytes.
9. `node_modules` is 199 MB for a 5 kB circuit; 131 MB are native binaries the scripts never
   call. A production build would use the browser bundle of bb.js (wasm only).
