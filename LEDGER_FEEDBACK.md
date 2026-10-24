# Ledger developer experience — notes from building dareskro (24/10/2026)

Stack used: `@ledgerhq/device-management-kit` 1.11, `@ledgerhq/device-signer-kit-xrp`
0.2.0 (pre-release), transports web-hid / web-ble / speculos, xrpl.js 5.3, Vite 8,
Chrome on macOS. Goal: sign `EscrowCreate` (FinishAfter + Memos) and `EscrowCancel`
on the device. Written during the build on the Speculos emulator; the last section
reports the run on real hardware (Nano S Plus).

## What worked

- The five-step pattern of the workshop (`createDmk → connect → createSigner →
  getAddress → signTransaction`) is about 30 lines and maps 1:1 to what an app needs.
- `encode()` + DER signature + `TxnSignature` + `encode()` again: simple, and the
  same code path serves every transaction type, so moving from Payment to
  EscrowCreate/EscrowCancel needed no Ledger-specific change.
- Session state (`getDeviceSessionState`) gives the current app and version: useful
  to tell the user "open the XRP app" instead of failing silently.

## Where the docs lost us

1. **Derivation path format is inconsistent on the XRP signer page.**
   `signTransaction` shows `"m/44'/0'/0'/0/0"` while `getAddress` shows
   `"44'/144'/0'/0/0"`. The workshop README settles it (`44'/144'/0'/0/0`, no `m/`),
   but the reference page should.
2. **`signTransaction` output type.** The reference says the completed output is
   `{ r, s, v? }`. The kit (and the workshop) return a DER signature as a
   `Uint8Array`, which is what XRPL's `TxnSignature` wants. One of the two is wrong;
   the DER one is the useful one.
3. **`encode()` vs `encodeForSigning()`.** The XRP app adds the signing prefix
   itself, so the app must *not* use `encodeForSigning`. This is only in the
   workshop README. It belongs on the signer reference page, in bold: it is the
   first thing every xrpl.js user will get wrong.
4. **Supported transaction types are not listed on the signer page.** The device
   app README lists them (Escrow* included), the signer page does not say whether the
   signer passes any type through or only Payment. Teams building escrow, AMM or
   trustline flows need that sentence.
5. **Subscription example bug.** The reference's `observable.subscribe` sample
   destructures `requiredUserInteraction` and then logs `intermediateValue`, which is
   undefined at that point.
6. **`hexaStringToBuffer` returns `Uint8Array | null`.** Every example ends with `!`.
   A `hexaStringToBufferOrThrow` would remove a foot-gun.
7. **The ESM build does not load in plain Node.** `import … from "@ledgerhq/device-management-kit"`
   under Node 26 fails with `ERR_UNSUPPORTED_DIR_IMPORT` (`lib/esm/src` is a directory
   import, bundler-only). The CommonJS build works through `createRequire`. The README
   says "the same signer code works in Node.js"; it should say "through the CJS build,
   or with a bundler/tsx". With that, we signed `EscrowCreate` on Speculos from a
   terminal script in a few minutes (`app/scripts/demo-terminal.mjs`), including the
   four memos and the device shown "466.57 EUR @ 1.1474 EUR/XRP".
8. **Speculos needs Docker.** On a fresh Mac at a hackathon, Docker Desktop is a
   1 GB install plus an admin password. A prebuilt Speculos binary for arm64 macOS,
   or a hosted Speculos with a short-lived token, would let teams start without
   hardware in minutes.

## What the device shows — measured on Speculos, Nano X, XRP app 2.8.1 (24/10/2026)

Screens read through the Speculos events API while signing our transactions
(`agent/sortie/ecrans_nanox_escrowcreate.txt`, `…escrowcancel.txt`):

`EscrowCreate` (15 screens):
`Review transaction` → `Transaction Type: Create Escrow` → `Account` →
**`Finish After: 2026-10-24 15:25:10 UTC`** → `Amount: XRP 466.57` → `Fee: XRP 0.000012`
→ `Destination` → `Memo Type [1]: dareskro/statement-sha256` → `Memo Data [1] (1/2)`,
`(2/2)` → `Memo Fmt [1]: text/plain` → `Memo Type [2]`, `Memo Data [2]`, `Memo Fmt [2]`
→ `Sign transaction?` → `Transaction signed`.

`EscrowCancel` (7 screens): `Cancel Escrow` → `Account` → `Offer Sequence: 21789939`
→ `Fee` → `Owner` → `Sign transaction?`.

With the oracle cited (second run, `…escrowcreate_oracle.txt`), two more screens:
`Memo Type [3]: dareskro/oracle` → `Memo Data [3]: rUuvu1XPgd5GtTgrX / QKiwrHq3fb2xiHZMW`.
The employer reads on the device *who* will finish the escrow, before signing.
That is the clearest "human-in-the-loop" screen of the whole flow, and it costs
one memo.

What this means for Ledger:

- **`FinishAfter` is shown as a human-readable UTC date.** This is the field a
  payroll escrow lives on, and the device gets it right. Worth saying in the docs:
  nothing on the signer page or the device-app README promises it.
- **Memos are displayed in full**, hex-decoded, paginated (`(1/2)`, `(2/2)`) on the
  Nano X. A 64-character hash takes two screens: fine for a hackathon, long for a
  user. A `MemoFormat` hint that lets the app show "hash: 6313…f18c" would help.
- **No blind signing needed** for `EscrowCreate` with `FinishAfter` + 2 memos, nor
  for `EscrowCancel`. The workshop README's warning ("some newer transaction types
  need blind signing") could list which ones.
- Field order puts `Finish After` *before* `Amount` and `Destination`. For a
  reviewer, amount and destination first would read better; this is the
  device-app's ordering, not the kit's.
- Confirmed on real hardware below: Nano S Plus over USB/WebHID in Chrome, with
  shorter memos. Stax/Flex screens were only seen on the emulator.

## On real hardware — Nano S Plus, XRP app 2.2.2, Saturday 15:25 NY

The device connected over WebHID in Chrome at the first try, `getAddress` returned
the account, the testnet faucet funded it. **`signTransaction` was refused before any
review screen: `XrpAppCommandError Missing critical parameter (status 6800)`**, with
the four-memo `EscrowCreate` and again with a compact three-memo one. The same
transaction, same kit, signs on Speculos with app 2.8.1. So the pre-release signer
kit (0.2.0) and the XRP app 2.2.2 that ships on an older device do not talk to each
other, and the error text does not say "update the app". Two asks: the kit could
read the app version it already fetches (`getAppConfig`) and say *"XRP app 2.2.2 is
too old for this signer, update it in Ledger Live"*; and the README could state the
minimum app version. We updated the app and retried: **with XRP app 2.8.2 the same
page signed `EscrowCreate` (three memos) and `EscrowCancel` on the Nano S Plus at the
first try**, WebHID picker in Chrome, no blind-signing setting needed; escrow
5FF67E32…, cancel 71E227E5…, released by the oracle F61DBCD3…. So the only wall
between a fresh device and a working integration is an app update that nothing
in the kit announces.

## Suggestions

- An "XRPL transaction preview" metadata format (the Clear Signing idea beyond EVM):
  for `EscrowCreate` we would want "Lock 466.57 XRP for rEH9…, payable 25 Oct 2026
  11:05 UTC, statement hash 6313…". We have the plain-language summary in the web
  page; the device could show the same from a small JSON spec.
- A `prepareForDevice(tx)` helper in the XRP signer kit that does
  `SigningPubKey` upper-casing, `encode`, and returns the bytes — three lines that
  every app rewrites.
- A note in the kit README that the testnet faucet gives about 100 XRP per call: an
  escrow of a few hundred XRP needs several calls (`tecUNFUNDED` otherwise).
