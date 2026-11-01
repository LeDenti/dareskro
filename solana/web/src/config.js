/** devnet: the program measured in the README. The Aurora key is documented by Aurora as non-confidential (it goes in the URL of public websites). */
export const CLUSTER = "devnet";
export const RPC = "https://api.devnet.solana.com";
export const PROGRAM_ID = "6NoVNiHvEsagkYYobHjrwQgkqL5xHp5zGStZK4YtdPSu";
export const AURORA_API = "https://intents-api.aurora.dev";
export const AURORA_KEY = "936b1f17-6d65-46b6-885b-3ec66c13c8b6";
export const USDC_SOL = "nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near";
/** What the payer may pay with. SOL = the wallet funds the escrow directly on devnet; the others go through Aurora Intents (mainnet only). */
export const PAY_WITH = [
  { id: "sol", label: "SOL — this wallet, directly", asset: null, chain: "sol" },
  { id: "xrp", label: "XRP — from the XRP Ledger, via Aurora Intents", asset: "nep141:xrp.omft.near", chain: "xrp", refundHint: "r…" },
  { id: "near", label: "NEAR — from NEAR, via Aurora Intents", asset: "nep141:wrap.near", chain: "near", refundHint: "name.near" },
];
export const explorerTx = (sig) => `https://explorer.solana.com/tx/${sig}?cluster=${CLUSTER}`;
export const explorerAddr = (a) => `https://explorer.solana.com/address/${a}?cluster=${CLUSTER}`;
