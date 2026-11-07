# dareskro_casper — the Odra contract

`src/escrow.rs` is the whole contract; `../README.md` explains it and lists the testnet measurements.

```
cargo odra test              # 14 tests on OdraVM
cargo odra test -b casper    # the same on CasperVM (builds wasm/DareskroEscrow.wasm)
cargo odra build             # wasm/DareskroEscrow.wasm, copied to ../wasm/ for the deploy
```

Toolchain: the nightly pinned in `rust-toolchain.toml`, `cargo-odra` 0.2.0, `wasm-opt` (binaryen ≥ 121) and
`wasm-strip` (wabt); on this Mac they live in `~/.cargo/bin` and `/opt/homebrew/bin`.
