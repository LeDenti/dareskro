/**
 * Range la clé privée du compte agent (MetaMask 0xC3027D…) dans ap4m/.env,
 * depuis le presse-papiers, sans jamais l'afficher. Usage : node cle-agent.mjs
 */
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { ethers } from "ethers";

const ATTENDU = "0xc3027de9e80f7aeb1234de70efbc79016fd11ac7";

let k = execSync("pbpaste").toString().trim();
// MetaMask copie la cle sans le 0x : on l'ajoute.
if (/^[0-9a-fA-F]{64}$/.test(k)) k = "0x" + k;
if (/^0x[0-9a-fA-F]{64}$/.test(k) === false) {
  console.log(`Le presse-papiers contient ${k.length} caracteres, pas une cle (64 caracteres hexadecimaux). Recopie-la dans MetaMask, puis relance.`);
  process.exit(1);
}
const a = new ethers.Wallet(k).address;
if (a.toLowerCase() !== ATTENDU) {
  console.log(`Cette cle correspond au compte ${a}, pas a 0xC3027D... Verifie le compte selectionne dans MetaMask.`);
  process.exit(1);
}
let s = readFileSync(".env", "utf8");
s = s.replace(/^AGENT_PRIVATE_KEY=.*$/m, "AGENT_PRIVATE_KEY=" + k);
writeFileSync(".env", s);
console.log(`Cle enregistree pour le compte ${a}. Tu peux vider le presse-papiers en copiant autre chose.`);
