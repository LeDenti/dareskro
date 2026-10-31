# `agent/depots/` — the sealed statements, addressed by content

One file per transmitted statement, named by the SHA-256 of its bytes: `<sealed-sha256>.json`.
Each is the output of `agent/confidentiel.mjs --chiffre` (AES-256-GCM, key wrapped for the named
readers of `agent/lecteurs.json`): an opaque ciphertext, hashes, key ids. Nothing readable without
one of the readers' private keys.

This folder is the **off-chain store** of the transmission to the pension fund
(`agent/demo_transmission_retraite.mjs`): the chain carries only the hashes and this folder's URL
(`dareskro/sealed-uri` memo), never the file. Served over HTTPS by GitHub
(`raw.githubusercontent.com/LeDenti/dareskro/<branch>/agent/depots/<sealed-sha256>.json`); the
same bytes have the IPFS CID written in `agent/sortie/transmission.json` (CIDv1, raw leaf, SHA-256),
so any pinning service the employer or the fund chooses gives them the same address.

A ciphertext of personal data is personal data (CNIL, EDPB): this store can be emptied when the
retention period ends — the ledger keeps a hash, which names nothing while the plaintext stays
unpublished. The demo statement is fictional.
