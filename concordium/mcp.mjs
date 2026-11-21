// Minimal JSON-RPC client for the hosted Agent Registry MCP service.
// The service holds no key: every builder returns a payload that our own signer submits.
import { MCP_URL, RESEAU } from './config.mjs';

let n = 0;
export async function outil(nom, args = {}) {
  const corps = { jsonrpc: '2.0', id: ++n, method: 'tools/call',
                  params: { name: nom, arguments: { network: RESEAU, ...args } } };
  const r = await fetch(MCP_URL, { method: 'POST', body: JSON.stringify(corps),
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' } });
  if (!r.ok) throw new Error(`${nom}: HTTP ${r.status}`);
  const j = await r.json();
  if (j.error) throw new Error(`${nom}: ${j.error.message}`);
  const texte = j.result?.content?.[0]?.text ?? '';
  if (j.result?.isError) throw new Error(`${nom}: ${texte}`);
  try { return JSON.parse(texte); } catch { return texte; }
}
