# dareskro on Solana — an escrow program with no owner

**The employer pays with what they hold, on the chain they hold it on; the employee receives USDC locked on Solana that nobody can take back or redirect.** The bridge is not the product. The padlock on the pay line is.

**Encode Club Solana Hackathon 2026** (12 October → 8 November, online). Tracks: Aurora Intents, Best Consumer App.
**Final demo video (3 min 56, English, subtitled): [dareskro_la_linea_solana_final.mp4](https://github.com/LeDenti/dareskro/releases/download/v0.3-solana-final/dareskro_la_linea_solana_final.mp4)** — the drawn story (2 min), then the real screens of 1 November: Aurora on mainnet, the pay desk on devnet · release [v0.3-solana-final](https://github.com/LeDenti/dareskro/releases/tag/v0.3-solana-final) (mid-point: [v0.2-solana-midpoint](https://github.com/LeDenti/dareskro/releases/tag/v0.2-solana-midpoint)) · program on devnet [`6NoVNiHv…`](https://explorer.solana.com/address/6NoVNiHvEsagkYYobHjrwQgkqL5xHp5zGStZK4YtdPSu?cluster=devnet) · **a one-page app, no terminal** (`web/`: Phantom or burner key, lock, release, cancel, XRP/SOL/NEAR) · **the pay desk has a Solana tab** (`app/`, services in `desk/`, run measured 1 Nov) · **Aurora Intents run live on mainnet, 1 Nov 2026**: XRP → 3 USDC on Solana in 37 s ([XRPL](https://livenet.xrpl.org/transactions/56205926A4B9F65FBE7775F7607D4D568F94995BEF722731577B721C3C74A1E1) · [Solana](https://solscan.io/tx/58Az4DDmpE9MQBMfKjw6bU4SFNuPDkmF1mW1EF2qjaZV6K3W1VMDpXToJZjm7HoKw8bUm4MfyNjyKuQ4x9oguQ9g)).

> The agent reads the evidence. The code computes the amount. A human validates.
> A Solana program pays at the date, or when the proof is public. Nobody holds the
> funds in between — not the employer, not the oracle, not us.

## What existed before, what is built here

dareskro was built on the XRP Ledger at the XRPL hackathon in New York (24–25
October 2026, see the [root README](../README.md)): the evidence agent, the pay desk,
the oracle, the Ledger-device signing, six payer scenarios. XRPL has a **native
escrow** (`EscrowCreate`), so no contract was needed there.

Solana has no native escrow. **Everything in this folder is new for this
hackathon**: the Anchor program, its test suite, the client library, the devnet
demo, and the Aurora Intents funding path. The design goal is strict: port the
*guarantees* dareskro measured on XRPL, not just the feature list.

| Guarantee measured on XRPL | How the program gives it on Solana |
|---|---|
| The money goes to the `Destination` written at creation; `EscrowFinish` has no field for another address | `finish` takes no destination argument; the destination account must equal the one stored in the escrow (`WrongDestination` otherwise), whoever signs |
| Before `FinishAfter`, finish is refused by the ledger (`tecNO_PERMISSION`) | `Clock::unix_timestamp < finish_after` → `TooEarly`; the cluster's clock, not a server's |
| An escrow without `CancelAfter` cannot be cancelled, even by its owner | `cancel` on an escrow with `cancel_after = None` → `NotCancellable` |
| A `Condition` (PREIMAGE-SHA-256) is released only by its preimage, which becomes public in the transaction | `condition: Option<[u8; 32]>`; `finish` recomputes sha256 of the fulfillment on chain and **stores the revealed secret in the record** |
| Past `CancelAfter`, finish is refused and anyone may cancel; the refund can only go to the owner | `TooLate` / `CancelTooEarly`; the refund account must equal the stored owner |
| Batch (XLS-56): several escrows under one signature, all or nothing | A Solana transaction is atomic: two `create` instructions in one transaction either both land or neither does (tested) |
| Anyone can finish after the date — if the oracle dies, the employee can | `caller` is any signer; it pays the fee and nothing else |

Who holds the funds: a PDA of the program, one per escrow. Native SOL sits in the
escrow account itself; an SPL token (USDC, Token or Token-2022) sits in a vault
token account whose only authority is that PDA. The program has **no admin
instruction**. Once the upgrade authority is revoked
(`solana program set-upgrade-authority --final`), the only moves left are the
seven below.

## Instructions

| Instruction | Who | What |
|---|---|---|
| `create(id, destination, amount, finish_after?, cancel_after?, condition?, memos)` | the owner (payer) | locks `amount` lamports in a new escrow PDA `["escrow", owner, id]` |
| `create_token(...)` same arguments | the owner | same, for a mint: the tokens move to a vault PDA `["vault", escrow]` |
| `finish(fulfillment?)` | anyone | pays the destination if the clock and the condition allow |
| `finish_token(fulfillment?)` | anyone | same, to a token account owned by the destination; the vault is **emptied** (anyone can drop a stray unit in it, and a non-empty account cannot be closed — the stray unit goes with the pay), then closed, its rent back to the owner |
| `cancel()` | anyone | refunds the owner, only after `cancel_after` |
| `cancel_token()` | anyone | same, for a token escrow |
| `close()` | the owner | deletes a **Finished or Cancelled** record and takes the rent back; a Locked one cannot be deleted |

Shape checks at creation: amount > 0, `cancel_after > finish_after` when both are
set, at most 3 memos of 128 bytes (statement SHA-256, fiat line, oracle address —
what the employer read on the Ledger device on XRPL). Times are Unix seconds.

The record stays readable after the payment (status, who closed it, when, the
revealed secret), so the pay desk's registry is the chain itself:
`listEscrows({ owner })` is a `getProgramAccounts` with a memcmp on the owner.

Events `Created`, `Finished`, `Cancelled` are emitted for indexers.

## The four shapes, unchanged

| Shape | Fields | Who decides what |
|---|---|---|
| payroll | `finish_after` only | the oracle decides *when*, bounded below by the clock; nobody can cancel |
| delivery | `condition` + `cancel_after` | the oracle decides *whether*, by reading a public fact, and reveals the secret |
| presence | `condition` + `finish_after` + `cancel_after` | the oracle checks the post is still there *at the date* |
| affiliate | `condition` + `cancel_after` | the merchant's system confirms the sale; the oracle only guarantees the money was locked first |

## Build, test, run

```bash
cd solana
npm install
anchor build
anchor test --skip-build --validator legacy     # solana-test-validator; 11 tests, ~45 s
```

Toolchain used: Rust 1.99 / rustup toolchain 1.89 (Anchor's pin), Solana CLI 4.3.2
(Agave), Anchor 1.2.2, Node 26. On macOS 26 with the Command Line Tools' 27.0 SDK
the linker refuses `arm64e.x1-macos`; `~/.cargo/config.toml` pins
`SDKROOT = …/MacOSX26.5.sdk`.

### Measured on a local validator (31/10/2026)

```
dareskro escrow on Solana
  ✔ payroll shape: no finish before the date, no cancel ever, anyone finishes after (7744ms)
  ✔ condition: only the secret releases, and the secret becomes public (965ms)
  ✔ refund: before cancel_after nobody can cancel, after it anyone can, and finish is over (6776ms)
  ✔ shape: zero amount, cancel before finish, too many memos are refused at creation
  ✔ batch: several escrows in one transaction are all or nothing (952ms)
  ✔ close: the owner deletes a closed record and gets the rent back; a Locked one stays (1940ms)
  ✔ token: USDC-like mint locked in a vault, released to the destination's token account, vault closed (7745ms)
  ✔ token refund: cancel_after reached, the vault pays the owner back (7323ms)
8 passing (35s)
```

### Devnet — measured 31/10/2026, 08:33–08:35 UTC

Program [`6NoVNiHvEsagkYYobHjrwQgkqL5xHp5zGStZK4YtdPSu`](https://explorer.solana.com/address/6NoVNiHvEsagkYYobHjrwQgkqL5xHp5zGStZK4YtdPSu?cluster=devnet),
deployed with its IDL on chain (`anchor deploy --provider.cluster devnet`, 1.4 SOL of rent).
`client/demo_devnet.mjs` replays the XRPL table; every refused attempt is sent
**without preflight**, so the refusal is recorded on chain and visible on the
explorer, like a `tecNO_PERMISSION` on XRPL. Raw results: `client/compte_rendu.json`.

| Step | Signed by | Result |
|---|---|---|
| `create` 0.05 SOL, finish_after +90 s, memos = statement sha256 + "466.57 EUR" + oracle — escrow [`HbMBRDxK…`](https://explorer.solana.com/address/HbMBRDxKM4YRZYyutDc2P8VHa1SBByDdRpD9mqTjhpqr?cluster=devnet) — [28WMXA1o…](https://explorer.solana.com/tx/28WMXA1oscVodSug53vhjQpmXBqy5LayoMFgwT2ecDpoQgZtzQucqe3Up2oMEuSit7xnyZwAZ8DZCiimE5LF4DjS?cluster=devnet) | the employer | locked |
| `finish` by a passer-by **before** the date — [2ZZiTCoe…](https://explorer.solana.com/tx/2ZZiTCoeenbsDWiSwg781vJv8vejaYwWbCgRDsUJwFHfVj3wdABk5LLCi45q98bhexFCcZ2dY7nNzRYXsSuJu8vT?cluster=devnet) | a fresh account | **`TooEarly`**, recorded on chain |
| `cancel` by the employer — [3Bz8geRP…](https://explorer.solana.com/tx/3Bz8geRPhusMAxCW4XVuNcHaZP8fy6cJThWDD4BgLzvDo1TmvH4U7vjAW6yJjNdSAh64HqDGFRQrNdZviGwRogSw?cluster=devnet) | the employer | **`NotCancellable`** (no cancel_after: nobody can) |
| `finish` towards the passer-by's own account — [46QA1yhz…](https://explorer.solana.com/tx/46QA1yhzD9STnSfB3ySE8tUSMjnQnxUBGvkuf6HGvpoKo2ggvEDw7jYP2Du88aF71SMEP7d9pP1v7rBUskF6qavS?cluster=devnet) | the passer-by | **`WrongDestination`** |
| `finish` by the passer-by **after** the date — [5cbxdS3d…](https://explorer.solana.com/tx/5cbxdS3dyJ5yQ2nHcfsdvdcmA5ibJYhLiwbXd8onCWfVSzKNNGu9ntghgyLikrFrpMZtGxPuDYhgDyxQcsKbDWfR?cluster=devnet) | a fresh account | success, employee credited 0.05 SOL, `closed_by` = the passer-by |
| conditional `create` 0.02 SOL, sha256(secret), cancel_after +1 h — [544cTPxx…](https://explorer.solana.com/tx/544cTPxxafcRsubUTaPkdSMGNGCtS3s6HPfQUtz89Zxre7t12QBDthQmgpaqsXEDpq5aZ6xpCGRkqjbhTMopf49n?cluster=devnet) | the employer | locked |
| `finish` with a **wrong** secret — [4is1iBKP…](https://explorer.solana.com/tx/4is1iBKPTNLWNAFsTh3u9EukWqRXiKGfjjLeHzQpAipMFTiGDN3XGoAQEZ81nZ6m86s1U1Gjwhm8Q9bEfp7uAcgd?cluster=devnet) | the oracle | **`WrongFulfillment`** |
| `finish` with the **right** secret — [61y8jSQc…](https://explorer.solana.com/tx/61y8jSQc4ZGW2xnctzGD1UZae15vga1Jig4Q8Edza4EG8AX8tMYDbaJpghjdBaKaa28YMx2mRPM7mr3G9rFUkAFn?cluster=devnet) | the oracle | success; the secret is now stored in the record and readable by anyone |
| two `create` in one transaction, the second unaffordable | the employer | the transaction fails as a whole; the first escrow does not exist |

Same shape as the XRPL table of 24/10: the device signed `EscrowCancel` and the
ledger refused it; here the employer signs `cancel` and the program refuses it.

## The sealed statement — invisible to the public, readable by the administrations

The escrow is public: accounts, amount, the statement's SHA-256 in a memo. The
statement itself is sealed **next to it on chain**, in a `SealedStatement` record
at `["statement", escrow]`:

- public: the SHA-256 of the statement (the memo's), the ciphertext padded to a
  1 024-byte class, its hash, and the list of readers (role + X25519 key);
- private: every line of the payslip. The content key is AES-256-GCM, bound by
  AAD to the hash and the escrow; it is wrapped once per reader with X25519 +
  HKDF-SHA256 + AES-GCM — the primitives of `agent/confidentiel.mjs`, imported,
  not rewritten.

A Solana transaction is 1 232 bytes, so the ciphertext is written in chunks:
`seal_statement` announces the hash and length and the readers, `write_ciphertext`
appends in order, `finalize_statement` recomputes the SHA-256 on chain and only
then marks the record sealed. Afterwards nothing can change but the list of
readers: `add_reader` lets the employer wrap the same key for a pension fund that
got its key later, without re-encrypting anything.

The employee also receives a **Token-2022 token that cannot move** (NonTransferable
extension, metadata pointing at the record, mint authority revoked): a payslip in
their wallet that nobody can take, sell or fake, and that reveals nothing by itself.
The record stores the token's mint.

| Instruction | Who | What |
|---|---|---|
| `seal_statement(sha256_plain, sha256_cipher, cipher_len, iv, tag, uri, readers, token?)` | the escrow's owner | creates the record (≤ 8 192 bytes of ciphertext, or a `uri` for larger) |
| `write_ciphertext(offset, bytes)` | the owner | one chunk, in order, while not sealed |
| `finalize_statement()` | the owner | hash checked on chain → sealed |
| `add_reader(reader)` | the owner | one more wrapped key, up to 6 readers, no duplicate key |

Honest limits: no French administration publishes an encryption key today, so the
demo generates one per administration; the DSN remains the legal channel and this
record is the opposable, timestamped copy. Encrypted personal data on an
immutable ledger is a choice the payer makes knowingly: the `uri` path keeps the
ciphertext in erasable storage and anchors only its hash, with the same readers.

### Measured on devnet, 2026-10-31 09:33 UTC — `client/demo_scelle.mjs`, raw results in `client/compte_rendu_scelle.json`

Record [`EwRpdCAo…`](https://explorer.solana.com/address/EwRpdCAo9w1d99qJCh4MPMY2scg4TWaTwB7ttT3Ta1V5?cluster=devnet), statement = the real `agent/sortie/bulletin.json` of the New York run.

| Step | Signed by | Result on chain |
|---|---|---|
| payroll escrow, memo = `sha256:1eff5d758800…` — [iZ1rJ8eH…](https://explorer.solana.com/tx/iZ1rJ8eHKbSHCuHsbVBY5r3PAmKebqdBTBTEg6j5DPJBEyjjUUmuLB9KMMChWaa8Kf4i7K1tchbxF1wn5ugkHfC?cluster=devnet) | the employer | locked |
| Token-2022 mint, NonTransferable + MetadataPointer, 1 unit to the employee, mint authority revoked — [`BeURzSfU…`](https://explorer.solana.com/address/BeURzSfU7aw2CmubvUnAQWfaTE53ZH5vdVqpXQmTbsWs?cluster=devnet) | the employer | the employee holds it; metadata points at the record |
| `seal_statement` (5 readers: employee, URSSAF, retraite, DGFiP, employer) — [3mxKQDBK…](https://explorer.solana.com/tx/3mxKQDBKarsKWw7Eifkm2RVhisyx2ns2xE9Akd3icp8FtzrcmhYdb27m1K98SNqLfGAxGeBobXM591v7BqYyAE52?cluster=devnet) | the employer | record created, not sealed yet |
| `write_ciphertext` × 7 (5120 bytes for a 4845-byte statement) | the employer | chunks accepted in order |
| `finalize_statement` — [rJu7B5aL…](https://explorer.solana.com/tx/rJu7B5aLZGxPBDuvbABVF47dpeREnkdsRjUi59bk9tyKUciNQ3KiwjJ8M7ebBzXqecwnfsnak8kAYtPpiQQzh9e?cluster=devnet) | the employer | sha256 of the ciphertext checked **on chain**, `sealed = true` |
| employee, URSSAF, retraite, DGFiP each unwrap and decrypt | their own key | 4845 bytes, SHA-256 equal to the escrow memo |
| a fresh key tries | a stranger | `not a reader of this statement` |
| one byte of the ciphertext flipped | anyone | GCM refuses: `unable to authenticate data` |
| `add_reader` agirc-arrco, wrapped from the employer's copy — [4bTaguC8…](https://explorer.solana.com/tx/4bTaguC8hqNQupqXFZiZc4oGAPszRYxQiAbuZcRjZ3LYqBtXkMNhLwvWCvsPBsp6rdzcmXA7DDbmu3j6P5C2WG2s?cluster=devnet) | the employer | 6 readers; Agirc-Arrco opens 4845 bytes |
| the employee transfers the token to someone | the employee | **refused** by Token-2022: Token-2022 error 37, NonTransferable |


## Client

`client/dareskro_solana.mjs` — the same verbs as the XRPL rail, for the pay desk,
the oracle and the demos: `connect`, `createEscrow`, `createInstruction` (for
batches), `finishEscrow`, `cancelEscrow`, `closeEscrow`, `getEscrow`,
`listEscrows`, `conditionPair`, `chainNow`, `sendRecorded`. `client/scelle.mjs` seals and opens the statement, writes it in chunks and mints the employee's token; `node client/scelle.mjs selftest` runs the crypto offline. The signer is always
passed in; nothing here holds a key for anyone else.

## Aurora Intents: funding the escrow from any chain

The employer or the client rarely holds Solana USDC. Aurora Intents (NEAR Intents
underneath) gives them a deposit address on a chain they do hold assets on and
settles **USDC on Solana** to the recipient we name. The cross-chain leg is
Aurora's; the escrow's guarantees are the program's. The two never mix: Aurora
never touches a locked escrow, and the program never sees a foreign chain.

`client/aurora_intents.mjs` talks to `https://intents-api.aurora.dev` over plain
HTTPS (Aurora publishes no SDK for these two flows):

| Flow | Endpoint | Who may use it | What dareskro does with it |
|---|---|---|---|
| quote | `POST /api/quote/{apiKey}` with `swapType: EXACT_OUTPUT`, `destinationAsset` = Solana USDC (`nep141:sol-5ce3…omft.near`), `recipient` = the payer's Solana address; then `GET /api/status/{apiKey}?depositAddress=…` | any API key | the desk asks for exactly the escrow's amount; the payer sends the origin asset to the quote's deposit address; on `SUCCESS` the desk calls `create_token` |
| persistent address | `POST /api/persistent-deposit-address/{apiKey}` (`destinationChain: "sol"`) | organisations approved by Aurora; others get **403** | one address per payer, forever; the module returns `{ approved: false }` on 403 so the desk falls back to a quote — nothing is mocked |
| Intents Connect | `POST /api/v1/executions/{wallet}` with Solana `steps` (one instruction each, `{INTERMEDIARY}` as the only signer) | any key, header `x-api-key` | the deposit could call `create_token` itself from the payer's intermediary account — the "contract-level composability" bonus; not built yet |

Facts that shape the demo: Aurora runs on **mainnet only** (no testnet), the API
key goes in the URL path and is documented as not confidential, fees are set per
key in Aurora's Client Portal (60 % integrator / 40 % Aurora, floor 2 bps on
stables), and a quote carries an optional `appFees` line for the desk's margin.

**Measured on 1 November 2026, with the project's own API key (`dareskro`,
created in Aurora's Client Portal), `dry: true`, so no funds moved:**

| Call | Result |
|---|---|
| `GET /api/tokens` | 210 assets, 15 of them on Solana (SOL, USDC, USDT, USD1, xBTC, …) |
| quote: pay **1 USDC on Solana** with **SOL** | `amountIn` 0.013278573 SOL (1.27 $), delivered in ~19 s, deadline 15 min, withdraw fee 253 550 lamports |
| quote: pay **3 USDC on Solana** with **XRP** (the chain dareskro comes from) | `amountIn` 2.630367 XRP (3.29 $), delivered in ~22 s |
| quote: 1 USDC paid in XRP | **refused**: `Amount is too low for bridge, try at least 2245679` drops (≈ 2.25 XRP). Aurora enforces a bridge minimum per origin asset; the desk must surface it instead of retrying |
| quote with a malformed `refundTo` | **refused** `400 refundTo is not valid` before any deposit address is issued: a refund address is validated up front, which is what a payroll desk needs |

**Run for real on 1 November 2026, 07:44 UTC, mainnet, real funds** — the desk's
Solana address was paid in XRP from dareskro's own XRPL account, the chain the
product comes from. `client/aurora_paye_xrp.mjs` asked a real quote, signed the
XRPL Payment with the account's key (run by Julien, in his own terminal, with an
explicit `--go`), told Aurora the hash, and polled `/api/status` until settlement:

| Step | Where | Proof |
|---|---|---|
| Quote (`dry: false`), 3 USDC out, 15-min deadline | Aurora | `amountIn` 2.627332 XRP (3.28 $), deposit address `rMYEgFREZcNUt3viG3L7NkbefYta6Yb3NU`, no destination tag |
| XRP leaves the payer `rNY2Vc9hBPBcbZZVqzLgzxtTp7e9wVGknb` | XRPL mainnet, ledger 108 040 855 | [`56205926…`](https://livenet.xrpl.org/transactions/56205926A4B9F65FBE7775F7607D4D568F94995BEF722731577B721C3C74A1E1) `tesSUCCESS`, fee 12 drops |
| Aurora status | `PENDING_DEPOSIT` → `PROCESSING` → `SUCCESS` | 37 s after the quote (07:44:56 → 07:45:33), intent `C15Xn2BC…`, 0 refunded |
| USDC land on the desk's address `4ypF64RB…` | Solana mainnet, slot 464 012 735 | [`58Az4DDm…`](https://solscan.io/tx/58Az4DDmpE9MQBMfKjw6bU4SFNuPDkmF1mW1EF2qjaZV6K3W1VMDpXToJZjm7HoKw8bUm4MfyNjyKuQ4x9oguQ9g) — USDC balance 0 → **3.000000**, token account created by the settlement |

Honest numbers at this size: 3.28 $ paid for 3.00 $ delivered, because the
withdraw fee is fixed (0.254 USDC) and dwarfs the 10 bps app fee; at 466 € of
payroll the same fee is 0.05 %. The escrow itself stays on devnet for the
hackathon: deploying the program on mainnet would cost ~2 SOL of rent and prove
nothing more. What the live run proves is the thing Aurora's track asks for: a
real cross-chain funding flow, refund address validated up front, settlement
observed on both chains. The full record of the run (quote, hashes, status
ticks, balances) is written to `client/sortie/`, which stays out of git.

## The pay desk on Solana — same desk, another ledger

The pay desk of the XRPL product (`app/`, React) gained a tab, **Solana · same
desk**: the same statement, the same human validation, the same escrow with one
possible outcome, on Solana. Two local services do what the Ledger and the XRPL
oracle do on the other rail:

| Piece | File | Role |
|---|---|---|
| desk service, 127.0.0.1:8790 | `desk/desk_solana.mjs` | holds the **employer's** devnet key; `POST /lock` turns the validated statement into `create(finish_after)` with memos `sha256:<statement>` · `<fiat> @ <rate> USD/SOL <statement id>` · `dareskro/oracle:<address>`, then tells the oracle; `POST /attempt` sends a forbidden action without preflight so the refusal is recorded; `GET /escrows` reads the employer's escrows **from the chain** and merges the oracle's word; `/fund/*` is Aurora Intents (quote for the statement's USDC, status, the run of 1 Nov as `/fund/proof`) |
| oracle, 127.0.0.1:8791 | `desk/oracle_solana.mjs` | its own key, fees only; `/condition` issues a PREIMAGE-SHA-256 for a delivery escrow and keeps the secret (0600); `/watch` registers an escrow; every 5 s it reads the chain and calls `finish` when the cluster clock passes `finish_after` (payroll) or when the agreed file hashes right (delivery), `cancel` past `cancel_after` |
| the tab | `app/src/SolanaDesk.tsx`, `app/src/solana.ts` | six cards: rail · statement · funding from any chain · lock · proofs · registry |

Run it: `cd solana/desk && node oracle_solana.mjs create && node oracle_solana.mjs watch`
in one terminal, `node desk_solana.mjs` in another (employer key = `~/.config/solana/id.json`
or `SOLANA_KEYPAIR`), `cd app && npm run dev` for the desk, then the Solana tab.
The rate comes from Aurora's own token list (the same source as the funding leg).

**Run from the tab on 1 November 2026, 08:02–08:04 UTC, devnet, the full amount:**

| Step | What happened | Proof |
|---|---|---|
| Statement | `bulletin.json`, net to pay **440.36 USD**, sha256 `384ec59c…`, validated by Julien at 08:02:24Z | the sha256 is the first memo |
| Funding quote (dry) | 440.36 USDC on Solana for 355.539142 XRP (444.42 $), ≈ 24 s | Aurora quote, no deposit address issued |
| Lock | `create`, **4.612065354 SOL** at 95.48 USD/SOL, payable at 08:04:23Z, escrow [`Fu4yEH4Y…`](https://explorer.solana.com/address/Fu4yEH4Y1sycRQPLDPZxo3G5sKm92PgfmFyERnUPQS2V?cluster=devnet) | [`5Lqp5sAz…`](https://explorer.solana.com/tx/5Lqp5sAzbDQAY7r9jNcWUDS5fSRebURJCQWwCh6KEhbYEnXrNTFGJYqJNVKt1bEr6G58fQsFmx9cY4snGVsrtCtm?cluster=devnet) |
| Passer-by releases before the date | **refused `TooEarly`**, recorded | [`34QsK7is…`](https://explorer.solana.com/tx/34QsK7is7j8ajK4Xe8RGVc4VhG5TpuN3boxiaykLBiK2XmVMEhSJEHjHGnLneFiVZ4XwZ1VL9vwK4hxWhezibKSM?cluster=devnet) |
| Employer takes the money back | **refused `NotCancellable`**, recorded | [`2hZBEFmp…`](https://explorer.solana.com/tx/2hZBEFmpCqPQX25qPubsdNa8CvJ2m6fm3ujjBYJiZ5VLcsoH3WDnfBJMGP7Dv7PtjKHBCegrZ1WNszWFw3jMsL3M?cluster=devnet) |
| Passer-by releases to themselves | **refused `WrongDestination`**, recorded | [`2mcFfLPq…`](https://explorer.solana.com/tx/2mcFfLPqPxVYUE8Ckt9VTXwQFVtGCu98hHWoXjyvjdAFb1GwhPDHcQRTYNtJRAijDcDtk3V1RcuDKdMKDb4dAQfj?cluster=devnet) |
| The oracle, 7 s after the date | `finish` by `5k8j3SXM…`, 4.612065354 SOL to the employee `9SnQCNbh…` | [`QfWj923H…`](https://explorer.solana.com/tx/QfWj923Hp4RvPHzej5Gssnzm6935KGAPJjS6SToh5PqFXVhdfLv1ggHL9WQXDeb9diSfVZ1cxRSEdgph8Qrt434?cluster=devnet) |

The same sequence had run through the API alone a few minutes earlier (564.56 USD
gross, escrow `2v8A2JYT…`, finished by the oracle at 07:59:55Z); the devnet SOL
was returned to the employer's key afterwards to keep rehearsing.

What is honest about it: on Solana the employer signs with a key held by the
desk machine, not a hardware device (the Ledger path exists on XRPL only); the
escrow is in SOL on devnet because Aurora's USDC lands on mainnet, and the two
cannot meet without a mainnet deployment; the delivery kind is wired in both
services but was exercised in the program's tests, not from the tab.

## The page — no terminal

`web/` is a single page (Vite, `@solana/web3.js`, nothing else) for the judge or
the employer who will not open a terminal: connect **Phantom** or use a devnet
**burner key**, fill *recipient · amount in USD · pay date*, choose what the payer
pays with — **SOL** from the wallet, **XRP** or **NEAR** through an Aurora Intents
quote — and lock. The list below is read from the chain: **Release** (anyone, after
the date), **Cancel** (only if a cancel date was written, only after it), **Close**
(the payer deletes a finished record and gets the rent back). Before the date the
buttons are greyed out; a **demo mode** checkbox enables the forbidden actions and
sends them without preflight, so the program's refusal is recorded and linked
(the wallet then warns that the simulation fails, which is the point). `cd solana/web && npm install && npm run dev`.

**Run from the page on 1 November 2026, 09:48–09:52 Paris, devnet, burner key `BCkzP6Qn…`:**

| Click | Result | Proof |
|---|---|---|
| Quote, pay with NEAR, 10 USDC | Aurora answered (dry): the NEAR amount, delivered in ≈ 24 s | — |
| Quote, pay with XRP, 10 USDC | 8.282573 XRP (10.35 $), ≈ 22 s, withdraw fee 0.254 USDC | written in the escrow's second memo |
| Lock 10 USD → 0.1046 SOL, payable 09:50 | escrow `67BSAgWy…` | [`43fe85DH…`](https://explorer.solana.com/tx/43fe85DHLSe3j12haMyAy9ecK5xp4hukHobpTXkv8kjpjvFBgUUQEM9aQiEC1i7uteefKCxymVtrmc3ZpmG9RLrX?cluster=devnet) |
| Cancel (no cancel date) | **refused `NotCancellable`**, recorded | [`5SpfSJCS…`](https://explorer.solana.com/tx/5SpfSJCSvmFF29p9nUtZrxVScgsJnZ18GX6KnE53pCZ59wDZLaWwBbJi2WqbsseXEhCbbeE3FH4zQTrtbHTnvbkk?cluster=devnet) |
| Release, after the date | paid to the recipient | [`3feiFwWb…`](https://explorer.solana.com/tx/3feiFwWb1LBtGKNcwE9gQkN4ikgwwtHhxLotBCDJDv8iiQMS141QFbRkNe5Dn7NKaKSbLhrWf5mr5gtJ9FdiYw16?cluster=devnet) |
| Close | record deleted, rent back to the payer | [`c85AtMMV…`](https://explorer.solana.com/tx/c85AtMMVkH8kSc2JZkqgQ2XrbzFeTXZnhMhsfAtW6qEhksik1fjwixZtKPDq92zEtbsksVZHNtNWqGNjSKkLcug?cluster=devnet) |
| Lock 5 USD → 0.0523 SOL, payable 09:58 | escrow `FNe5fU…` | [`2AmDMo6T…`](https://explorer.solana.com/tx/2AmDMo6TJkRSZmiPxoE73pThBNSAodsGHJja9vGy9TyJb7oM4VpVK1UK6KZXmTndWzxYhWBBNiTft7PxfX7ZdxeG?cluster=devnet) |
| Release, before the date | **refused `TooEarly`**, recorded | [`3Lye6E6v…`](https://explorer.solana.com/tx/3Lye6E6vexBdn5Z3smDjcc4HRHvaRuWVeCUaRz6iNvTRE6E9hYEQPLh3U9t5BXgKQUPuWwWA93ovNXP5mYjqWv9x?cluster=devnet) |

## Honest limits

- The record costs ~0.005 SOL of rent until the owner closes it.
- `finish_token` needs a token account of the destination to exist (its ATA,
  usually); anyone may create it, the oracle does in the demo.
- Whatever lands in a vault beyond the escrow's amount is paid out with it: the
  alternative (paying exactly `amount`) would let one stray unit jam the escrow for
  good, since the Token program refuses to close a non-empty account (tested).
- A payroll escrow is **one possible outcome**: if the statement was wrong, the
  correction is a new escrow, as on XRPL. That is the point.
- Devnet only for the hackathon. On mainnet the upgrade authority would be
  revoked before the first real escrow.

## AI disclosure

Built with AI assistance (Claude), as Encode encourages. The guarantees table and
the tests were written first; the program had to pass them.
