# Reproducing the `6985 "Rejected by user"` of the Ledger stand (25/10/2026)

Needs the Speculos emulator from the Ledger workshop running the XRP app
(`ledger-workshop/device-management-kit-ts-workshop/xrpl-hackathon/speculos/run-speculos.sh nanosp`,
API on 127.0.0.1:5000) and the `xrpl` package (`ln -s ../../oracle/node_modules node_modules`).

The scripts send the exact APDUs the XRP signer kit sends (`E0 04`, P1 `00/80/81/01`,
P2 `40`, path `44'/144'/0'/0/0`) and read the screen through `/events?currentscreenonly=true`.

```
node repro.mjs all     # EscrowCreate 3 memos → 9000 · 4 memos → 9000 · Batch → 6985, no review screen
node scenario.mjs D    # Batch refused, alert not acknowledged, EscrowCreate sent at once → 9000 (also E, F)
node reject.mjs        # one press past "Sign transaction?" lands on "Reject transaction"; both → 6985
```

See LEDGER_FEEDBACK.md, "The 6985 of the Ledger stand".
