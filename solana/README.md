# dareskro on Solana — an escrow program with no owner

**Encode Club Solana Hackathon 2026** (12 October → 8 November, online). Tracks: Aurora Intents, Best Consumer App.
Demo video (2 min, English, explanations at the bottom of the frame): [dareskro_la_linea_solana.mp4](https://github.com/LeDenti/dareskro/releases/download/v0.2-solana-midpoint/dareskro_la_linea_solana.mp4) · release [v0.2-solana-midpoint](https://github.com/LeDenti/dareskro/releases/tag/v0.2-solana-midpoint) · program on devnet [`6NoVNiHv…`](https://explorer.solana.com/address/6NoVNiHvEsagkYYobHjrwQgkqL5xHp5zGStZK4YtdPSu?cluster=devnet).

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

_Status: module written, not yet run — it needs an API key from
`studio.aurora.dev` and a decision on where the escrow lives for the live demo
(devnet program + mainnet funding leg, or a mainnet deployment for a few dollars
of real USDC)._

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
