# The film — La Linea, one scenario per chain

Two minutes, one white line on flat colours, a pharmacist who grumbles in
Italian charabia and a pencil that draws the story ahead of him. The storyboard
is [scenario_la_linea.md](scenario_la_linea.md) (French). The film does not
explain; it shows *what*, and the README and the transactions show *how*.

The whole film is **one file**, `film.html`: a canvas and a function
`render(t)`. Only three things in it depend on the chain the money sits on:

| what | XRPL | NEAR |
|---|---|---|
| the screen he reads on the device before pressing | `XRP 466.57 · after 2026-10-31 · to r3kiDtPb…` | the amount, date and payee of the real testnet run |
| the verification caption while the coins run | the oracle's `EscrowFinish` on testnet.xrpl.org | the oracle's `finish()` on testnet.nearblocks.io |
| the end card | XRP Ledger testnet · Ledger Nano X · NYC hackathon | NEAR testnet · a contract with no keys · NEAR Hackathon |

Those live in `scenarios/<name>.json` and are injected as `window.FILM`
before the page runs. Everything else — the drawing, the timing, the voices,
the padlock on the line — is the same film.

## Make it

```bash
npm install                      # playwright, which drives the Google Chrome already installed
node make.mjs stills --scenario near 78 100 112   # three frames to look at, 10 s
node make.mjs all --scenario near                 # stills, sheet, audio, 3 600 frames, mp4 (≈ 2 min on an M-series Mac)
```

Steps can be run one by one (`stills`, `frames`, `audio`, `mux`, `sheet`); see
the header of `make.mjs`. For NEAR, `node make.mjs fill --scenario near` copies
the amount, date, payee and finish transaction from `near/compte_rendu.json`
into the scenario, so the film quotes the real run.

Needs `ffmpeg`, Google Chrome, and on macOS the `say` voices *Alice* and
*Grandpa (Italien (Italie))*. Outputs (`build/`, `*.mp4`) are not committed;
the finished films are attached to the GitHub releases.
