/**
 * Minimal .env loader: KEY=VALUE lines, no quotes, no expansion. The file holds
 * private keys, so it is 0600 and git-ignored; values never leave this process.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

export function loadEnv(file = path.join(HERE, ".env")) {
  if (!existsSync(file)) return;
  for (const raw of readFileSync(file, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const i = line.indexOf("=");
    if (i < 1) continue;
    const key = line.slice(0, i).trim();
    const value = line.slice(i + 1).trim();
    if (process.env[key] === undefined && value !== "") process.env[key] = value;
  }
}

export function need(key) {
  const v = process.env[key];
  if (!v) throw new Error(`missing ${key}: set it in ap4m/.env`);
  return v;
}

export const explorerTx = (hash) => `https://explorer.testnet.xrplevm.org/tx/${hash}`;
export const explorerAddress = (a) => `https://explorer.testnet.xrplevm.org/address/${a}`;
