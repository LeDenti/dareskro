// Every fixed value of the Concordium build, in one place. Read from the chain or the
// hosted registry service on 4 and 18 November 2026 (see the ENVIRONNEMENT sheet).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export const ICI = dirname(fileURLToPath(import.meta.url));

export const RESEAU = 'testnet';
export const GRPC = { hote: 'grpc.testnet.concordium.com', port: 20000 };
export const CHAINE = 'ccd:4221332d34e1694168c2a0c0b3fd0f27';       // CAIP-2 of testnet
export const EXPLORATEUR = 'https://testnet.ccdscan.io';
export const MCP_URL = 'https://agent-registry-mcp.concordium.com/mcp'; // hosted, holds no key
export const CIS8004 = { index: 12802n, subindex: 0n };                // agent registry (testnet)
export const CIS8 = { index: 12801n, subindex: 0n };                   // external key registry (testnet)

// The payroll test token, issued by Concordium on 4 Nov on our request (id prefixed by them).
export const JETON = { id: 'hh-EURD', decimales: 6 };

// Three testnet accounts, created on 4 Nov from one test identity ("Concordium testnet IP").
const comptes = JSON.parse(readFileSync(join(ICI, 'comptes-testnet.json'), 'utf8')).comptes;
export const COMPTES = {
  proprietaire: comptes.proprietaire.adresse, // the verified human: owns the agent NFT, signs registry acts
  agent: comptes.agent.adresse,               // the payroll agent: pays, sponsors fees, x402 facilitator
  salarie: comptes.salarie.adresse,           // the employee: receives the net pay
};

// The agent's existing key on another chain: the dareskro oracle on Solana devnet
// (program 6NoVNiHv…), the key that releases the payroll escrow there.
export const SOLANA = {
  namespace: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1', // CAIP-2 of Solana devnet
  cle_type: 'ed25519',
  schema: 'solana-ed25519',
  fichier_cle: join(ICI, '..', 'solana', 'desk', 'cles', 'oracle.devnet.json'), // local, git-ignored
};

// Where the agent card is served. Raw GitHub serves the exact bytes we hash.
export const DEPOT_BRUT = 'https://raw.githubusercontent.com/LeDenti/dareskro/main/concordium';
export const carteUrl = (v) => `${DEPOT_BRUT}/carte/agent-card.v${v}.json`;

// Key files exported from the Browser Wallet (Settings > Export private key), never committed.
export const cleDe = (role) => join(ICI, 'cles', `${role}.export`);
