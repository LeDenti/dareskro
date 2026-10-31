# freelance — a client locks the fee at the order, the oracle releases on proof, the ledger refunds on silence

The freelance case of dareskro, taken from the hackathon demo (a hash read on a
laptop server) to a usable product: a mission model with two honest modes of
proof, a delivery verifier that survives real URLs, a desk for the client, a link
for the freelancer, and a measured run on testnet with a file published at a
public URL. Measured 31/10/2026; hashes in the main README, section
« Le freelance, en vrai », and in [`run/`](run/).

## What the ledger enforces

One escrow per milestone: `Amount` to the freelancer's address, a
`PREIMAGE-SHA-256` `Condition` whose secret the oracle holds, `CancelAfter` =
the deadline. Two outcomes, and only two: the oracle reveals the secret and the
freelancer is paid, or the deadline passes and the ledger refunds the client.
Nobody holds the money in between: not the client (no cancel before the date),
not the freelancer (no secret), not the oracle (it only submits transactions and
pays their fee), not us (the desk builds transactions; the client signs them).

## Two modes of proof, each honest about who decides

| mode | who decides | what the oracle does | dispute |
|---|---|---|---|
| **agreed hash** (`proof.mode = "hash"`) | a fact: the file at the agreed URL has the agreed SHA-256 | reads the URL by itself, every few seconds, streaming the body; reveals the secret on match | none possible on the fact. The client cannot refuse a conforming file; the freelancer cannot be paid for another one. Nothing matching before the deadline: refund |
| **client's signed acceptance** (`proof.mode = "acceptance"`) | the client, by signing on the ledger from the account that locked the money | verifies that signature on the ledger (`POST /accept`: a validated transaction from the escrow's owner with a memo `dareskro/accept` naming `owner#sequence`), then reveals | **no arbiter**, and we say so before signing. The client cannot take the money back before the deadline; the client's silence past the deadline is a refund. The freelancer keeps the on-chain proof of the lock and of the silence: a smaller dispute than "the invoice is unpaid", not a solved one |

The acceptance is a transaction, not a button of ours: an `AccountSet` that
changes nothing, signed by the client's key, with the escrow's reference in a
memo, visible on the explorer forever. The oracle's finish then carries the
acceptance's hash (`dareskro/accepted-by`), so the chain lock → acceptance →
release is public. Why the oracle still holds the secret in that mode: so the
client can accept from any device later, and so the registry has one shape.
A client who wants no oracle at all can hold the preimage itself and submit
`EscrowFinish` with the fulfillment; the desk does not do that today.

Milestones: a mission has one or several; each is its own escrow with its own
amount, deadline and mode (`mission.mjs`, twelve at most).

## The verifier, hardened (`verifier.mjs`)

The hackathon oracle did one `fetch()` and hashed in memory. Real deliveries
live on GitHub releases (302 to a signed blob URL), IPFS gateways (slow, 504s),
plain servers (403 during upload), and weigh hundreds of megabytes. The verifier:

- follows redirects by hand (5 hops at most), records every hop, masks signed
  query strings (`sig`, `jwt`, `X-Amz-Signature`) in the evidence;
- hashes the body as a **stream**: constant memory, a 2 GiB cap, an idle timeout
  (30 s without a byte) rather than a total timeout a big file would always hit;
- retries what deserves it (network errors, 5xx, 429 with `Retry-After`, a
  truncated body: 3 attempts, 2 s then 5 s) and not what is an answer (404/410
  = not published yet, 401/403 = not public, 200 with the wrong hash = wrong file);
- refuses private and loopback hosts unless `FREELANCE_ALLOW_PRIVATE=1` (the
  oracle must not become a scanner of its own network; DNS rebinding is not
  checked, said plainly);
- returns an **observation** (time, hops, status, bytes, hash, ETag,
  Last-Modified, elapsed, verdict) and appends it to a JSON-lines journal per
  delivery id (`evidence/<deliveryId>.jsonl`), where the oracle also writes its
  **decisions** (reveal, refund, acceptance received). Unchanged observations are
  one short line, so a 404 polled for a week does not drown the file.

`node verifier.test.mjs` runs 15 checks against a local server that misbehaves on
purpose (redirect chain, loop, 503 then 200, truncated body, stall, size cap,
private host). The oracle uses this verifier when the module is present
(`oracle/oracle.mjs`, `hardenedVerifier()`), its old one-shot fetch otherwise.

## The screens (`service.mjs`, `public/`)

`node service.mjs` serves the client's desk on `http://127.0.0.1:8781` and the
freelancer's link at `/m/<token>`. No build step, no framework.

**Client's desk.** Who pays (the client's address and balance), who holds the
secret (the oracle, with its on-chain birth certificate), what the verifier
does. A form: title, what is expected, the freelancer's address, amount in XRP
(with the euro or dollar equivalent at Kraken's rate, written in the memo),
deadline, mode of proof with its honest sentence, URL and hash (a file can be
hashed in the browser), optional milestones. Then per milestone: ask the oracle
for the condition → read the unsigned `EscrowCreate` → sign with the desk's key
**or paste a blob signed elsewhere** (the desk checks the blob carries the same
amount, destination, condition and date it prepared) → the escrow on the
explorer, what the ledger holds now, what the oracle sees, the evidence journal.
Acceptance mode: "Accept the delivery: sign on the ledger", or do nothing and
be refunded at the date. Hash mode: "Look at the URL now", recorded as evidence.

**Freelancer's link.** What to deliver, where, before when; "the money is
locked" only when the ledger says so (`ledger_entry`, re-read every 15 s), with
the amount, the destination (the freelancer's own address) and the refund date;
what to do (publish the exact file, or deliver and wait for the client's
signature, with the no-arbiter sentence); "Check my URL now"; a file hasher to
compare before publishing; what the oracle saw. The freelancer needs an XRPL
address. No account, no password.

**Keys.** The client's key lives in `freelance/.client.json` (0600, gitignored),
written by the client — never by us, never in a chat. On testnet the desk can
ask the faucet for one. Without a key the desk still works: it hands out the
unsigned transaction and takes back the signed blob (Ledger through the pay
desk's signing path, `xrpl.js`, any signer).

## Run it

```bash
cd oracle && npm install && node oracle.mjs create && node oracle.mjs watch      # 127.0.0.1:8787
cd freelance && npm install && node service.mjs                                 # 127.0.0.1:8781
# ORACLE_URL, XRPL_WSS (wss://testnet.xrpl-labs.com), PUBLIC_BASE_URL (for share links) are environment variables
node verifier.test.mjs && node mission.test.mjs                                 # 15 + 20 checks
PROOF_URL=https://…/landing-copy-v1.md PUBLISH_CMD='gh release upload <tag> run/landing-copy-v1.md' node demo_freelance.mjs
```

`demo_freelance.mjs` replays the three missions through the desk's API: hash
mode delivered, hash mode never delivered (refund), acceptance mode; with no
`PROOF_URL` it serves the file from 127.0.0.1 and the oracle must run with
`FREELANCE_ALLOW_PRIVATE=1`.

## Not done, said plainly

- The dollar leg (RLUSD through Mastercard AP4M, `ap4m/payout.mjs`) is not wired
  to this desk: the sandbox budget was down to 1/1000 at the hackathon's end. The
  payout script re-checks the `EscrowFinish` on the ledger before paying, so it
  plugs behind `status = paid` with no change to the escrow.
- No arbiter, no advances. Du(e)ly won the "Why Not" prize in New York with
  client escrow plus advances financed by a vault; advancing money is a lending
  business and out of this repository's scope.
- The share link is as public as the desk: on `127.0.0.1` it is a rehearsal;
  hosted, it needs HTTPS and the `PUBLIC_BASE_URL` of the host. The token gives
  read access to the mission, nothing else (no secret is in it).
